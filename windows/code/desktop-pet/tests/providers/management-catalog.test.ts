import test from 'node:test';
import assert from 'node:assert/strict';
import { managementAdapterCatalog } from '../../providers/management-catalog.js';
import type { ProviderSelection, ProviderSlot } from '../../contracts/management.js';
import type { TrialConfiguration, TrialModel } from '../../app/trial-config.js';
import { validateTrialConfiguration } from '../../app/trial-config.js';
import { estimateTrialMicros } from '../../app/trial-authorizer.js';
import { ProviderTransport, type CallAuthorizer } from '../../providers/transport.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { QwenPerceptionProvider } from '../../providers/qwen-perception.js';
import { QwenTtsProvider, billedCharacters } from '../../providers/qwen-tts.js';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav } from '../../media/wav.js';
import { defaultManagedSettings, validateManagedSettings, effectiveTrialConfiguration } from '../../management/settings.js';
import { createTrialTtsProvider, TrialTransport } from '../../app/trial-backend.js';

// Synthetic metadata mirrors the sanitized I input, never reads an installed config/key.
function fixture(): TrialConfiguration {
  const chat: TrialModel = { provider: 'dashscope', model: 'qwen-plus-2025-12-01',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    credentialFile: '/nonexistent-catalog-test-key', inputTokenLimit: 32768, outputTokenLimit: 32768,
    inputMicrosPerToken: .8, outputMicrosPerToken: 2, reservationMicros: 100000 };
  const root = '/nonexistent-catalog-test-project';
  return { version: 1, phaseId: 'local-trial-catalog-controlled', purpose: 'user-trial', projectRoot: root,
    sourceRevision: 'a'.repeat(40), runtimeFiles: Object.fromEntries(['dist/app/trial-backend.js',
      'dist/app/trial-launcher.js', 'desktop/build/renderer.js', 'desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet']
      .map(path => [`code/desktop-pet/${path}`, 'a'.repeat(64)])),
    database: `${root}/state.sqlite`, budgetFile: `${root}/.local/model-evaluation/budget.json`,
    budgetBatchId: 'synthetic-catalog', limitMicros: 20000000, phaseLimitMicros: 20000000, maxCalls: 260,
    operationLimits: { admission: 30, dialogue: 30, memory_turn: 60, summary: 10, perception: 10, tts: 120 },
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
    models: { dialogue: { ...chat }, summary: { ...chat }, admission: { ...chat },
      memory_turn: { ...chat, provider: 'deepseek', model: 'deepseek-v4-pro',
        endpoint: 'https://api.deepseek.com/chat/completions', outputTokenLimit: 393216,
        inputMicrosPerToken: 9, outputMicrosPerToken: 27, reservationMicros: 11000000, thinking: 'high' },
      perception: { ...chat, model: 'qwen3.5-omni-flash-2026-03-15', inputTokenLimit: 196608,
        outputTokenLimit: 65536, inputMicrosPerToken: 18, outputMicrosPerToken: 13.3, reservationMicros: 4500000 },
      tts: { ...chat, model: 'qwen3-tts-instruct-flash-2026-01-26',
        endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        inputTokenLimit: 0, outputTokenLimit: 0, inputMicrosPerToken: 0, outputMicrosPerToken: 0, characterMicros: 80 } } };
}
type Selection = Omit<ProviderSelection, 'credentialRef'>;
const chosen = (slot: ProviderSlot, model: string): Selection => {
  const value = managementAdapterCatalog(fixture()).find(adapter => adapter.slots.includes(slot))!
    .choices!.find(choice => choice.configuration.model === model)?.configuration;
  assert.ok(value); return value;
};
const trialModel = (selection: Selection): TrialModel => ({ ...selection, credentialFile: '/nonexistent-catalog-test-key' });
const scope = { characterId: 'friend' as const, sessionId: 'catalog-session', turnId: 'catalog-turn', generation: 1 };
const signal = () => new AbortController().signal;
const authorizer: CallAuthorizer = { async authorize() { return { async settle() {} }; } };
const endpoint = (configuration: Selection) => ({ ...configuration, apiKey: () => 'synthetic-only', authorizer });
const expression = { emotion: 'calm' as const, intensity: .4, delivery: '温和自然', gesture: null };

test('all six registered baselines retain tariffs and limits without reading or disclosing private fields', () => {
  const base = fixture();
  for (const model of Object.values(base.models)) {
    Object.defineProperty(model, 'credentialFile', { enumerable: true, get() { throw new Error('Private field read'); } });
    Object.defineProperty(model, 'extraPrivateData', { enumerable: true, get() { throw new Error('Unexpected field read'); } });
  }
  const catalog = managementAdapterCatalog(base);
  assert.equal(catalog.length, 8); assert.equal(new Set(catalog.map(adapter => adapter.id)).size, 8);
  for (const adapter of catalog.filter(adapter => !['qwen-audio-tts', 'minimax-tts'].includes(adapter.id))) {
    const slot = adapter.slots[0]!, original = base.models[slot]!, first = adapter.choices![0]!.configuration;
    for (const field of ['model', 'provider', 'endpoint', 'inputTokenLimit', 'outputTokenLimit',
      'inputMicrosPerToken', 'outputMicrosPerToken', 'reservationMicros'] as const) assert.equal(first[field], original[field]);
  }
  assert.doesNotMatch(JSON.stringify(catalog), /credential|nonexistent-catalog-test|extraPrivateData/);
});

test('catalog is detached from the baseline and fresh between calls, including nested voice lists', () => {
  const base = fixture(), before = JSON.stringify(base), first = managementAdapterCatalog(base);
  first[0]!.choices![0]!.configuration.reservationMicros = 1;
  (first.find(adapter => adapter.id === 'qwen-tts-instruct')!.choices![0]!.voices![0] as { label: string }).label = 'mutated';
  assert.equal(JSON.stringify(base), before);
  assert.notEqual(managementAdapterCatalog(base)[0]!.choices![0]!.configuration.reservationMicros, 1);
  assert.doesNotMatch(JSON.stringify(managementAdapterCatalog(base)), /mutated/);
});

test('six existing adapter choices pass trial bounds and keep model/price/reservation as one configuration', () => {
  const base = fixture();
  for (const adapter of managementAdapterCatalog(base).filter(adapter => adapter.id !== 'qwen-audio-tts')) {
    assert.equal(new Set(adapter.models).size, adapter.models.length);
    const slot = adapter.slots[0]!;
    for (const choice of adapter.choices!) {
      const m = trialModel(choice.configuration);
      const effective = validateTrialConfiguration({ ...base, models: { ...base.models, [slot]: m } });
      assert.equal(effective.limitMicros, 20000000);
      assert.deepEqual(effective.operationLimits, base.operationLimits);
      const worst = slot === 'tts' ? 1200 * m.characterMicros!
        : Math.ceil(m.inputTokenLimit * m.inputMicrosPerToken + m.outputTokenLimit * m.outputMicrosPerToken);
      assert.ok(m.reservationMicros >= worst);
    }
  }
  for (const slot of ['dialogue', 'summary', 'admission'] as const) {
    const flash = chosen(slot, 'qwen-flash-2025-07-28');
    assert.equal(flash.reservationMicros, 60000);
    assert.equal(estimateTrialMicros(trialModel(flash), slot,
      { status: 'success', usage: { prompt_tokens: 1000, completion_tokens: 1000 }, requestId: null }), 1650);
  }
});

test('Omni Plus discloses the concurrent budget limitation instead of understating its reservation', () => {
  const base = fixture(), plus = chosen('perception', 'qwen3.5-omni-plus-2026-03-15');
  assert.equal(Math.ceil(plus.inputTokenLimit * 53 + plus.outputTokenLimit * 40), 13041664);
  assert.ok(plus.reservationMicros + base.models.memory_turn.reservationMicros > base.limitMicros!);
  const descriptor = managementAdapterCatalog(base).find(adapter => adapter.id === 'qwen-perception')!;
  assert.match(descriptor.note, /累计总账/);
});

test('Flash selection reaches the actual dialogue request and keeps non-thinking JSON behavior', async () => {
  const selected = chosen('dialogue', 'qwen-flash-2025-07-28');
  let calls = 0;
  const provider = new QwenDialogueProvider(endpoint(selected), new ProviderTransport(async (url, init) => {
    calls++; assert.equal(url, selected.endpoint);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, selected.model); assert.equal(body.enable_thinking, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ text: '我在。', expression }) }, finish_reason: 'stop' }] });
  }));
  assert.equal((await provider.reply({ scope, text: '你好', context: { scope, characterPrompt: '朋友', recent: [],
    summary: '', memories: [], perception: null, inputTokenBudget: 5000 } }, signal())).text, '我在。');
  assert.equal(calls, 1);
});

test('Omni Plus sends this turn audio and image bytes through the existing perception adapter', async () => {
  const selected = chosen('perception', 'qwen3.5-omni-plus-2026-03-15'), store = new MemoryMediaStore();
  const wav = pcm16Wav(new Float32Array(160), 16000);
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2QmcAAAAASUVORK5CYII=', 'base64'));
  const audio = await store.put(scope, wav, 'audio/wav'), image = await store.put(scope, png, 'image/png');
  const provider = new QwenPerceptionProvider({ ...endpoint(selected), cueLifetimeMs: 60000 }, store,
    new ProviderTransport(async (url, init) => {
      assert.equal(url, selected.endpoint); const body = JSON.parse(String(init?.body));
      assert.equal(body.model, selected.model); assert.deepEqual(body.modalities, ['text']);
      assert.equal(body.response_format, undefined);
      assert.deepEqual(Buffer.from(body.messages[0].content[0].input_audio.data.split(',')[1], 'base64'), Buffer.from(wav));
      assert.deepEqual(Buffer.from(body.messages[0].content[1].image_url.url.split(',')[1], 'base64'), Buffer.from(png));
      const result = { transcript: '你好', emotion:'neutral' };
      const chunk = { choices: [{ delta: { content: JSON.stringify(result) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    }));
  const result = await provider.perceive({ scope, audio, images: [image], inputEndedAt: new Date().toISOString(),
    captureStoppedAt: new Date().toISOString() }, signal());
  assert.equal(result.status, 'complete');
  assert.equal(estimateTrialMicros(trialModel(selected), 'perception', { status: 'success',
    usage: { prompt_tokens: 1000, completion_tokens: 100 }, requestId: null }), 57000);
  await store.releaseScope(scope);
});

test('supported TTS voice changes the existing request and returns WAV without playing audio', async () => {
  const catalog = managementAdapterCatalog(fixture()), descriptor = catalog.find(adapter => adapter.id === 'qwen-tts-instruct')!;
  const selected = { ...chosen('tts', 'qwen3-tts-instruct-flash'), voice: 'Serena' };
  assert.ok(descriptor.choices!.every(choice => choice.voices?.some(voice => voice.id === selected.voice)));
  assert.equal(descriptor.capabilities.cloning, false);
  assert.match(descriptor.note, /同系列/);
  const store = new MemoryMediaStore(), wav = pcm16Wav(new Float32Array(240), 24000);
  const provider = new QwenTtsProvider({ ...endpoint(selected), voice: selected.voice, language: selected.language! }, store,
    new ProviderTransport(async (url, init) => {
      if (init?.method === 'POST') {
        assert.equal(url, selected.endpoint); const body = JSON.parse(String(init.body));
        assert.equal(body.model, selected.model); assert.equal(body.input.voice, 'Serena');
        assert.equal(body.input.language_type, 'Chinese'); assert.equal(body.input.instructions, expression.delivery);
        return Response.json({ output: { audio: { url: 'https://synthetic.invalid/clip.wav' } }, usage: { characters: billedCharacters('你好') } });
      }
      assert.equal(url, 'https://synthetic.invalid/clip.wav'); assert.equal(init?.headers, undefined);
      return new Response(wav.slice().buffer);
    }));
  const result = await provider.synthesize({ scope, text: '你好', expression }, signal());
  assert.equal(result.audio.mimeType, 'audio/wav'); assert.ok(result.durationMs !== null && result.durationMs > 0);
  assert.equal(estimateTrialMicros(trialModel(selected), 'tts', { status: 'success', usage: { characters: 4 }, requestId: null }), 320);
  await store.releaseScope(scope);
});

test('only reviewed MiniMax cloning is offered and it has no selectable voice before enrollment', () => {
  const catalog = managementAdapterCatalog(fixture());
  assert.deepEqual(catalog.filter(adapter => adapter.capabilities.cloning).map(adapter => adapter.id), ['minimax-tts']);
  for (const choice of catalog.find(adapter => adapter.id === 'minimax-tts')!.choices!) {
    assert.deepEqual(choice.voices, []); assert.equal(choice.configuration.voice, undefined);
  }
  assert.doesNotMatch(JSON.stringify(catalog.map(adapter => adapter.models)), /cosyvoice|deepseek-v4-flash|tts-vc/);
  assert.deepEqual(catalog.find(adapter => adapter.id === 'strict-deepseek')!.models, ['deepseek-v4-pro']);
});

test('second TTS adapter has its own endpoint, tariffs and voices, without old language parameters', () => {
  const adapter = managementAdapterCatalog(fixture()).find(entry => entry.id === 'qwen-audio-tts')!;
  assert.ok(adapter); const choice = adapter.choices![0]!;
  assert.equal(choice.configuration.model, 'qwen-audio-3.0-tts-flash');
  assert.equal(choice.configuration.endpoint, 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  assert.equal(choice.configuration.characterMicros, 100); assert.equal(choice.configuration.reservationMicros, 400000);
  assert.equal(choice.configuration.language, undefined); assert.equal(adapter.capabilities.language, false);
  assert.deepEqual(choice.voices?.map(voice => voice.id), ['longanfengyue', 'longanlingxi']);
  assert.equal(estimateTrialMicros(trialModel(choice.configuration), 'tts',
    { status: 'success', usage: { characters: 1200 }, requestId: null }), 120000);
});

test('Plus page selection reaches the real factory and singular-instruction transport with its own tariff', async () => {
  const base = fixture(), defaults = defaultManagedSettings(base), before = JSON.stringify(defaults);
  const choice = managementAdapterCatalog(base).find(a => a.id === 'qwen-audio-tts')!.choices!.find(c => c.configuration.model === 'qwen-audio-3.0-tts-plus')!;
  assert.deepEqual(choice.voices?.map(v => v.id), ['longanlingxin']);
  const selected = { ...defaults, providers: { ...defaults.providers, tts: { ...choice.configuration, credentialRef: defaults.providers.tts.credentialRef } } };
  const settings = validateManagedSettings(selected, base), effective = effectiveTrialConfiguration(base, settings);
  assert.equal(effective.models.tts.characterMicros, 140);
  assert.equal(effective.models.tts.reservationMicros, 400000);
  assert.equal(estimateTrialMicros(effective.models.tts, 'tts', { status: 'success', usage: { characters: 4 }, requestId: null }), 560);
  assert.deepEqual(effective.models.perception, base.models.perception);
  assert.equal(effective.limitMicros, base.limitMicros); assert.deepEqual(effective.operationLimits, base.operationLimits);
  assert.throws(() => validateManagedSettings({ ...selected, providers: { ...selected.providers, tts: { ...selected.providers.tts, voice: 'longanlingxi' } } }, base), /音色/);
  const store = new MemoryMediaStore(); let posts = 0;
  const transport = new TrialTransport(effective, async (_url, init) => {
    if (init?.method === 'POST') {
      posts++; const body = JSON.parse(String(init.body));
      assert.equal(body.model, choice.configuration.model); assert.equal(body.input.voice, 'longanlingxin');
      assert.equal(body.input.instruction, expression.delivery); assert.equal(body.input.instructions, undefined);
      return Response.json({ output: { finish_reason: 'stop', audio: { url: 'https://synthetic.invalid/plus.wav' } }, usage: { characters: 4 } });
    }
    return new Response(pcm16Wav(new Float32Array(8), 24000).slice().buffer);
  });
  const provider = createTrialTtsProvider(settings.providers.tts, endpoint(choice.configuration), store, transport);
  const result = await provider.synthesize({ scope, text: '你好', expression }, signal());
  assert.equal(posts, 1); assert.equal(result.audio.mimeType, 'audio/wav');
  assert.equal(JSON.stringify(defaults), before); await store.releaseScope(scope);
});
