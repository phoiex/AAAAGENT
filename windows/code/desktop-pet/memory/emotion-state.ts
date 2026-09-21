import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { CharacterId, TurnScope } from '../contracts/index.js';
import type {
  EmotionAnalysis, EmotionAssessment, EmotionBackground, EmotionMessageSnapshot,
  EmotionObservation, EmotionStatePort, EmotionStateSnapshot, EmotionSubject,
  EmotionTicket, SustainedEmotion,
} from '../contracts/emotion-state.js';
import type { SourceVersion } from '../contracts/memory-lifecycle.js';
import type { MemoryRecord } from './ledger.js';
import type { SqliteMemoryStore } from './sqlite-store.js';
import { bindScope, MemoryRuleError, timestamp } from './scope.js';

const COMPONENT_VERSION = 1;
const MAX_LABEL_LENGTH = 80;
const clone = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const parse = <T>(value: string): T => JSON.parse(value) as T;
const refs = (items: readonly SourceVersion[]): SourceVersion[] => {
  const result = new Map<string, SourceVersion>();
  for (const item of items) {
    const previous = result.get(item.id);
    if (previous && previous.version !== item.version) throw new MemoryRuleError('conflicting_source_versions');
    result.set(item.id, { id: item.id, version: item.version });
  }
  return [...result.values()];
};
const emptyAssessment = (): EmotionAssessment => ({ user: null, companion: null });

interface StateRow {
  character_id: CharacterId;
  subject: EmotionSubject;
  revision: number;
  observation_json: string | null;
  updated_at: string | null;
  source_message_id: string | null;
  source_message_version: number | null;
  logical_order: number | null;
  session_id: string | null;
  sources_json: string;
}
interface MessageRow {
  character_id: CharacterId;
  message_id: string;
  message_version: number;
  role: 'user' | 'assistant';
  scope_json: string;
  logical_order: number;
  recorded_at: string;
  payload_json: string;
  sources_json: string;
  signature: string;
  status: 'active' | 'invalidated';
}
interface TicketRow {
  id: string;
  character_id: CharacterId;
  scope_json: string;
  message_id: string;
  message_version: number;
  logical_order: number;
  evidence_json: string;
  background_json: string;
  privacy_sources_json: string;
  user_revision: number;
  companion_revision: number;
  status: 'pending' | 'applied' | 'stale' | 'cancelled' | 'invalid';
  created_at: string;
}
interface AnalysisRow {
  id: string;
  character_id: CharacterId;
  message_id: string;
  message_version: number;
  scope_json: string;
  completed_at: string;
  origin: EmotionAnalysis['origin'];
  assessment_json: string | null;
  applied_subjects_json: string;
  status: EmotionAnalysis['status'];
  sources_json: string;
  signature: string;
}

export class SqliteEmotionState implements EmotionStatePort {
  constructor(private readonly db: Database.Database, private readonly store: SqliteMemoryStore) {
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS emotion_state_component(
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS emotion_sustained_state(
          character_id TEXT NOT NULL, subject TEXT NOT NULL CHECK(subject IN ('user','companion')),
          revision INTEGER NOT NULL, observation_json TEXT, updated_at TEXT,
          source_message_id TEXT, source_message_version INTEGER, logical_order INTEGER, session_id TEXT,
          sources_json TEXT NOT NULL, PRIMARY KEY(character_id,subject)
        );
        CREATE TABLE IF NOT EXISTS emotion_message_snapshot(
          character_id TEXT NOT NULL, message_id TEXT NOT NULL, message_version INTEGER NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')), scope_json TEXT NOT NULL,
          logical_order INTEGER NOT NULL, recorded_at TEXT NOT NULL, payload_json TEXT NOT NULL,
          sources_json TEXT NOT NULL, signature TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','invalidated')),
          PRIMARY KEY(character_id,message_id)
        );
        CREATE TABLE IF NOT EXISTS emotion_ticket(
          id TEXT PRIMARY KEY, character_id TEXT NOT NULL, scope_json TEXT NOT NULL,
          message_id TEXT NOT NULL, message_version INTEGER NOT NULL, logical_order INTEGER NOT NULL,
          evidence_json TEXT NOT NULL, background_json TEXT NOT NULL, privacy_sources_json TEXT NOT NULL,
          user_revision INTEGER NOT NULL, companion_revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','applied','stale','cancelled','invalid')),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS emotion_analysis(
          id TEXT PRIMARY KEY, character_id TEXT NOT NULL, message_id TEXT NOT NULL,
          message_version INTEGER NOT NULL, scope_json TEXT NOT NULL, completed_at TEXT NOT NULL,
          origin TEXT NOT NULL CHECK(origin IN ('dialogue','background')), assessment_json TEXT,
          applied_subjects_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('applied','stale','cancelled','invalid')),
          sources_json TEXT NOT NULL, signature TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS emotion_message_page ON emotion_message_snapshot(character_id,status,logical_order DESC);
        CREATE INDEX IF NOT EXISTS emotion_ticket_pending ON emotion_ticket(character_id,status);
        CREATE INDEX IF NOT EXISTS emotion_analysis_message ON emotion_analysis(character_id,message_id);
      `);
      const component = this.db.prepare('SELECT version FROM emotion_state_component WHERE singleton=1').get() as { version: number } | undefined;
      if (component && component.version !== COMPONENT_VERSION) throw new Error('emotion_component_version_mismatch');
      const ticketColumns = this.db.pragma('table_info(emotion_ticket)') as { name: string }[];
      if (!ticketColumns.some(column => column.name === 'privacy_sources_json')) this.db.exec("ALTER TABLE emotion_ticket ADD COLUMN privacy_sources_json TEXT NOT NULL DEFAULT '[]'");
      this.db.prepare('INSERT OR IGNORE INTO emotion_state_component VALUES(1,?,0)').run(COMPONENT_VERSION);
      for (const subject of ['user', 'companion'] as const) {
        this.db.prepare('INSERT OR IGNORE INTO emotion_sustained_state VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run('companion', subject, 0, null, null, null, null, null, null, '[]');
      }
    }).immediate();
  }

  captureMessage(scope: TurnScope, message: SourceVersion, observations: readonly EmotionObservation[]): EmotionMessageSnapshot {
    const owned = bindScope(scope, scope.characterId);
    return this.db.transaction(() => {
      const target = this.targetMessage(owned, message);
      if (this.hasLaterTranscript(owned.characterId, target.logicalOrder!)) throw new MemoryRuleError('emotion_target_not_current');
      const normalized = observations.map(observation => this.observation(owned, target, observation));
      const signature = digest({ scope: owned, message, observations: normalized });
      const prior = this.db.prepare('SELECT * FROM emotion_message_snapshot WHERE character_id=? AND message_id=?').get(owned.characterId, message.id) as MessageRow | undefined;
      if (prior) {
        if (prior.signature !== signature || prior.message_version !== message.version) throw new MemoryRuleError('message_snapshot_mismatch');
        const restored = this.readMessage(prior);
        if (!restored) throw new MemoryRuleError('message_snapshot_invalidated');
        return restored;
      }
      if (target.message!.role === 'assistant' && normalized.some(item => item.subject === 'user')) throw new MemoryRuleError('assistant_message_cannot_observe_user');
      if (target.message!.role === 'user') {
        const direct = normalized.filter(item => item.subject === 'user')
          .sort((a, b) => this.directRank(b.provenance) - this.directRank(a.provenance))[0];
        if (direct) this.updateState(owned, target, direct);
      }
      const companion = normalized.find(item => item.subject === 'companion');
      if (companion) this.updateState(owned, target, companion);
      const background = this.background(owned);
      const snapshot: EmotionMessageSnapshot = {
        role: target.message!.role,
        message: { id: target.id, version: target.version },
        scope: owned,
        logicalOrder: target.logicalOrder!,
        recordedAt: this.store.now(),
        observations: normalized,
        background,
      };
      const sources = this.snapshotSources(snapshot);
      this.db.prepare('INSERT INTO emotion_message_snapshot VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        owned.characterId, target.id, target.version, target.message!.role, JSON.stringify(owned), target.logicalOrder,
        snapshot.recordedAt, JSON.stringify(snapshot), JSON.stringify(sources), signature, 'active',
      );
      this.bump();
      return clone(snapshot);
    })();
  }

  background(scope: TurnScope): EmotionBackground {
    const owned = bindScope(scope, scope.characterId);
    return {
      user: this.exposedState(owned, this.state(owned.characterId, 'user')),
      companion: this.exposedState(owned, this.state(owned.characterId, 'companion')),
    };
  }

  message(scope: TurnScope, messageId: string): EmotionMessageSnapshot | null {
    const owned = bindScope(scope, scope.characterId);
    const row = this.db.prepare('SELECT * FROM emotion_message_snapshot WHERE character_id=? AND message_id=?').get(owned.characterId, messageId) as MessageRow | undefined;
    if (!row) return null;
    return this.readMessage(row);
  }

  prepare(scope: TurnScope, message: SourceVersion, evidence: readonly SourceVersion[]): EmotionTicket {
    const owned = bindScope(scope, scope.characterId);
    return this.db.transaction(() => {
      const target = this.targetMessage(owned, message);
      if (target.message!.role !== 'user') throw new MemoryRuleError('emotion_ticket_requires_user_message');
      if (this.hasLaterTranscript(owned.characterId, target.logicalOrder!)) throw new MemoryRuleError('emotion_target_not_current');
      const frozenEvidence = refs(evidence);
      if (!frozenEvidence.some(ref => ref.id === message.id && ref.version === message.version)) throw new MemoryRuleError('ticket_missing_current_message');
      for (const ref of frozenEvidence) this.source(owned, ref, target.logicalOrder);
      const background = this.background(owned);
      const ticket: EmotionTicket = {
        id: randomUUID(), scope: owned, message: clone(message), logicalOrder: target.logicalOrder!,
        evidence: frozenEvidence, background,
        userRevision: background.user.revision, companionRevision: background.companion.revision,
      };
      const privacySources = refs([...frozenEvidence, ...this.backgroundSources(background)]);
      this.db.prepare(`INSERT INTO emotion_ticket(id,character_id,scope_json,message_id,message_version,logical_order,evidence_json,background_json,
        privacy_sources_json,user_revision,companion_revision,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        ticket.id, owned.characterId, JSON.stringify(owned), message.id, message.version, ticket.logicalOrder,
        JSON.stringify(frozenEvidence), JSON.stringify(background), JSON.stringify(privacySources),
        ticket.userRevision, ticket.companionRevision, 'pending', this.store.now(),
      );
      this.bump();
      return clone(ticket);
    })();
  }

  apply(ticket: EmotionTicket, assessment: EmotionAssessment, origin: EmotionAnalysis['origin']): EmotionAnalysis {
    const signature = digest({ ticket, assessment, origin });
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM emotion_analysis WHERE id=?').get(ticket.id) as AnalysisRow | undefined;
      if (existing) {
        if (existing.signature !== signature) throw new MemoryRuleError('operation_id_payload_mismatch');
        return this.analysis(existing);
      }
      const row = this.db.prepare('SELECT * FROM emotion_ticket WHERE id=?').get(ticket.id) as TicketRow | undefined;
      if (!row) return this.saveInvalidAnalysis(ticket, origin, signature);
      if (row.status === 'invalid') return this.saveInvalidAnalysis(ticket, origin, signature);
      const stored = this.ticket(row);
      if (canonical(stored) !== canonical(ticket)) throw new MemoryRuleError('emotion_ticket_mismatch');
      const scope = stored.scope;
      let status: EmotionAnalysis['status'] = row.status === 'cancelled' ? 'cancelled' : row.status === 'pending' ? 'applied' : 'invalid';
      let normalized: EmotionAssessment | null = emptyAssessment();
      try {
        if (!this.sourcesValid(scope, parse<SourceVersion[]>(row.privacy_sources_json))) throw new MemoryRuleError('emotion_source_unavailable');
        const target = this.targetMessage(scope, stored.message);
        for (const ref of stored.evidence) this.source(scope, ref, stored.logicalOrder);
        if (target.logicalOrder !== stored.logicalOrder) status = 'invalid';
        const later = this.db.prepare("SELECT 1 FROM memory_records WHERE character_id=? AND kind='transcript' AND state='active' AND message_role='user' AND logical_order>? LIMIT 1")
          .get(scope.characterId, stored.logicalOrder);
        if (status === 'applied' && later) status = 'stale';
        normalized = {
          user: assessment.user ? this.observation(scope, target, assessment.user, stored.evidence) : null,
          companion: assessment.companion ? this.observation(scope, target, assessment.companion, stored.evidence) : null,
        };
      } catch (error) {
        if (!(error instanceof MemoryRuleError)) throw error;
        status = 'invalid'; normalized = null;
      }
      const currentUser = this.state(scope.characterId, 'user');
      const currentCompanion = this.state(scope.characterId, 'companion');
      const eligible: EmotionSubject[] = [];
      if (status === 'applied' && normalized?.user && currentUser.revision === stored.userRevision) eligible.push('user');
      if (status === 'applied' && normalized?.companion && currentCompanion.revision === stored.companionRevision) eligible.push('companion');
      const applied: EmotionSubject[] = [];
      if (status === 'applied' && normalized) {
        const target = this.targetMessage(scope, stored.message);
        if (eligible.includes('user') && this.updateState(scope, target, normalized.user!, true)) applied.push('user');
        if (eligible.includes('companion') && this.updateState(scope, target, normalized.companion!, true)) applied.push('companion');
      }
      if (status === 'applied' && (normalized?.user || normalized?.companion) && applied.length === 0) status = 'stale';
      const visibleAssessment = status === 'applied' && normalized ? {
        user: applied.includes('user') ? normalized.user : null,
        companion: applied.includes('companion') ? normalized.companion : null,
      } : null;
      const completedAt = this.store.now(); timestamp(completedAt);
      const sources = visibleAssessment ? refs([...stored.evidence, ...this.assessmentSources(visibleAssessment)]) : [];
      this.db.prepare('UPDATE emotion_ticket SET status=? WHERE id=?').run(status, stored.id);
      this.db.prepare('INSERT INTO emotion_analysis VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
        stored.id, scope.characterId, stored.message.id, stored.message.version, JSON.stringify(scope), completedAt,
        origin, visibleAssessment ? JSON.stringify(visibleAssessment) : null, JSON.stringify(applied), status, JSON.stringify(sources), signature,
      );
      this.bump();
      return {
        id: stored.id, message: stored.message, scope, completedAt, origin,
        assessment: visibleAssessment, appliedSubjects: applied, status,
      };
    })();
  }

  cancel(scope: TurnScope): void {
    const owned = bindScope(scope, scope.characterId);
    const result = this.db.prepare("UPDATE emotion_ticket SET status='cancelled' WHERE character_id=? AND status='pending' AND scope_json=?")
      .run(owned.characterId, JSON.stringify(owned));
    if (result.changes) this.bump();
  }

  snapshot(characterId: CharacterId, offset: number, limit: number): EmotionStateSnapshot {
    const scope = bindScope({ characterId, sessionId: 'emotion-management', turnId: 'read', generation: 0 }, characterId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new MemoryRuleError('invalid_management_request');
    const valid = (this.db.prepare("SELECT * FROM emotion_message_snapshot WHERE character_id=? AND status='active' ORDER BY logical_order DESC,message_id").all(characterId) as MessageRow[])
      .map(row => this.readMessage(row)).filter((item): item is EmotionMessageSnapshot => item !== null);
    const messages = valid.slice(offset, offset + limit);
    const ids = new Set(messages.map(item => item.message.id));
    const analyses = (this.db.prepare('SELECT * FROM emotion_analysis WHERE character_id=? ORDER BY rowid DESC').all(characterId) as AnalysisRow[])
      .filter(row => ids.has(row.message_id)).map(row => this.analysis(row));
    const pending = (this.db.prepare("SELECT * FROM emotion_ticket WHERE character_id=? AND status='pending'").all(characterId) as TicketRow[])
      .filter(row => this.sourcesValid(scope, parse<SourceVersion[]>(row.privacy_sources_json))).length;
    return {
      characterId,
      revision: (this.db.prepare('SELECT revision FROM emotion_state_component WHERE singleton=1').get() as { revision: number }).revision,
      pending, messages, analyses, total: valid.length, offset, limit,
      user: this.publicState(this.state(characterId, 'user')),
      companion: this.publicState(this.state(characterId, 'companion')),
    };
  }

  invalidate(): void {
    this.db.transaction(() => {
      let changed = false;
      const management = bindScope({ characterId: 'companion', sessionId: 'emotion-management', turnId: 'invalidate', generation: 0 }, 'companion');
      for (const row of this.db.prepare("SELECT * FROM emotion_message_snapshot WHERE status='active'").all() as MessageRow[]) {
        if (!this.sourcesValid(management, parse<SourceVersion[]>(row.sources_json))) {
          this.db.prepare("UPDATE emotion_message_snapshot SET status='invalidated',payload_json='{}',sources_json='[]' WHERE character_id=? AND message_id=?")
            .run(row.character_id, row.message_id); changed = true;
        }
      }
      for (const row of this.db.prepare("SELECT * FROM emotion_ticket WHERE privacy_sources_json!='[]'").all() as TicketRow[]) {
        if (!this.sourcesValid(management, parse<SourceVersion[]>(row.privacy_sources_json))) {
          this.db.prepare("UPDATE emotion_ticket SET status='invalid',evidence_json='[]',background_json='{}',privacy_sources_json='[]' WHERE id=?").run(row.id); changed = true;
        }
      }
      for (const row of this.db.prepare("SELECT * FROM emotion_analysis WHERE status!='invalid'").all() as AnalysisRow[]) {
        if (!this.sourcesValid(management, parse<SourceVersion[]>(row.sources_json))) {
          this.db.prepare("UPDATE emotion_analysis SET status='invalid',assessment_json=NULL,applied_subjects_json='[]',sources_json='[]' WHERE id=?").run(row.id); changed = true;
        }
      }
      for (const row of this.db.prepare('SELECT * FROM emotion_sustained_state').all() as StateRow[]) {
        if (row.observation_json && !this.sourcesValid(management, parse<SourceVersion[]>(row.sources_json))) {
          this.db.prepare('UPDATE emotion_sustained_state SET revision=revision+1,observation_json=NULL,updated_at=NULL,source_message_id=NULL,source_message_version=NULL,logical_order=NULL,session_id=NULL,sources_json=\'[]\' WHERE character_id=? AND subject=?')
            .run(row.character_id, row.subject); changed = true;
        }
      }
      if (changed) this.bump();
    })();
  }

  affinity(scope: TurnScope, sources: readonly SourceVersion[]): number {
    const owned = bindScope(scope, scope.characterId);
    const current = this.background(owned).user.observation;
    if (!current) return 0;
    const candidate = new Set(sources.map(ref => `${ref.id}\0${ref.version}`));
    const matching = (observation: EmotionObservation): boolean => observation.subject === 'user'
      && observation.label.toLocaleLowerCase() === current.label.toLocaleLowerCase()
      && observation.sources.some(ref => candidate.has(`${ref.id}\0${ref.version}`));
    for (const row of this.db.prepare("SELECT * FROM emotion_message_snapshot WHERE character_id=? AND status='active'").all(owned.characterId) as MessageRow[]) {
      const snapshot = this.readMessage(row);
      if (snapshot?.observations.some(matching)) return 1;
    }
    for (const row of this.db.prepare("SELECT * FROM emotion_analysis WHERE character_id=? AND status='applied'").all(owned.characterId) as AnalysisRow[]) {
      const analysis = this.analysis(row);
      if (analysis.assessment?.user && this.sourcesValid(owned, parse<SourceVersion[]>(row.sources_json)) && matching(analysis.assessment.user)) return 1;
    }
    return 0;
  }

  private directRank(provenance: EmotionObservation['provenance']): number {
    return provenance === 'user_explicit' ? 4 : provenance === 'audio' ? 3 : provenance === 'text_recent_context' ? 2 : provenance === 'video' ? 1 : 0;
  }

  private source(scope: TurnScope, ref: SourceVersion, maxOrder?: number): MemoryRecord {
    if (!ref.id || !Number.isSafeInteger(ref.version) || ref.version < 1) throw new MemoryRuleError('invalid_source_version');
    const record = this.store.inspect(scope, ref.id);
    if (!record || record.state !== 'active' || record.version !== ref.version) throw new MemoryRuleError('emotion_source_unavailable');
    if (maxOrder !== undefined) this.assertLineageCutoff(scope, record, maxOrder, new Set());
    return record;
  }

  private assertLineageCutoff(scope: TurnScope, record: MemoryRecord, maxOrder: number, visiting: Set<string>): void {
    const order = (): void => {
      if (!Number.isSafeInteger(record.logicalOrder) || record.logicalOrder! > maxOrder) throw new MemoryRuleError('emotion_source_from_future');
    };
    if (record.kind === 'transcript') { order(); return; }
    const key = `${record.id}\0${record.version}`;
    if (visiting.has(key)) throw new MemoryRuleError('emotion_source_cycle');
    visiting.add(key);
    let followed = false;
    for (const ref of record.sources) {
      // An update may retain its own previous version as opaque provenance. Its
      // original logical order remains the only safe cutoff for that edge.
      if (ref.id === record.id && ref.version < record.version) continue;
      const source = this.store.inspect(scope, ref.id);
      if (!source || source.version !== ref.version) throw new MemoryRuleError('emotion_source_unavailable');
      if (source.state === 'expired') {
        if (!Number.isSafeInteger(source.logicalOrder) || source.logicalOrder! > maxOrder) throw new MemoryRuleError('emotion_source_from_future');
        followed = true; continue;
      }
      if (source.state !== 'active') throw new MemoryRuleError('emotion_source_unavailable');
      this.assertLineageCutoff(scope, source, maxOrder, visiting); followed = true;
    }
    visiting.delete(key);
    if (!followed) order();
  }

  private targetMessage(scope: TurnScope, ref: SourceVersion): MemoryRecord {
    const record = this.source(scope, ref);
    if (record.kind !== 'transcript' || !record.message || !Number.isSafeInteger(record.logicalOrder)) throw new MemoryRuleError('emotion_target_not_message');
    return record;
  }

  private observation(scope: TurnScope, target: MemoryRecord, input: EmotionObservation, allowed?: readonly SourceVersion[]): EmotionObservation {
    if (!['user', 'companion'].includes(input.subject)) throw new MemoryRuleError('invalid_emotion_subject');
    const label = input.label.trim();
    if (!label || [...label].length > MAX_LABEL_LENGTH || label.includes('\0')) throw new MemoryRuleError('invalid_emotion_label');
    const scalar = (value: number | null): void => {
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) throw new MemoryRuleError('invalid_emotion_scalar');
    };
    scalar(input.intensity); scalar(input.confidence);
    if (['audio', 'video'].includes(input.provenance) && input.intensity !== null) throw new MemoryRuleError('modality_intensity_must_be_null');
    if (input.subject === 'user' && input.provenance === 'companion_inference') throw new MemoryRuleError('invalid_user_emotion_provenance');
    if (input.subject === 'companion' && input.provenance !== 'companion_inference') throw new MemoryRuleError('invalid_companion_emotion_provenance');
    const sources = refs(input.sources);
    if (!sources.length) throw new MemoryRuleError('emotion_observation_requires_source');
    const records = sources.map(ref => this.source(scope, ref, target.logicalOrder));
    if (!records.some(record => record.kind === 'transcript' && record.message?.role === 'user')) throw new MemoryRuleError('emotion_observation_requires_user_evidence');
    if (allowed) {
      const permitted = new Set(allowed.map(ref => `${ref.id}\0${ref.version}`));
      if (sources.some(ref => !permitted.has(`${ref.id}\0${ref.version}`))) throw new MemoryRuleError('emotion_source_not_in_ticket');
    }
    return { subject: input.subject, label, intensity: input.intensity, confidence: input.confidence, provenance: input.provenance, sources };
  }

  private state(characterId: CharacterId, subject: EmotionSubject): StateRow {
    const row = this.db.prepare('SELECT * FROM emotion_sustained_state WHERE character_id=? AND subject=?').get(characterId, subject) as StateRow | undefined;
    if (!row) throw new Error('emotion_state_missing');
    return row;
  }

  private publicState(row: StateRow): SustainedEmotion {
    const observation = row.observation_json ? parse<EmotionObservation>(row.observation_json) : null;
    const valid = !observation || this.sourcesValid(bindScope({ characterId: row.character_id, sessionId: 'emotion-management', turnId: 'read', generation: 0 }, row.character_id), parse<SourceVersion[]>(row.sources_json));
    return {
      subject: row.subject, revision: row.revision, observation: valid ? observation : null,
      updatedAt: valid ? row.updated_at : null,
      sourceMessage: valid && row.source_message_id ? { id: row.source_message_id, version: row.source_message_version! } : null,
      logicalOrder: valid ? row.logical_order : null, sessionId: valid ? row.session_id : null,
    };
  }

  private exposedState(scope: TurnScope, row: StateRow): SustainedEmotion {
    bindScope(scope, row.character_id);
    return this.publicState(row);
  }

  private updateState(scope: TurnScope, target: MemoryRecord, observation: EmotionObservation, allowEqualProvenance = false): boolean {
    const row = this.state(scope.characterId, observation.subject);
    if (row.logical_order !== null && row.logical_order > target.logicalOrder!) return false;
    if (row.logical_order === target.logicalOrder! && row.observation_json) {
      const previous = parse<EmotionObservation>(row.observation_json);
      const nextRank = this.directRank(observation.provenance), previousRank = this.directRank(previous.provenance);
      if (nextRank < previousRank || (!allowEqualProvenance && nextRank === previousRank)) return false;
    }
    const sourceMessage = { id: target.id, version: target.version };
    const sources = refs([sourceMessage, ...observation.sources]);
    this.db.prepare(`UPDATE emotion_sustained_state SET revision=revision+1,observation_json=?,updated_at=?,source_message_id=?,
      source_message_version=?,logical_order=?,session_id=?,sources_json=? WHERE character_id=? AND subject=?`).run(
      JSON.stringify(observation), this.store.now(), target.id, target.version, target.logicalOrder, scope.sessionId,
      JSON.stringify(sources), scope.characterId, observation.subject,
    );
    return true;
  }

  private hasLaterTranscript(characterId: CharacterId, logicalOrder: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM memory_records WHERE character_id=? AND kind='transcript' AND state='active' AND logical_order>? LIMIT 1")
      .get(characterId, logicalOrder));
  }

  private snapshotSources(snapshot: EmotionMessageSnapshot): SourceVersion[] {
    return refs([snapshot.message, ...snapshot.observations.flatMap(item => item.sources), ...this.backgroundSources(snapshot.background)]);
  }

  private backgroundSources(background: EmotionBackground): SourceVersion[] {
    const stateSources = (state: SustainedEmotion): SourceVersion[] => state.observation ? [...state.observation.sources, ...(state.sourceMessage ? [state.sourceMessage] : [])] : [];
    return refs([...stateSources(background.user), ...stateSources(background.companion)]);
  }

  private readMessage(row: MessageRow): EmotionMessageSnapshot | null {
    if (row.status !== 'active') return null;
    const scope = parse<TurnScope>(row.scope_json);
    if (!this.sourcesValid(scope, parse<SourceVersion[]>(row.sources_json))) return null;
    return clone(parse<EmotionMessageSnapshot>(row.payload_json));
  }

  private ticket(row: TicketRow): EmotionTicket {
    return {
      id: row.id, scope: parse<TurnScope>(row.scope_json), message: { id: row.message_id, version: row.message_version },
      logicalOrder: row.logical_order, evidence: parse<SourceVersion[]>(row.evidence_json),
      background: parse<EmotionBackground>(row.background_json), userRevision: row.user_revision, companionRevision: row.companion_revision,
    };
  }

  private analysis(row: AnalysisRow): EmotionAnalysis {
    return {
      id: row.id, message: { id: row.message_id, version: row.message_version }, scope: parse<TurnScope>(row.scope_json),
      completedAt: row.completed_at, origin: row.origin,
      assessment: row.assessment_json ? parse<EmotionAssessment>(row.assessment_json) : null,
      appliedSubjects: parse<EmotionSubject[]>(row.applied_subjects_json), status: row.status,
    };
  }

  private saveInvalidAnalysis(ticket: EmotionTicket, origin: EmotionAnalysis['origin'], signature: string): EmotionAnalysis {
    const scope = bindScope(ticket.scope, ticket.scope.characterId);
    const completedAt = this.store.now();
    const result: EmotionAnalysis = { id: ticket.id, message: clone(ticket.message), scope, completedAt, origin, assessment: null, appliedSubjects: [], status: 'invalid' };
    this.db.prepare('INSERT INTO emotion_analysis VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      ticket.id, scope.characterId, ticket.message.id, ticket.message.version, JSON.stringify(scope), completedAt,
      origin, null, '[]', 'invalid', '[]', signature,
    );
    this.bump(); return result;
  }

  private assessmentSources(assessment: EmotionAssessment): SourceVersion[] {
    return refs([...(assessment.user?.sources ?? []), ...(assessment.companion?.sources ?? [])]);
  }

  private sourcesValid(scope: TurnScope, sources: readonly SourceVersion[]): boolean {
    try { for (const ref of sources) this.source(scope, ref); return true; } catch { return false; }
  }

  private bump(): void {
    this.db.prepare('UPDATE emotion_state_component SET revision=revision+1 WHERE singleton=1').run();
  }
}
