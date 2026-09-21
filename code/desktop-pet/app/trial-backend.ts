import { normalizeApiKey, MAX_API_KEY_FILE_BYTES } from '../core/api-key.js';
import { EmotionTurns } from '../core/emotion-state.js';
import { homedir } from 'node:os';
import { SqliteMemoryImportManagement } from '../memory/import-management.js';
import { HistoricalMemoryTransport, historicalMemoryInputBytes, memoryImportConfiguration, observedImportEndpoint } from './memory-import.js';
import { WakeManager } from './wake-manager.js';
import { wechatTranscriber } from '../wechat/asr.js';
import { wechatAudioFileSender } from '../wechat/output.js';
import { WeChatService } from '../wechat/service.js';
import { WeChatApi } from '../wechat/api.js';
import { WeChatStore } from '../wechat/store.js';
import { WeChatTextConversation } from '../wechat/conversation.js';
import { WorkPlanner } from '../providers/work-plan.js';
import { DesktopWork } from '../harness/desktop-work.js';
import { WorkIntentClassifier } from '../providers/work-intent.js';
import { QwenAsrProvider } from '../providers/qwen-asr.js';
import { QwenVisualEmotionProvider, VISUAL_EMOTION_PROMPT } from '../providers/qwen-visual-emotion.js';
import { SplitPerceptionProvider } from '../providers/split-perception.js';
import { StrictManagementForget, withStrictManagementForget } from './management-forget.js';
import { assertCompanionDataConfiguration } from './companion-data.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {pendingMemoryManagement} from '../management/pending-memory.js';
import { fileURLToPath } from 'node:url';
import type { MemoryTurnInput, MemoryTurnPlan, MemoryTurnProvider, MemoryTurnOutcome } from '../contracts/memory-lifecycle.js';
import type { TurnScope, TtsProvider, MediaStorePort } from '../contracts/index.js';
import type { ProviderSelection } from '../contracts/management.js';
import { confirmedInvitationPolicy } from '../companion/invitations.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../memory/sqlite-lifecycle-port.js';
import { SqliteManagementMemoryPort } from '../memory/management-port.js';
import { ManagementSettingsStore } from '../management/settings-store.js';
import { effectiveTrialConfiguration } from '../management/settings.js';
import { ManagementRuntime } from '../management/runtime.js';
import { PresentationSettingsStore, readPresentationCatalog } from '../management/presentation.js';
import { startRuntimeManagement } from '../management/bootstrap.js';
import type { MemoryRecord } from '../memory/ledger.js';
import { abortable } from '../media/scope.js';
import { MemoryMediaStore } from '../media/store.js';
import { JsonDialogueProvider } from '../providers/qwen-dialogue.js';
import { JsonSummaryProvider } from '../providers/qwen-memory-lifecycle.js';
import { QwenPerceptionProvider } from '../providers/qwen-perception.js';
import { QwenTtsProvider, billedCharacters } from '../providers/qwen-tts.js';
import { QwenAudioTtsProvider, isQwenAudioTtsModel } from '../providers/qwen-audio-tts.js';
import { MiniMaxTtsProvider, MINIMAX_TTS_MODEL, MINIMAX_TTS_ENDPOINT } from '../providers/minimax-tts.js';
import { RegisteredVoiceStore } from '../providers/registered-voices.js';
import { ProviderTransport, type EndpointConfig, type JsonRecord, type ProviderOperation } from '../providers/transport.js';
import { BackendSession, type BackendPorts } from './backend-session.js';
import { TrialAuthorizer } from './trial-authorizer.js';
import { readActiveTrialConfiguration, type TrialConfiguration, type TrialOperation } from './trial-config.js';
import { verifyTrialRuntime } from './trial-launcher.js';
import { contextInputUpperBound, summaryInputUpperBound } from './input-budgets.js';
import { inspectPcmWav } from '../media/wav.js';
import { prototypeSnapshot } from './memory-planning-prototype.js';
import { runMemorySemanticAttempt, type SemanticAttemptEvent } from './memory-semantic-adapter.js';
import { buildMemorySemanticFormat } from './memory-semantic-format.js';
import { TrialAdmission } from './trial-admission.js';

/** Keep production trial calls within the reviewed text bounds without truncating user content or replies. */
export class TrialTransport extends ProviderTransport {
  constructor(private readonly configuration: TrialConfiguration, private readonly providerFetch: typeof fetch = fetch,
    private readonly runtime?: ManagementRuntime, private readonly dialogueTemperature?: number) { super(providerFetch); }
  override async request(config: EndpointConfig, scope: TurnScope, operation: ProviderOperation, body: JsonRecord,
    signal: AbortSignal, textCharacters?: number, audioSeconds?: number): Promise<JsonRecord> {
    const model = this.configuration.models[operation as TrialOperation];
    if (!model || operation === 'memory_maintenance') throw new Error('Unregistered trial operation');
    if (operation !== 'tts' && operation !== 'perception' && operation !== 'asr') {
      const upper = Buffer.byteLength(JSON.stringify(body.messages), 'utf8') + 2048;
      if (upper > model.inputTokenLimit) throw new Error('Trial request exceeds its reviewed input bound');
    }
    if (operation === 'perception' && this.configuration.models.asr) {
      const messages = body.messages as {role?:string;content?:Record<string,unknown>[]}[] | undefined;
      const content=messages?.[0]?.content;
      if(messages?.length!==1 || messages[0]?.role!=='user' || !Array.isArray(content) || content.length<2 || content.length>4
        || JSON.stringify(content.at(-1))!==JSON.stringify({type:'text',text:VISUAL_EMOTION_PROMPT})
        || content.slice(0,-1).some(part=>part.type!=='image_url' || Object.keys(part).some(k=>!['type','image_url'].includes(k))
          || !/^data:image\/(jpeg|png);base64,/.test(String((part.image_url as {url?:string})?.url)))
        || JSON.stringify(body.modalities)!=='["text"]' || body.stream!==true
        || Object.keys(body).some(k=>!['messages','stream','stream_options','modalities'].includes(k)))
        throw new Error('Visual request must contain only current images and the fixed visual prompt');
    }
    if (operation === 'asr') {
      const messages=body.messages as {role?:string;content?:{type?:string;input_audio?:{data?:string}}[]}[]|undefined;
      const content=messages?.[0]?.content,data=content?.[0]?.input_audio?.data;
      if (messages?.length!==1 || messages[0]?.role!=='user' || content?.length!==1 || content[0]?.type!=='input_audio' || typeof data!=='string' || !data.startsWith('data:audio/wav;base64,')) throw new Error('ASR audio request is invalid');
      const bytes=Buffer.from(data.slice('data:audio/wav;base64,'.length),'base64');
      try { const actualSeconds=inspectPcmWav(bytes).durationMs/1000; if(typeof audioSeconds!=='number'||!Number.isFinite(audioSeconds)||Math.abs(actualSeconds-audioSeconds)>0.000001)throw new Error('ASR audio duration mismatch'); } finally {bytes.fill(0);}
    }
    if (operation === 'tts') {
      const input = body.input as Record<string, unknown> | undefined;
      if (!input || typeof input.text !== 'string' || (this.configuration.purpose !== 'user-trial' && [...input.text].length > 600)) throw new Error('Trial speech request exceeds its reviewed bounds');
      if (model.model === MINIMAX_TTS_MODEL || model.model === 'MiniMax/speech-2.8-hd') {
        const voice = input.voice_setting as Record<string, unknown> | undefined;
        const audio = input.audio_setting as Record<string, unknown> | undefined;
        if (config.endpoint !== MINIMAX_TTS_ENDPOINT || Buffer.byteLength(input.text, 'utf8') !== textCharacters
          || !voice || typeof voice.voice_id !== 'string' || !voice.voice_id || voice.speed !== 1 || voice.vol !== 1 || voice.pitch !== 0
          || !audio || audio.sample_rate !== 24000 || audio.format !== 'wav' || audio.channel !== 1
          || input.output_format !== 'hex' || input.language_boost !== 'Chinese'
          || Object.keys(input).some(key => !['text', 'voice_setting', 'audio_setting', 'output_format', 'language_boost'].includes(key))
          || Object.keys(voice).some(key => !['voice_id', 'speed', 'vol', 'pitch'].includes(key))
          || Object.keys(audio).some(key => !['sample_rate', 'format', 'channel'].includes(key)))
          throw new Error('Trial MiniMax speech request exceeds its reviewed bounds');
      } else {
        const instruction = input[isQwenAudioTtsModel(model.model) ? 'instruction' : 'instructions'];
        if (billedCharacters(input.text) !== textCharacters || typeof instruction !== 'string'
          || Buffer.byteLength(instruction, 'utf8') > 1600) throw new Error('Trial speech request exceeds its reviewed bounds');
      }
    }
    const timeout = AbortSignal.timeout(this.configuration.memory.timeoutMs);
    const boundedSignal = AbortSignal.any([signal, timeout]);
    if (config.model !== model.model || config.endpoint !== model.endpoint) throw new Error('Trial transport provider mismatch');
    const boundedBody = model.provider === 'deepseek' && operation !== 'memory_turn' ? { ...body, max_tokens: operation === 'admission' && Number.isSafeInteger(body.max_tokens) && Number(body.max_tokens) > 0 && Number(body.max_tokens) <= 4096 ? Math.min(Number(body.max_tokens), model.outputTokenLimit) : model.outputTokenLimit } : body;
    const requestBody = operation === 'dialogue' && this.dialogueTemperature !== undefined ? { ...boundedBody, temperature: this.dialogueTemperature } : boundedBody;
    const call = (sent: () => void = () => {}) => new ProviderTransport((...args) => {
      sent(); return this.providerFetch(...args);
    }).request(config, scope, operation, requestBody, boundedSignal, textCharacters, audioSeconds);
    return this.runtime ? this.runtime.observeCall(operation as TrialOperation, scope.characterId, call, boundedSignal) : call();
  }
}

export function createTrialTtsProvider(selection: ProviderSelection, endpoint: EndpointConfig,
  store: MediaStorePort, transport: ProviderTransport, voices?: RegisteredVoiceStore): TtsProvider {
  if (selection.adapterId === 'minimax-tts') {
    if (!voices || !selection.voice || endpoint.model !== selection.model || endpoint.endpoint !== selection.endpoint) throw new Error('Registered MiniMax voice required');
    const registeredVoice = voices.resolve({ voiceId: selection.voice, provider: 'dashscope', targetModel: selection.model,
      endpoint: selection.endpoint, credentialRef: selection.credentialRef });
    return new MiniMaxTtsProvider({ ...endpoint, voice: selection.voice, credentialRef: selection.credentialRef, registeredVoice }, store, transport);
  }
  if (selection.adapterId === 'qwen-audio-tts') {
    const registeredVoice = voices?.snapshot().voices.some(voice => voice.voiceId === selection.voice)
      ? voices.resolve({ voiceId: selection.voice!, provider: 'dashscope', targetModel: selection.model,
        endpoint: selection.endpoint, credentialRef: selection.credentialRef }) : undefined;
    return new QwenAudioTtsProvider({ ...endpoint, voice: selection.voice!, credentialRef: selection.credentialRef,
      ...(registeredVoice ? { registeredVoice, languageHints: ['zh'] as const } : {}) }, store, transport);
  }
  if (selection.adapterId === 'qwen-tts-instruct') return new QwenTtsProvider({ ...endpoint, voice: selection.voice!, language: selection.language! }, store, transport);
  throw new Error('Unregistered speech adapter');
}

/** Real semantic adapter and compiler; the SQLite port still owns tickets, source expansion and atomic commit. */
export class StrictTrialMemoryProvider implements MemoryTurnProvider {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly store: SqliteMemoryStore, private readonly config: EndpointConfig,
    private readonly transport: ProviderTransport, private readonly runId: string,
    private readonly evidence: (event: SemanticAttemptEvent) => Promise<void>, private readonly thinking?: 'high',
    private readonly provenanceKind: 'real_provider' | 'controlled_stub' = 'real_provider') {}
  plan(input: MemoryTurnInput, signal: AbortSignal): Promise<MemoryTurnPlan> {
    return this.planWithMode(input,signal);
  }
  /** Called only with the storage-issued virtual management ticket. */
  planManagement(input:MemoryTurnInput,signal:AbortSignal,managementTarget:import('../contracts/memory-lifecycle.js').SourceVersion):Promise<MemoryTurnPlan>{
    return this.planWithMode(input,signal,managementTarget);
  }
  private planWithMode(input:MemoryTurnInput,signal:AbortSignal,managementTarget?:import('../contracts/memory-lifecycle.js').SourceVersion):Promise<MemoryTurnPlan>{
    const captured = structuredClone(input);
    managementTarget=managementTarget?structuredClone(managementTarget):undefined;
    const work = this.pending.then(async () => {
      signal.throwIfAborted();
      // Include inactive parents as metadata so unread/deleted support is never silently invented.
      const records = new Map<string, MemoryRecord>();
      const visit = (record: MemoryRecord) => {
        if (records.has(record.id)) return;
        records.set(record.id, record);
        for (const ref of record.sources) { const parent = this.store.inspect(captured.scope, ref.id); if (parent) visit(parent); }
      };
      for (const kind of ['transcript', 'summary', 'memory', 'keyword_index', 'vector_index', 'context_cache', 'emotion'] as const)
        for (const record of this.store.visible(captured.scope, kind)) visit(record);
      let snapshot=prototypeSnapshot(captured,[...records.values()]);
      if(managementTarget){
        const current=captured.sources.find(s=>s.id===captured.currentMessageId);
        if(!current||current.kind!=='transcript'||current.messageRole!=='user'||current.origin!=='manual'||records.has(current.id))throw Error('Invalid virtual management request');
        snapshot={...snapshot,graph:[...snapshot.graph,{id:current.id,version:current.version,characterId:captured.scope.characterId,kind:'transcript',state:'active',eligible:true,parents:[]}]};
      }
      const result = await runMemorySemanticAttempt({ snapshot,
        config: this.config, transport: this.transport, provenance: { kind: this.provenanceKind, runId: this.runId, attemptId: randomUUID() },
        signal, evidence: this.evidence, dynamics:true, ...(managementTarget?{managementTarget}:{}), ...(this.thinking ? { reasoningEffort: this.thinking } : {}) });
      if (result.compiled.status === 'ready') return result.compiled.plan;
      if (result.compiled.status === 'needs_sources' && result.compiled.readProbe) return result.compiled.readProbe;
      throw new Error('Strict memory semantics are incomplete; no update was committed');
    });
    // Across both characters only one strict model request can reserve the large peak budget.
    this.pending = work.then(() => {}, () => {});
    return abortable(work, signal);
  }
}

export function keyReader(filename: string, configuration: TrialConfiguration, configFile: string, activationFile: string): () => string {
  return () => {
    // The generic transport requests its key before its async budget permit. Recheck metadata here first.
    const raw = readFileSync(configFile, 'utf8'), activation = JSON.parse(readFileSync(activationFile, 'utf8'));
    if (activation?.version !== 1 || activation.status !== 'active' || activation.phaseId !== configuration.phaseId
      || activation.configSha256 !== createHash('sha256').update(raw).digest('hex')
      || JSON.stringify(JSON.parse(raw)) !== JSON.stringify(configuration)) throw new Error('Trial is not active');
    const actual = realpathSync(filename), local = relative(realpathSync(configuration.projectRoot), actual), info = statSync(actual);
    if (!isAbsolute(filename) || (local !== '..' && !local.startsWith('../')) || !info.isFile() || info.size > MAX_API_KEY_FILE_BYTES
      || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Restricted external trial credential file required');
    const key = normalizeApiKey(readFileSync(actual, 'utf8'));
    if (key === undefined) throw new Error('Trial credential must contain exactly one key');
    return key;
  };
}

export async function startTrialBackend(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configFile = environment.PET_TRIAL_CONFIG, activationFile = environment.PET_TRIAL_ACTIVATION;
  if (!configFile || !activationFile || !isAbsolute(configFile) || !isAbsolute(activationFile)) throw new Error('Explicit trial configuration required');
  const registeredConfiguration = await readActiveTrialConfiguration(configFile, activationFile);
  if (registeredConfiguration.purpose === 'user-trial') assertCompanionDataConfiguration(registeredConfiguration);
  await verifyTrialRuntime(registeredConfiguration);
  const voices = await RegisteredVoiceStore.open(resolve(registeredConfiguration.projectRoot, '.local/data/registered-voices.json'));
  const settings = await ManagementSettingsStore.open(resolve(dirname(configFile), 'management-settings.json'), registeredConfiguration, voices);
  const configuration = effectiveTrialConfiguration(registeredConfiguration, settings.effective);
  const evidenceRoot = resolve(configuration.projectRoot, '.local/model-evaluation/trial');
  await mkdir(evidenceRoot, { recursive: true });
  const runtime = new ManagementRuntime(configuration.sourceRevision, async diagnostic => {
    await appendFile(resolve(evidenceRoot, 'voice-failures.jsonl'), JSON.stringify({sourceRevision:configuration.sourceRevision,
      instanceId:runtime.instanceId, ...diagnostic}) + '\n', {mode:0o600});
  });
  const lockPath = resolve(evidenceRoot, '../backend.lock'), lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, phaseId: configuration.phaseId, sourceRevision: configuration.sourceRevision, startedAt: new Date().toISOString() }) + '\n');
  let store: SqliteMemoryStore | undefined, session: BackendSession | undefined;
  let wechat: WeChatService | undefined;
  let wake: WakeManager | undefined;
  let managementForget: StrictManagementForget | undefined;
  let memoryImport: SqliteMemoryImportManagement | undefined;
  let desktopWork: import('../contracts/desktop-work.js').DesktopWorkPort | undefined;
  let management: Awaited<ReturnType<typeof startRuntimeManagement>> | undefined;
  const release = async () => { await lock.close(); await unlink(lockPath); };
  try {
    const authorizer = new TrialAuthorizer(configuration, configFile, activationFile, registeredConfiguration);
    const transport = new TrialTransport(configuration, fetch, runtime, settings.effective.providers.dialogue.temperature);
    const endpoint = (operation: TrialOperation): EndpointConfig => {
      const model=configuration.models[operation];if(!model)throw Error('Requested provider is not configured');
      return {model:model.model,endpoint:model.endpoint,apiKey:keyReader(model.credentialFile,registeredConfiguration,configFile,activationFile),authorizer};
    };
    store = new SqliteMemoryStore({ filename: configuration.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
    const diagnostic = async (value: object) => appendFile(resolve(evidenceRoot, 'events.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 });
    const evidence = async (event: SemanticAttemptEvent) => {
      if (event.type === 'failure' && configuration.purpose === 'smoke-text') await authorizer.stop('semantic_failure');
      const data = event.data as Record<string, unknown>;
      // Persist trace identity and statuses only; avoid duplicating personal conversation bodies in diagnostics.
      await diagnostic({ type: event.type, provenance: event.provenance, scope: event.scope, elapsedMs: event.elapsedMs,
        digest: createHash('sha256').update(JSON.stringify(event.data)).digest('hex'),
        ...(event.type === 'failure' ? { stage: data.stage, name: data.name, ...(data.transport ? {transport:data.transport} : {}) } : {}),
        ...(event.type === 'compiled' ? { status: (data.compiled as { status: string }).status } : {}) });
      if (configuration.purpose === 'smoke-text' && event.type === 'declaration')
        await diagnostic({ type: 'smoke_memory_declaration', provenance: event.provenance, scope: event.scope, declaration: data.declaration });
      if (configuration.purpose === 'smoke-text' && event.type === 'response') {
        const raw = data.raw as Record<string, unknown>, usage = raw.usage as Record<string, unknown> | undefined;
        await diagnostic({ type: 'smoke_memory_final', provenance: event.provenance, scope: event.scope,
          finalContent: data.content, usage: { prompt_tokens: usage?.prompt_tokens ?? null, completion_tokens: usage?.completion_tokens ?? null,
            total_tokens: usage?.total_tokens ?? null } });
      }
    };
    class ObservedTrialMemory extends SqliteLifecycleMemoryPort {
      private async report(outcome: MemoryTurnOutcome, currentMessageId: string, text: string, signal: AbortSignal) {
        if (outcome.status === 'rejected' && configuration.purpose === 'smoke-text') await authorizer.stop('memory_commit_rejected');
        if (configuration.purpose === 'smoke-text' && outcome.status === 'applied') {
          const context = await this.context(outcome.scope, text, null, signal);
          this.assertContextCurrent(context);
          await diagnostic({ type: 'smoke_postcommit_context', scope: outcome.scope, context,
            purpose: 'Actual post-commit context assembly; not the earlier foreground reply input' });
        }
        await diagnostic({ type: 'memory_outcome', scope: outcome.scope, currentMessageId, outcome });
        return outcome;
      }
      override async prepareTurn(scope: TurnScope, id: string, text: string, signal: AbortSignal) {
        return this.report(await super.prepareTurn(scope, id, text, signal), id, text, signal);
      }
      override async prepareBackgroundTurn(scope: TurnScope, id: string, text: string, signal: AbortSignal) {
        return this.report(await super.prepareBackgroundTurn(scope, id, text, signal), id, text, signal);
      }
    }
    const strictProvider=new StrictTrialMemoryProvider(store, endpoint('memory_turn'), transport, configuration.phaseId, evidence, configuration.models.memory_turn.thinking);
    const memory = new ObservedTrialMemory(store, {
      context: { inputTokenBudget: configuration.models.dialogue.inputTokenLimit, maxRecentMessages: settings.effective.context.maxRecentMessages, maxMemories: settings.effective.context.maxMemories,
        summaryLimit: settings.effective.context.summaryLimit, countTokens: contextInputUpperBound, relevance: () => 1 },
      turn: { inputTokenBudget: configuration.models.memory_turn.inputTokenLimit,
        countTokens: input => buildMemorySemanticFormat(input,true).inputUpperBound, maxSupplementaryPlans: 1,
        provider: strictProvider },
      summary: { inputTokenBudget: configuration.models.summary.inputTokenLimit, minMessages: settings.effective.context.summaryMinMessages, maxMessages: settings.effective.context.summaryMaxMessages,
        countTokens: summaryInputUpperBound, provider: new JsonSummaryProvider(endpoint('summary'), transport) },
    });
    if(configuration.purpose==='user-trial' && typeof (memory as import('../contracts/memory-lifecycle.js').BackgroundMemoryPort).beginPendingMutation!=='function')throw Error('Background privacy capability is required');
    const mediaStore = new MemoryMediaStore();
    const admission = new TrialAdmission(endpoint('admission'), transport,
      (scope, text, signal) => configuration.purpose==='user-trial' ? memory.foregroundContext(scope,`${scope.turnId}:user`,text,null,signal) : memory.context(scope, text, null, signal), async value => {
        if (value.rejected && configuration.purpose === 'smoke-text') await authorizer.stop('admission_rejected');
        await diagnostic({ type: 'admission', ...value });
      },
      context => memory.assertContextCurrent(context), async event => {
        if (configuration.purpose === 'smoke-text') await diagnostic({ ...event, phaseId: configuration.phaseId });
      });
    const presentation = await PresentationSettingsStore.open(resolve(configuration.projectRoot, '.local/data/presentation-settings.json'),
      await readPresentationCatalog(configuration.projectRoot), policy => process.stdout.write(JSON.stringify({ channel: 'presentation_policy', policy }) + '\n'));
    const sessionPorts: BackendPorts = { memory, backgroundMemory: memory, mediaStore,
      createEmotion:()=>new EmotionTurns(store!.emotion,store!),
      consumeWakeHit: hit => wake?.consumeHit(hit),
      companionProfile: store,
      ...(configuration.purpose==='user-trial' ? {classifyMemoryRequest:admission.foregroundRequest.bind(admission)} : {isMemoryIndependent:admission.isIndependent.bind(admission)}),
      dialogue: new JsonDialogueProvider(endpoint('dialogue'), transport, () => presentation.allowedIntent()),
      perception: configuration.models.asr
        ? new SplitPerceptionProvider(new QwenAsrProvider(endpoint('asr'), mediaStore, transport),
          new QwenVisualEmotionProvider(endpoint('perception'), mediaStore, transport), { visualTimeoutMs: 1500 })
        : new QwenPerceptionProvider({ ...endpoint('perception'), cueLifetimeMs: 5 * 60_000 }, mediaStore, transport),
      tts: createTrialTtsProvider(settings.effective.providers.tts, endpoint('tts'), mediaStore, transport, voices),
    };
    session = new BackendSession(sessionPorts, message => {
      runtime.observeDesktop(message);
      if (message.channel === 'event' && message.event.type === 'error' && configuration.purpose === 'smoke-text') void authorizer.stop('backend_error').catch(() => {});
      process.stdout.write(JSON.stringify(message) + '\n');
    }, () => store!.close(), (scope, kind) => {
      runtime.record(kind === 'summary' ? 'summary' : 'memory_turn', 'failed', scope.characterId, '后台维护未完成；未记录对话正文。');
      if (configuration.purpose === 'smoke-text') void authorizer.stop(`${kind}_failure`).catch(() => {});
      void diagnostic({ type: 'background_failure', scope, kind }).catch(() => {});
    });
    process.stdout.write(JSON.stringify({ channel: 'presentation_policy', policy: presentation.snapshot() }) + '\n');
    runtime.observeMemoryQueue(() => session!.pendingMemoryJobs());
    if (configuration.purpose === 'user-trial') {
      try {
        const channelStore=new WeChatStore(resolve(configuration.projectRoot,'.local/data/wechat/channel.sqlite'));
        const voiceMedia=new MemoryMediaStore();
        const replyMedia=new MemoryMediaStore(),channelApi=new WeChatApi();
        const replyTts=createTrialTtsProvider(settings.effective.providers.tts,endpoint('tts'),replyMedia,transport,voices);
        wechat=new WeChatService(channelStore,channelApi,async(key,send)=>{
          if(!management)throw Error('Management not ready');
          const workChannel=management.createWorkChannel(resolve(configuration.projectRoot,'.local/data/wechat/work',key));
          const conversation=new WeChatTextConversation({key,store:channelStore,send,ports:sessionPorts,...workChannel,
            classifier:new WorkIntentClassifier(endpoint('admission'),transport),planner:new WorkPlanner(endpoint('admission'),transport)});
          try{return await conversation.start();}catch(error){await conversation.close();throw error;}
        },{transcribe:wechatTranscriber(voiceMedia,new QwenAsrProvider(endpoint('asr'),voiceMedia,transport)),
          sendVoice:wechatAudioFileSender(replyMedia,replyTts,channelApi)});
      } catch { process.stderr.write('WeChat channel storage unavailable; companion data unchanged.\n'); }
      const wakeModels=resolve(configuration.projectRoot,'.local/data/wake-models');
      let wakeAvailable=false;
      try { const {verifyWakeModels}=await import('../media/wake/models.js');await verifyWakeModels(wakeModels);wakeAvailable=true; } catch { /* Off until a verified model package is installed. */ }
      try { wake=await WakeManager.open({instanceId:runtime.instanceId,file:resolve(configuration.projectRoot,'.local/data/wake-settings.json'),available:wakeAvailable,
        createDetector:async settings=>{const {openWakeDetector}=await import('../media/wake/detector.js');return openWakeDetector({modelDirectory:wakeModels,settings});},
        send:message=>process.stdout.write(JSON.stringify(message)+'\n')});
      } catch { process.stderr.write('Local wake settings unavailable; existing settings preserved.\n'); }
      managementForget=new StrictManagementForget(store,store.lifecycle,{inputTokenBudget:configuration.models.memory_turn.inputTokenLimit,
        countTokens:input=>buildMemorySemanticFormat(input,true).inputUpperBound+1024},
        (input,signal,action)=>strictProvider.planManagement(input,signal,{id:action.id,version:action.expectedVersion}));
      const importConfiguration = memoryImportConfiguration(configuration);
      try { memoryImport = new SqliteMemoryImportManagement({
        filename: resolve(configuration.projectRoot,'.local/data/memory-import.sqlite'),
        codexHome: resolve(homedir(),'.codex'), instanceId: runtime.instanceId, store,
        configuration: importConfiguration,
        countTokens: historicalMemoryInputBytes,
        processor: { async plan(input,signal,settle) {
          const importEndpoint = observedImportEndpoint(endpoint('memory_turn'),configuration.models.memory_turn,settle);
          const provider = new StrictTrialMemoryProvider(store!,importEndpoint,
            new HistoricalMemoryTransport(transport,importConfiguration),configuration.phaseId,
            async () => {}, configuration.models.memory_turn.thinking);
          return provider.plan(input,signal);
        } },
      });
      } catch { process.stderr.write('Historical memory import unavailable; companion chat remains available.\n'); }
      management = await startRuntimeManagement(registeredConfiguration, configFile, settings, runtime,
        withStrictManagementForget(new SqliteManagementMemoryPort(store,memory),managementForget),presentation,
        pendingMemoryManagement(runtime.instanceId,memory,(scope,id)=>{const source=store!.inspect(scope,id);return source?.state==='active'&&source.message?.role==='user'?{text:source.text,createdAt:source.message.createdAt}:undefined;},
          (scope,id,text)=>session!.retryPendingMemory(scope,id,text),()=>session!.pendingMemoryJobs().some(x=>x.queued+x.running>0)),wechat,wake,memoryImport,store.emotion);
    }
    if (configuration.purpose === 'user-trial') {
      const classifier = new WorkIntentClassifier(endpoint('admission'), transport);
      if (management?.tasks && management.projects && management.receipts) {
        const work = new DesktopWork({ receipts: management.receipts, projects: management.projects, forwarding: management.tasks,
          classify: classifier.classify.bind(classifier), interpret: classifier.interpret.bind(classifier),
          plan: (scope,text,catalog,signal)=>new WorkPlanner(endpoint('admission'),transport).plan(scope,text,catalog,signal),
          emit: state => process.stdout.write(JSON.stringify({ channel: 'work_state', state }) + '\n'), notify: notice => session!.notifyWork(notice) });
        desktopWork = work; session.attachWork(work); await work.start();
      } else {
        // Failed independent storage must not stop unrelated companion chat or leak engineering input into it.
        let sequence = 0;
        const unavailable = () => process.stdout.write(JSON.stringify({ channel: 'work_state', state: { sequence: ++sequence,
          focus: 'work', stage: 'failed', requests: [], detail: '工作记录暂不可用；这次任务没有保存或发送，陪伴聊天仍可继续。' } }) + '\n');
        desktopWork = { onInput() {}, async route(scope, text, signal) {
          const intent = await classifier.classify(scope, text, signal);
          if (intent.kind === 'companion') return 'companion'; unavailable(); return 'handled';
        }, async action() { unavailable(); }, async close() {} };
        session.attachWork(desktopWork);
      }
    }
    await wechat?.restore().catch(()=>{process.stderr.write('WeChat restore deferred; use connection page.\n');});
    const cleanupTimer = setInterval(() => { try { store!.cleanup(); } catch { process.stderr.write('Local memory cleanup did not complete\n'); } }, 60_000);
    cleanupTimer.unref();
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let stopping = false;
    const close = async () => {
      if (stopping) return; stopping = true; clearInterval(cleanupTimer); lines.close(); process.stdin.pause();
      managementForget?.close();
      try { await wake?.close(); await wechat?.close(); await desktopWork?.close(); await management?.close(); await managementForget?.drain(); await settings.drain(); await presentation.drain(); }
      finally { try { await session!.close(); } finally { await release(); } }
    };
    let submitted = false;
    lines.on('line', line => {
      if (configuration.purpose === 'smoke-text') {
        try {
          const message = JSON.parse(line);
          if (message.channel === 'command') {
            if (submitted || message.command?.type !== 'submit_text' || message.command.text !== configuration.smokeInput) throw new Error('Unregistered smoke input');
            submitted = true;
          }
        } catch { void authorizer.stop('unregistered_smoke_input').finally(close); return; }
      }
      try { if(wake?.receive(JSON.parse(line)))return; } catch { /* Original protocol validator owns non-wake input. */ }
      void session!.receiveLine(line);
    });
    lines.on('close', () => { void close(); });
    process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
  } catch (error) {
    managementForget?.close();
    await wake?.close(); await wechat?.close(); await management?.close(); await managementForget?.drain();
    await memoryImport?.close();
    if (session) await session.close(); else store?.close();
    await release(); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startTrialBackend().catch(() => { process.stderr.write('试用后端未启动，请检查已登记的配置与程序版本。\n'); process.exitCode = 1; });
}
