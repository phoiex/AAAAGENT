import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { EmotionAssessment, EmotionObservation } from '../../contracts/emotion-state.js';
import type { SourceVersion } from '../../contracts/memory-lifecycle.js';
import { SqliteEmotionState } from '../../memory/emotion-state.js';
import { SqliteMemoryRecall } from '../../memory/sqlite-recall.js';
import type { SqliteMemoryStore } from '../../memory/sqlite-store.js';
import { change, fixture, message, NOW, scope } from './sqlite-fixture.js';

const setup = () => fixture(undefined, 'emotion-state-51');
const ref = (store: SqliteMemoryStore, id: string): SourceVersion => {
  const record = store.inspect(scope(), id)!;
  return { id: record.id, version: record.version };
};
const append = (store: SqliteMemoryStore, id: string, text = id, turnId = id,
  observations?: (source: SourceVersion) => readonly EmotionObservation[]): { owned: ReturnType<typeof scope>; source: SourceVersion } => {
  const owned = scope('companion', turnId);
  const source = { id, version: 1 };
  const emotionObservations = observations?.(source);
  store.append(owned, [{ ...message(id, text), ...(emotionObservations ? { emotionObservations } : {}) }]);
  return { owned, source: ref(store, id) };
};
const observation = (source: SourceVersion, overrides: Partial<EmotionObservation> = {}): EmotionObservation => ({
  subject: 'user', label: '开心', intensity: 0.8, confidence: 0.9,
  provenance: 'user_explicit', sources: [source], ...overrides,
});
const openEmotion = (f: ReturnType<typeof setup>, store: SqliteMemoryStore) => {
  const db = f.track(new Database(f.filename));
  return { db, emotions: new SqliteEmotionState(db, store) };
};

test('additive component is idempotent, does not backfill, and survives restart', t => {
  const f = setup(); t.after(f.cleanup);
  let store = f.open();
  const legacy = append(store, 'legacy');
  let database = f.track(new Database(f.filename));
  database.exec('DROP TABLE emotion_analysis; DROP TABLE emotion_ticket; DROP TABLE emotion_message_snapshot; DROP TABLE emotion_sustained_state; DROP TABLE emotion_state_component;');
  let opened = { db: database, emotions: new SqliteEmotionState(database, store) };
  assert.equal(opened.emotions.message(legacy.owned, legacy.source.id), null);

  const current = append(store, 'current', 'current', 'current', source => [observation(source)]);
  const memoryRevision = store.revision(current.owned);
  const frozen = opened.emotions.message(current.owned, current.source.id)!;
  assert.equal(store.revision(current.owned), memoryRevision);
  assert.deepEqual(opened.emotions.captureMessage(current.owned, current.source, [observation(current.source)]), frozen);
  assert.throws(() => opened.emotions.captureMessage(current.owned, current.source, [observation(current.source, { label: '难过' })]), /message_snapshot_mismatch/);
  opened.db.close(); store.close();

  store = f.open(); opened = openEmotion(f, store);
  assert.equal(opened.emotions.background(scope('companion', 'different-turn')).user.observation?.label, '开心');
  assert.equal(opened.emotions.background({ ...scope(), sessionId: 'new-session' }).user.observation?.label, '开心');
  assert.deepEqual(opened.emotions.message(current.owned, current.source.id), frozen);
  assert.deepEqual(opened.emotions.message(scope('companion', 'later-context'), current.source.id), frozen);
});

test('nullable modality intensity, immutable snapshots, and independent U/M CAS are enforced', t => {
  const f = setup(); t.after(f.cleanup); const store = f.open();
  const { db, emotions } = openEmotion(f, store);
  const current = append(store, 'audio-user', 'audio-user', 'audio-user', source => [observation(source, { provenance: 'audio', intensity: null })]);
  assert.equal(emotions.message(current.owned, current.source.id)!.observations[0]!.intensity, null);
  assert.throws(() => append(store, 'bad-audio', 'bad-audio', 'bad-audio', source => [observation(source, { provenance: 'audio', intensity: 0.4 })]), /modality_intensity_must_be_null/);
  assert.equal(store.inspect(scope('companion', 'bad-audio'), 'bad-audio'), null);

  const target = append(store, 'cas-user');
  const userTicket = emotions.prepare(target.owned, target.source, [target.source]);
  const ticket = emotions.prepare(target.owned, target.source, [target.source]);
  assert.deepEqual(emotions.apply(userTicket, { user: observation(target.source, { label: '平静' }), companion: null }, 'dialogue').appliedSubjects, ['user']);
  const result = emotions.apply(ticket, {
    user: observation(target.source, { label: '焦虑' }),
    companion: observation(target.source, { subject: 'companion', label: '关心', provenance: 'companion_inference' }),
  }, 'background');
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.appliedSubjects, ['companion']);
  assert.equal(result.assessment?.user, null);
  assert.equal(result.assessment?.companion?.label, '关心');
  assert.equal(emotions.background(target.owned).user.observation?.label, '平静');
  assert.equal(emotions.background(target.owned).companion.observation?.label, '关心');
  assert.equal(emotions.message(target.owned, target.source.id)!.background.companion.observation, null);

  const corrected = append(store, 'corrected', 'corrected', 'corrected', source => [observation(source, { label: '平静', provenance: 'video', intensity: null })]);
  const correctionTicket = emotions.prepare(corrected.owned, corrected.source, [corrected.source]);
  const correction = emotions.apply(correctionTicket, { user: observation(corrected.source, { label: '难过', provenance: 'text_recent_context' }), companion: null }, 'dialogue');
  assert.deepEqual(correction.appliedSubjects, ['user']);
  assert.equal(emotions.background(corrected.owned).user.observation?.label, '难过');
  assert.equal(emotions.message(corrected.owned, corrected.source.id)!.background.user.observation?.label, '平静');

  const explicit = append(store, 'explicit', 'explicit', 'explicit', source => [observation(source, { label: '开心', provenance: 'user_explicit' })]);
  const explicitTicket = emotions.prepare(explicit.owned, explicit.source, [explicit.source]);
  const weaker = emotions.apply(explicitTicket, { user: observation(explicit.source, { label: '难过', provenance: 'text_recent_context' }), companion: null }, 'dialogue');
  assert.equal(weaker.status, 'stale'); assert.deepEqual(weaker.appliedSubjects, []);
  assert.equal(emotions.background(explicit.owned).user.observation?.label, '开心');
});

test('late, future, cancelled, and cross-session results cannot overwrite current state', t => {
  const f = setup(); t.after(f.cleanup); const store = f.open();
  const { db, emotions } = openEmotion(f, store);
  const first = append(store, 'first');
  const ticket = emotions.prepare(first.owned, first.source, [first.source]);
  const second = append(store, 'second', 'second', 'second', source => [observation(source, { label: '开心' })]);
  assert.throws(() => emotions.prepare(first.owned, first.source, [first.source, second.source]), /emotion_target_not_current|emotion_source_from_future/);
  const late = emotions.apply(ticket, { user: observation(first.source, { label: '难过' }), companion: null }, 'background');
  assert.equal(late.status, 'stale'); assert.equal(late.assessment, null);
  assert.equal(emotions.background(second.owned).user.observation?.label, '开心');

  const third = append(store, 'third');
  const cancelled = emotions.prepare(third.owned, third.source, [third.source]); emotions.cancel(third.owned);
  assert.equal(emotions.apply(cancelled, { user: observation(third.source), companion: null }, 'background').status, 'cancelled');

  const oldSession = { ...third.owned, sessionId: 'old-session' };
  assert.throws(() => emotions.captureMessage(oldSession, third.source, []), /message_snapshot_mismatch/);
});

test('derived evidence uses transcript lineage cutoff rather than derived creation order', t => {
  const f = setup(); t.after(f.cleanup); const store = f.open();
  const { db, emotions } = openEmotion(f, store);
  const historical = append(store, 'historical-user');
  const target = append(store, 'lineage-target');
  store.apply(change({ type: 'add', id: 'late-memory', text: '旧经历的长期记忆', sourceIds: [historical.source.id] }, 'late-memory', target.owned));
  store.recordDerived(target.owned, { id: 'late-summary', kind: 'summary', text: '旧经历摘要', sourceIds: [historical.source.id], createdAt: NOW });
  const lateMemory = ref(store, 'late-memory');
  const lateSummary = ref(store, 'late-summary');
  const ticket = emotions.prepare(target.owned, target.source, [target.source, lateMemory, lateSummary]);
  assert.deepEqual(ticket.evidence, [target.source, lateMemory, lateSummary]);
  const applied = emotions.apply(ticket, { user: observation(target.source, { label: '安心' }), companion: null }, 'background');
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.appliedSubjects, ['user']);
  assert.equal(emotions.background(target.owned).user.observation?.label, '安心');

  const future = append(store, 'future-user');
  store.apply(change({ type: 'add', id: 'future-memory', text: '不应进入旧轮的未来内容', sourceIds: [future.source.id] }, 'future-memory', target.owned));
  // Simulate a retired raw source while leaving a corrupt active descendant, so
  // the lineage guard itself must enforce the historical cutoff.
  db.prepare("UPDATE memory_records SET state='expired' WHERE character_id='companion' AND id=?").run(future.source.id);
  assert.throws(() => emotions.prepare(target.owned, target.source, [target.source, ref(store, 'future-memory')]), /emotion_source_from_future/);
});

test('forgetting and expiry remove snapshots, analyses, tickets, and inherited state references', t => {
  const f = setup(); t.after(f.cleanup); const store = f.open();
  const { db, emotions } = openEmotion(f, store);
  const current = append(store, 'private', '私密经历', 'private', source => [observation(source, { label: '难过' })]);
  const ticket = emotions.prepare(current.owned, current.source, [current.source]);
  store.apply(change({ type: 'add', id: 'private-memory', text: '私密经历', sourceIds: [current.source.id] }, 'add-private', current.owned));
  assert.equal(store.apply(change({ type: 'soft_delete', id: 'private-memory', expectedVersion: 1 }, 'forget-private', current.owned), [current.source.id]).status, 'applied');
  emotions.invalidate();
  assert.equal(emotions.message(current.owned, current.source.id), null);
  assert.equal(emotions.background(current.owned).user.observation, null);
  assert.equal(emotions.snapshot('companion', 0, 20).total, 0);
  assert.equal(emotions.apply(ticket, { user: observation(current.source), companion: null }, 'background').status, 'invalid');
  const scrubbed = db.prepare('SELECT evidence_json,background_json,privacy_sources_json FROM emotion_ticket WHERE id=?').get(ticket.id) as Record<string, string>;
  assert.deepEqual(scrubbed, { evidence_json: '[]', background_json: '{}', privacy_sources_json: '[]' });

  const expiring = append(store, 'expiring', '会过期的原文', 'expiring', source => [observation(source, { label: '平静' })]);
  f.setTime('2026-10-06T12:00:00.000Z'); store.cleanup(); emotions.invalidate();
  assert.equal(emotions.message(expiring.owned, expiring.source.id), null);
  assert.equal(emotions.background(expiring.owned).user.observation, null);
});

test('emotion affinity only breaks an exactly equal recall priority tie', t => {
  const f = setup(); t.after(f.cleanup); const store = f.open();
  const { db, emotions } = openEmotion(f, store);
  const warm = append(store, 'warm-source', '用户说自己开心', 'warm-source', source => [observation(source)]);
  const cold = append(store, 'cold-source', '普通来源');
  store.apply(change({ type: 'add', id: 'warm-parent', text: '情绪来源', sourceIds: [warm.source.id] }, 'add-warm-parent'));
  store.apply(change({ type: 'add', id: 'z-warm', text: '红茶', sourceIds: ['warm-parent'] }, 'add-warm'));
  store.apply(change({ type: 'add', id: 'a-cold', text: '红茶', sourceIds: [cold.source.id] }, 'add-cold'));
  const ranked = new SqliteMemoryRecall(db, store, emotions).rank(scope(), '红茶');
  const warmCandidate = ranked.find(item => item.source.id === 'z-warm')!;
  const coldCandidate = ranked.find(item => item.source.id === 'a-cold')!;
  assert.equal(warmCandidate.priority, coldCandidate.priority);
  assert.equal(warmCandidate.emotionAffinity, 1); assert.equal(coldCandidate.emotionAffinity, 0);
  assert.ok(ranked.indexOf(warmCandidate) < ranked.indexOf(coldCandidate));
});

test('management pagination only returns analyses for the visible message page', t => {
  const f = setup(); t.after(f.cleanup); const store = f.open();
  const { db, emotions } = openEmotion(f, store);
  const first = append(store, 'page-one');
  const firstTicket = emotions.prepare(first.owned, first.source, [first.source]);
  const firstResult = emotions.apply(firstTicket, { user: null, companion: null } satisfies EmotionAssessment, 'dialogue');
  assert.equal(firstResult.status, 'applied');
  const second = append(store, 'page-two');
  const page = emotions.snapshot('companion', 0, 1);
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0]!.message.id, second.source.id);
  assert.deepEqual(page.analyses, []); assert.equal(page.total, 2);
});
