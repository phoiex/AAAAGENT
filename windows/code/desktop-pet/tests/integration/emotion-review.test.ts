import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DialogueContext, DialogueRequest, TurnScope } from '../../contracts/index.js';
import type { EmotionAssessment, EmotionInferenceInput, EmotionInferenceProvider, EmotionObservation } from '../../contracts/emotion-state.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { contextInputUpperBound } from '../../app/input-budgets.js';
import { EmotionTurns } from '../../core/emotion-state.js';
import { DialoguePipeline, type DialoguePorts } from '../../core/dialogue-pipeline.js';
import { TurnController } from '../../core/turn-controller.js';
import { JsonDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';

const NOW = '2026-09-19T07:00:00.000Z';
const neutralExpression = { emotion: 'neutral', intensity: .2, delivery: '自然', gesture: null };
const assessment = (user: string | null, companion: string | null) => ({
  user: user === null ? null : { label: user, intensity: null, confidence: .7 },
  companion: companion === null ? null : { label: companion, intensity: null, confidence: .8 },
});
const none = (input: MemoryTurnInput): MemoryTurnPlan => ({ scope: input.scope, request: 'none', changes: [], suppressSources: [], clarification: null, reason: 'Synthetic no-op' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Wire = { messages: { role: string; content: string }[] };

function fixture(t: TestContext, options: { background?: EmotionInferenceProvider; plan?: (input: MemoryTurnInput) => Promise<MemoryTurnPlan>; beforeContext?: (store: SqliteMemoryStore, scope: TurnScope) => void } = {}) {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.local/emotion-state-51/tmp');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'review-'));
  const storeOptions = { filename: join(directory, 'synthetic.sqlite'), retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => NOW };
  const store = new SqliteMemoryStore(storeOptions), controller = new TurnController();
  const memory = new SqliteLifecycleMemoryPort(store, {
    context: { inputTokenBudget: 32768, maxRecentMessages: 12, maxMemories: 6, summaryLimit: 4, countTokens: contextInputUpperBound, relevance: () => 1 },
    turn: { inputTokenBudget: 30000, countTokens: input => JSON.stringify(input).length, provider: { plan: options.plan ?? (async input => none(input)) } },
    summary: { minMessages: 100, maxMessages: 100, inputTokenBudget: 30000, countTokens: input => JSON.stringify(input).length, provider: { async summarize() { throw Error('No summary in bounded review'); } } },
  });
  const emotion = new EmotionTurns(store.emotion, store, options.background);
  const wires: Wire[] = [], requests: DialogueRequest[] = [], errors: string[] = [], jobs: Promise<unknown>[] = [];
  let response: unknown = assessment('sad', 'caring');
  const provider = new JsonDialogueProvider({ endpoint: 'https://synthetic.invalid/dialogue', model: 'synthetic-only', apiKey: () => 'synthetic-not-a-key', authorizer: { async authorize() { return { async settle() {} }; } } }, new ProviderTransport(async (_url, init) => {
    wires.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '我听着，你慢慢说。', expression: neutralExpression, ...(response === undefined ? {} : { emotionAssessment: response }) }) } }] });
  }));
  const ports: DialoguePorts = {
    outputMode: 'text', memory, emotion,
    backgroundMemory: {
      classifyRequest: async () => 'none' as const,
      enqueueTurn(scope, id, text) { const job = memory.prepareBackgroundTurn(scope, id, text, new AbortController().signal); jobs.push(job.catch(() => undefined)); return job; },
      foregroundContext(scope, id, text, perception, signal) { options.beforeContext?.(store, scope); return memory.foregroundContext(scope, id, text, perception, signal); }, assertContextCurrent: memory.assertContextCurrent.bind(memory), appendForegroundAssistant: memory.appendAssistant.bind(memory),
    },
    dialogue: { async reply(request, signal) { requests.push(request); return provider.reply(request, signal); } },
    perception: { async perceive() { throw Error('Text review must never call Omni'); } },
    tts: { async synthesize() { throw Error('Silent review must not synthesize'); } },
    playback: { async play() { throw Error('Silent review must not play'); }, async stop() {} },
    mediaStore: { async put() { throw Error('No media'); }, async read() { throw Error('No media'); }, async releaseScope() {} },
  };
  t.after(async () => { await emotion.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    store, storeOptions, memory, emotion, wires, requests, controller, jobs,
    async run(text: string, metadata: unknown = assessment('sad', 'caring')) {
      response = metadata; const turn = controller.begin('text', text);
      const result = await new DialoguePipeline(ports, controller, event => { if (event.type === 'error') errors.push(event.message); }).run(turn.input, turn.signal);
      assert.equal(result.status, 'replied', JSON.stringify({ result, errors }));
      return turn.input.scope;
    },
  };
}

test('S: pure text drives independent states, short follow-ups inherit and snapshots survive updates/restart', async t => {
  const f = fixture(t), first = await f.run('今天被批评了，心情糟透了。');
  await Promise.all(f.jobs);
  const original = JSON.stringify(f.store.emotion.message(first, `${first.turnId}:user`));
  const state = f.store.emotion.background(first);
  assert.equal(state.user.observation?.label, 'sad'); assert.equal(state.companion.observation?.label, 'caring');
  assert.equal(state.user.observation?.intensity, null); assert.equal(state.user.observation?.provenance, 'text_recent_context');
  const second = await f.run('嗯，然后呢？', assessment(null, null));
  await Promise.all(f.jobs);
  const secondData = JSON.parse(f.wires[1]!.messages.find(item => item.role === 'user')!.content);
  assert.equal(secondData.emotionBackground.user.observation.label, 'sad');
  assert.equal(secondData.emotionBackground.companion.observation.label, 'caring');
  assert.deepEqual(secondData.history.map((m: { role: string }) => m.role), ['user', 'assistant']);
  assert.ok(secondData.history.every((m: { emotionSnapshot?: unknown }) => m.emotionSnapshot), 'Recent historical messages keep their own emotional snapshots');
  assert.equal(f.store.emotion.background(second).user.revision, state.user.revision, 'No new observation is not neutral');
  assert.deepEqual(f.store.emotion.message(second, `${second.turnId}:user`)?.observations, []);
  assert.equal(JSON.stringify(f.store.emotion.message(first, `${first.turnId}:user`)), original);
  assert.equal(f.wires.length, 2, 'One normal dialogue request per turn, no extra classifier request');
  for (let i = 0; i < f.wires.length; i++) assert.ok(Buffer.byteLength(JSON.stringify(f.wires[i]!.messages)) <= contextInputUpperBound(f.requests[i]!.context, f.requests[i]!.text));
  await f.emotion.close(); f.store.close();
  const reopened = new SqliteMemoryStore(f.storeOptions);
  try { assert.deepEqual(reopened.emotion.background(second), state); assert.equal(JSON.stringify(reopened.emotion.message(first, `${first.turnId}:user`)), original); }
  finally { reopened.close(); }
});

test('S: malformed optional emotion metadata preserves the actual dialogue and prior states', async t => {
  const f = fixture(t), first = await f.run('事情让我心里很堵。'); await Promise.all(f.jobs);
  const before = f.store.emotion.background(first);
  const second = await f.run('继续说吧。', { user: { label: 'happy', intensity: 8, confidence: .8 }, companion: null }); await Promise.all(f.jobs);
  assert.deepEqual(f.store.emotion.background(second), before);
  assert.equal(f.store.inspect(second, `${second.turnId}:assistant`)?.text, '我听着，你慢慢说。');
  assert.equal(f.wires.length, 2);
});

test('S: stalled strict memory and optional inference never block replies; late inference cannot overwrite next turn', async t => {
  const memoryGate = deferred<MemoryTurnPlan>(), inferenceGate = deferred<EmotionAssessment>();
  let frozen: EmotionInferenceInput | undefined, firstMemory: MemoryTurnInput | undefined;
  const f = fixture(t, { plan: async input => { firstMemory ??= input; return input.currentMessageId === firstMemory.currentMessageId ? memoryGate.promise : none(input); }, background: { async infer(input) { frozen = structuredClone(input); return inferenceGate.promise; } } });
  t.after(() => { if (firstMemory) memoryGate.resolve(none(firstMemory)); inferenceGate.resolve({ user: null, companion: null }); });
  const first = await f.run('心里有点说不清的感觉。', assessment(null, null));
  assert.ok(frozen); assert.equal(f.store.inspect(first, `${first.turnId}:assistant`)?.message?.role, 'assistant');
  const second = await f.run('事情已经解决，我现在开心多了。', assessment('happy', 'calm'));
  const observation: EmotionObservation = { subject: 'user', label: 'sad', intensity: null, confidence: .5, provenance: 'text_recent_context', sources: [frozen!.ticket.message] };
  inferenceGate.resolve({ user: observation, companion: null });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.store.emotion.background(second).user.observation?.label, 'happy');
  assert.ok(!JSON.stringify(frozen).includes('事情已经解决'));
  memoryGate.resolve(none(firstMemory!)); await Promise.all(f.jobs);
});

test('S: same-turn text can refine weak visual emotion while explicit self-report wins and old-session capture cannot rewind state', async t => {
  const f = fixture(t);
  const make = (turnId: string, sessionId: string, text: string, label: string, provenance: EmotionObservation['provenance']) => {
    const scope: TurnScope = { characterId: 'companion', turnId, sessionId, generation: 1 }, message = { id: `${turnId}:user`, version: 1 };
    const observation: EmotionObservation = { subject: 'user', label, intensity: null, confidence: null, provenance, sources: [message] };
    return { scope, message, text, observation };
  };
  const a = make('visual', 'old', '这件事让我心里很难受。', 'neutral', 'video');
  await f.memory.append(a.scope, [{ characterId: 'companion', id: a.message.id, role: 'user', text: a.text, createdAt: NOW, emotionObservations: [a.observation] }]);
  const ticket = f.store.emotion.prepare(a.scope, a.message, [a.message]);
  const result = f.store.emotion.apply(ticket, { user: { ...a.observation, label: 'sad', provenance: 'text_recent_context' }, companion: null }, 'dialogue');
  assert.equal(f.store.emotion.background(a.scope).user.observation?.label, 'sad'); assert.ok(result.appliedSubjects.includes('user'));
  const b = make('explicit', 'new', '我现在很开心。', 'happy', 'user_explicit');
  await f.memory.append(b.scope, [{ characterId: 'companion', id: b.message.id, role: 'user', text: b.text, createdAt: NOW, emotionObservations: [b.observation] }]);
  const explicitTicket = f.store.emotion.prepare(b.scope, b.message, [b.message]);
  const explicitResult = f.store.emotion.apply(explicitTicket, { user: { ...b.observation, label: 'sad', provenance: 'text_recent_context' }, companion: null }, 'dialogue');
  assert.equal(f.store.emotion.background(b.scope).user.observation?.label, 'happy'); assert.ok(!explicitResult.appliedSubjects.includes('user'));
  try { f.store.emotion.captureMessage(a.scope, a.message, [a.observation]); } catch { /* Refusing replay is valid; state must still be current. */ }
  assert.equal(f.store.emotion.background(b.scope).user.observation?.label, 'happy');
});

test('S: corrected emotion evidence cannot remain in subsequent model context or management output', async t => {
  const f = fixture(t), first = await f.run('因为合成测试秘密，我心里很堵。'); await Promise.all(f.jobs);
  f.store.editRecord(first, { id: `${first.turnId}:user`, expectedVersion: 1, operationId: 'synthetic-correct-source', text: '这是一条已更正的普通消息。', reason: 'Explicit synthetic source correction' });
  const background = f.store.emotion.background(first);
  assert.equal(background.user.observation, null); assert.equal(background.companion.observation, null);
  const publicState = f.store.emotion.snapshot('companion', 0, 20);
  assert.ok(!JSON.stringify(publicState).includes('caring')); assert.ok(!JSON.stringify(publicState).includes('"label":"sad"'));
  await f.run('我们聊点别的。', assessment(null, null)); await Promise.all(f.jobs);
  assert.ok(!JSON.stringify(f.wires.at(-1)).includes('合成测试秘密'));
});

test('S: recent dialogue stays first when optional emotional metadata exceeds the remaining budget', async t => {
  const f = fixture(t), first = await f.run('今天心里挺堵的。'); await Promise.all(f.jobs);
  const turn = f.controller.begin('text', '接着刚才的话说。'), scope = turn.input.scope;
  await f.memory.append(scope, [{ characterId: 'companion', id: `${scope.turnId}:user`, role: 'user', text: turn.input.text!, createdAt: NOW }]);
  const normal = await f.memory.foregroundContext(scope, `${scope.turnId}:user`, turn.input.text!, null, turn.signal);
  const stripped: DialogueContext = { ...normal, recent: normal.recent.map(({ emotionSnapshot, ...message }) => message) };
  delete (stripped as { emotionBackground?: unknown }).emotionBackground;
  const budget = contextInputUpperBound(stripped, turn.input.text!);
  const limited = new SqliteLifecycleMemoryPort(f.store, {
    context: { inputTokenBudget: budget, maxRecentMessages: 12, maxMemories: 6, summaryLimit: 0, countTokens: contextInputUpperBound, relevance: () => 1 },
    turn: { inputTokenBudget: 30000, countTokens: input => JSON.stringify(input).length, provider: { plan: async input => none(input) } },
    summary: { minMessages: 100, maxMessages: 100, inputTokenBudget: 30000, countTokens: input => JSON.stringify(input).length, provider: { async summarize() { throw Error('Unused'); } } },
  });
  const actual = await limited.foregroundContext(scope, `${scope.turnId}:user`, turn.input.text!, null, turn.signal);
  assert.deepEqual(actual.recent.map(m => m.id), [`${first.turnId}:user`, `${first.turnId}:assistant`, `${scope.turnId}:user`]);
  assert.ok(contextInputUpperBound(actual, turn.input.text!) <= budget);
});

test('S: existing batch append remains atomic and captures snapshots in message order', async t => {
  const f = fixture(t), scope: TurnScope = { characterId: 'companion', sessionId: 'batch', turnId: 'batch', generation: 1 };
  const messages = ['one', 'two'].map(id => ({ characterId: 'companion' as const, id, role: 'user' as const, text: `合成消息 ${id}`, createdAt: NOW }));
  await f.memory.append(scope, messages);
  for (const message of messages) assert.ok(f.store.emotion.message(scope, message.id));
  await assert.rejects(f.memory.append(scope, [{ ...messages[0]!, id: 'three' }, messages[0]!]));
  assert.equal(f.store.inspect(scope, 'three'), null, 'A failed batch leaves no partial message');
});

for (const kind of ['memory', 'summary'] as const) test(`S: injected ${kind} outside recent history stays a privacy dependency even when derived after current input`, async t => {
  let inserted = false;
  const f = fixture(t, { beforeContext(store, scope) {
    if (inserted) return; inserted = true;
    if (kind === 'memory') store.apply({ scope, operationId: 'derive-memory', reason: 'Synthetic old-source derivation', createdAt: NOW, operation: { type: 'add', id: 'derived-review', text: '海边', sourceIds: ['old-source'] } });
    else store.recordDerived(scope, { id: 'derived-review', kind: 'summary', text: '海边的合成经历', sourceIds: ['old-source'], createdAt: NOW });
  } });
  const seed: TurnScope = { characterId: 'companion', sessionId: 'seed', turnId: 'seed', generation: 1 };
  await f.memory.append(seed, [{ characterId: 'companion', id: 'old-source', role: 'user', text: '海边的合成经历', createdAt: NOW },
    ...Array.from({ length: 14 }, (_, i) => ({ characterId: 'companion' as const, id: `filler-${i}`, role: 'user' as const, text: `普通占位 ${i}`, createdAt: NOW }))]);
  const current = await f.run('海边', assessment('sad', 'caring')); await Promise.all(f.jobs);
  const context = f.requests[0]!.context;
  assert.ok(!context.recent.some(m => m.id === 'old-source'), 'The dependency is not accidentally protected through recent history');
  if (kind === 'memory') assert.ok(context.memories.some(m => m.id === 'derived-review'));
  else assert.match(context.summary, /海边的合成经历/);
  assert.ok(f.store.inspect(current, 'derived-review')!.logicalOrder! > f.store.inspect(current, `${current.turnId}:user`)!.logicalOrder!);
  assert.equal(f.store.emotion.background(current).user.observation?.label, 'sad', 'A derived source from old evidence must not disable current text inference');
  f.store.editRecord(current, { id: 'derived-review', expectedVersion: 1, operationId: 'correct-derived', text: '人工更正后的普通内容', reason: 'Synthetic source correction' });
  assert.equal(f.store.emotion.background(current).user.observation, null);
  assert.equal(f.store.emotion.background(current).companion.observation, null);
  assert.ok(!JSON.stringify(f.store.emotion.snapshot('companion', 0, 20)).includes('"label":"sad"'));
});
