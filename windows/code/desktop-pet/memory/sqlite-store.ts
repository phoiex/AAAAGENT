import { SqliteEmotionState } from './emotion-state.js';
import {PendingMutations} from './pending-mutations.js';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { CharacterId, ConversationMessage, InvitationPolicy, MemoryChange, MemoryChangeResult, MemoryMaintenanceInput, MemoryReference, PerceptionResult, RetentionPolicy, TurnScope } from '../contracts/index.js';
import { COMPANION_INTRODUCTION } from '../companion/introduction.js';
import type { CompanionIntroduction, CompanionProfilePort } from '../contracts/character.js';
import { assertDatabaseFileIdentity, COMPANION_DATABASE_ID, COMPANION_SCHEMA_VERSION } from './database-identity.js';
import { DEFAULT_CHARACTER_PROMPTS } from '../companion/prompts.js';
import { InvitationStore } from '../companion/invitations.js';
import { RoleMemoryLedger, type ContextRecords, type DerivedKind, type MemoryRecord } from './ledger.js';
import { SqliteLedgerBacking, decodeRecord, type RecordRow } from './sqlite-backing.js';
import { MemoryRuleError, assertCharacter, bindScope, sameScope, timestamp } from './scope.js';
import { SqliteLifecycleState } from './sqlite-lifecycle-state.js';
import { SqliteMemoryRecall } from './sqlite-recall.js';
import { SqliteMemoryDynamics } from './sqlite-dynamics.js';
import { SqliteImportedMemory } from './sqlite-imported-memory.js';
import { asksCurrentEmployment, isEmploymentCandidate } from './retrieval.js';

export const CONFIRMED_RETENTION: Readonly<RetentionPolicy> = Object.freeze({ transcriptQuotaScope: 'all_characters', transcriptMaxBytes: 300_000_000, transcriptDays: 30, deletedMemoryDays: 30 });
const DAY = 86_400_000;
const APP_ID = COMPANION_DATABASE_ID;
const ROLES: readonly CharacterId[] = ['companion'];
const internalScope = (characterId: CharacterId): TurnScope => ({ characterId, sessionId: 'storage-maintenance', turnId: 'storage-maintenance', generation: 0 });
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
};
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export interface StoreOptions {
  readonly filename: string;
  readonly retention: RetentionPolicy;
  readonly invitations: InvitationPolicy;
  readonly clock?: () => string;
}
export interface PersistentTask { readonly id: string; readonly scope: TurnScope; readonly input: MemoryMaintenanceInput }
interface TaskRow { id: string; character_id: CharacterId; scope_json: string; epoch: number; sources_json: string; status: string }
export interface CleanupResult {
  readonly expiredTranscripts: readonly { characterId: CharacterId; id: string }[];
  readonly purgedMemories: readonly { characterId: CharacterId; id: string }[];
  readonly transcriptBytes: number;
  readonly checkpointComplete: boolean;
}

export class SqliteMemoryStore implements CompanionProfilePort {
  readonly #db: Database.Database;
  readonly #clock: () => string;
  readonly invitations: InvitationStore;
  readonly lifecycle: SqliteLifecycleState;
  readonly pending:PendingMutations;
  readonly dynamics: SqliteMemoryDynamics;
  readonly recall: SqliteMemoryRecall;
  readonly imports: SqliteImportedMemory;
  readonly emotion: SqliteEmotionState;
  readonly filename: string;
  #closed = false;

  constructor(options: StoreOptions) {
    if (!isAbsolute(options.filename)) throw new Error('database_path_must_be_absolute');
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.filename = options.filename;
    this.#validateRetention(options.retention);
    assertDatabaseFileIdentity(options.filename);
    mkdirSync(dirname(options.filename), { recursive: true });
    this.#db = new Database(options.filename);
    try {
      // Connection-local predicate: no new persistent index, schema or copied source payload.
      this.#db.function('employment_candidate', { deterministic: true }, text => typeof text === 'string' && isEmploymentCandidate(text) ? 1 : 0);
      const appId = this.#db.pragma('application_id', { simple: true });
      const count = (this.#db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as {n: number}).n;
      if (appId !== APP_ID && !(appId === 0 && count === 0)) throw new Error('foreign_database');
      const version = this.#db.pragma('user_version', { simple: true });
      if (version !== 0 && version !== COMPANION_SCHEMA_VERSION) throw new Error('unsupported_database_schema');
      if (count > 0) {
        const characters = this.#db.prepare('SELECT character_id FROM characters').all() as {character_id: string}[];
        if (characters.length !== 1 || characters[0]!.character_id !== 'companion') throw new Error('invalid_product_registry');
      }
      this.#db.pragma('foreign_keys = ON');
      this.#db.pragma('synchronous = FULL');
      this.#db.pragma('secure_delete = ON');
      this.#db.transaction(() => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS characters(character_id TEXT PRIMARY KEY CHECK(character_id = 'companion'), revision INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, prompt TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS memory_records(character_id TEXT NOT NULL REFERENCES characters(character_id), id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('transcript','memory','emotion','summary','keyword_index','vector_index','context_cache')),
            state TEXT NOT NULL CHECK(state IN ('active','invalidated','deleted','expired','purged')), version INTEGER NOT NULL CHECK(version>0), text TEXT NOT NULL,
            sources_json TEXT NOT NULL, created_at TEXT NOT NULL, created_ms INTEGER NOT NULL, deleted_at TEXT, deleted_ms INTEGER, reason TEXT, message_role TEXT, perception_json TEXT,
            transcript_bytes INTEGER NOT NULL CHECK(transcript_bytes>=0), PRIMARY KEY(character_id,id));
          CREATE INDEX IF NOT EXISTS records_by_role_kind ON memory_records(character_id,kind,state,created_ms);
          CREATE INDEX IF NOT EXISTS transcript_age ON memory_records(kind,created_ms);
          CREATE TABLE IF NOT EXISTS memory_operations(character_id TEXT NOT NULL REFERENCES characters(character_id), operation_id TEXT NOT NULL, signature TEXT, result_json TEXT, PRIMARY KEY(character_id,operation_id));
          CREATE TABLE IF NOT EXISTS maintenance_tasks(character_id TEXT NOT NULL REFERENCES characters(character_id), id TEXT NOT NULL, scope_json TEXT NOT NULL, epoch INTEGER NOT NULL, sources_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(character_id,id));
          CREATE TABLE IF NOT EXISTS companion_profile(singleton INTEGER PRIMARY KEY CHECK(singleton=1), introduction_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(introduction_acknowledged IN (0,1)));
          INSERT OR IGNORE INTO companion_profile(singleton) VALUES(1);
          CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS memory_turn_outcomes(character_id TEXT NOT NULL REFERENCES characters(character_id), current_message_id TEXT NOT NULL,
            scope_json TEXT NOT NULL, text_hash TEXT NOT NULL, plan_hash TEXT NOT NULL, outcome_json TEXT NOT NULL, PRIMARY KEY(character_id,current_message_id));
          CREATE TABLE IF NOT EXISTS summary_coverage(character_id TEXT NOT NULL, source_id TEXT NOT NULL, source_version INTEGER NOT NULL, summary_id TEXT NOT NULL,
            PRIMARY KEY(character_id,source_id,source_version,summary_id),
            FOREIGN KEY(character_id,source_id) REFERENCES memory_records(character_id,id), FOREIGN KEY(character_id,summary_id) REFERENCES memory_records(character_id,id));
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(character_id UNINDEXED, record_id UNINDEXED, text, tokenize='trigram');
          CREATE TRIGGER IF NOT EXISTS memory_search_insert AFTER INSERT ON memory_records WHEN new.kind='memory' AND new.state='active' BEGIN
            INSERT INTO memory_search(character_id,record_id,text) VALUES(new.character_id,new.id,new.text); END;
          CREATE TRIGGER IF NOT EXISTS memory_search_update AFTER UPDATE ON memory_records BEGIN
            DELETE FROM memory_search WHERE character_id=old.character_id AND record_id=old.id;
            INSERT INTO memory_search(character_id,record_id,text) SELECT new.character_id,new.id,new.text WHERE new.kind='memory' AND new.state='active'; END;
        `);
        const columns = this.#db.pragma('table_info(memory_records)') as {name: string}[];
        if (!columns.some(column => column.name === 'logical_order')) {
          this.#db.exec("ALTER TABLE memory_records ADD COLUMN logical_order INTEGER NOT NULL DEFAULT 0; ALTER TABLE memory_records ADD COLUMN evidence_eligible INTEGER NOT NULL DEFAULT 1; ALTER TABLE memory_records ADD COLUMN fragment_json TEXT;");
          this.#db.exec("UPDATE memory_records SET logical_order=rowid; UPDATE memory_records SET evidence_eligible=0 WHERE message_role='assistant' AND json_array_length(sources_json)=0;");
        }
        // Additive metadata within the new product store; old product schemas are rejected before opening.
        if(!columns.some(column=>column.name==='origin'))this.#db.exec("ALTER TABLE memory_records ADD COLUMN origin TEXT CHECK(origin IN ('conversation','automatic','manual'))");
        this.#db.exec('CREATE INDEX IF NOT EXISTS records_logical_order ON memory_records(character_id,kind,state,logical_order)');
        this.#db.prepare("INSERT INTO memory_search(memory_search,rank) VALUES('secure-delete',1)").run();
        for (const role of ROLES) this.#db.prepare('INSERT OR IGNORE INTO characters(character_id,prompt) VALUES(?,?)').run(role, DEFAULT_CHARACTER_PROMPTS[role]);
        const existing = this.#db.prepare("SELECT value FROM app_settings WHERE key='retention'").get() as {value: string} | undefined;
        if (existing && canonical(JSON.parse(existing.value)) !== canonical(options.retention)) throw new Error('retention_configuration_mismatch');
        this.#db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('retention',?)").run(JSON.stringify(options.retention));
        this.#db.pragma(`application_id = ${APP_ID}`);
        this.#db.pragma(`user_version = ${COMPANION_SCHEMA_VERSION}`);
      }).immediate();
      this.#db.pragma('journal_mode = WAL');
      this.invitations = new InvitationStore(this.#db, options.invitations, this.#clock, (role, id) => this.inspect(internalScope(role), id));
      this.pending=new PendingMutations(this.#db);
      this.lifecycle = new SqliteLifecycleState(this.#db, this);
      this.dynamics = new SqliteMemoryDynamics(this.#db, this);
      this.recall = new SqliteMemoryRecall(this.#db, this, {affinity:(scope,sources)=>this.emotion.affinity(scope,sources)});
      this.imports = new SqliteImportedMemory(this.#db, this);
      this.emotion = new SqliteEmotionState(this.#db,this);
      this.cleanup();
    } catch (error) { this.#db.close(); throw error; }
  }

  introduction(): CompanionIntroduction | null {
    this.#open();
    const row = this.#db.prepare('SELECT introduction_acknowledged FROM companion_profile WHERE singleton=1').get() as {introduction_acknowledged: number};
    return row.introduction_acknowledged ? null : {...COMPANION_INTRODUCTION};
  }
  acknowledgeIntroduction(id: string): void {
    this.#open();
    if (id !== COMPANION_INTRODUCTION.id) throw new MemoryRuleError('unknown_introduction');
    this.#transaction(() => {
      this.#db.prepare('UPDATE companion_profile SET introduction_acknowledged=1 WHERE singleton=1 AND introduction_acknowledged=0').run();
    });
  }

  get closed(): boolean { return this.#closed; }
  now(): string { const value = this.#clock(); timestamp(value); return value; }
  #open(): void { if (this.#closed) throw new Error('memory_store_closed'); }
  #backing(role: CharacterId) { this.#open(); assertCharacter(role); return new SqliteLedgerBacking(this.#db, role); }
  #ledger(scope: TurnScope) { const owned = bindScope(scope, scope.characterId); return new RoleMemoryLedger(owned.characterId, this.#backing(owned.characterId)); }
  #transaction<T>(fn: () => T): T { this.#open(); return this.#db.transaction(() => { const result = fn(); this.dynamics?.sync(internalScope('companion')); this.emotion?.invalidate(); this.recall?.invalidate(); return result; }).immediate(); }

  append(scope: TurnScope, messages: readonly ConversationMessage[]): void {
    this.#transaction(() => {
      for(const message of messages){this.#ledger(scope).append(scope, [message]);const record=this.inspect(scope,message.id)!;this.emotion.captureMessage(scope,{id:record.id,version:record.version},message.emotionObservations??[]);}
      this.#pruneTranscripts(this.now());
    });
  }
  recordDerived(scope: TurnScope, entry: {id: string; kind: DerivedKind; text: string; sourceIds: readonly string[]; createdAt: string}): void {
    this.#transaction(() => this.#ledger(scope).recordDerived(scope, entry));
  }
  recordPerception(scope: TurnScope, perception: PerceptionResult, sourceIds: readonly string[]): void {
    this.#transaction(() => {
      const ledger = this.#ledger(scope);
      const id = `${scope.turnId}:emotion`;
      if (!ledger.inspect(scope, id)) ledger.recordPerception(scope, id, perception, this.now(), sourceIds);
    });
  }
  inspect(scope: TurnScope, id: string): MemoryRecord | null { return this.#ledger(scope).inspect(scope, id); }
  visible(scope: TurnScope, kind: MemoryRecord['kind']): readonly MemoryRecord[] { return this.#ledger(scope).visible(scope, kind); }
  revision(scope: TurnScope): number { bindScope(scope, scope.characterId); return this.#backing(scope.characterId).revision; }
  queryRecords(scope:TurnScope, input:{kind:MemoryRecord['kind'];query:string;offset:number;limit:number;state:'active'|'all'}):{revision:number;records:readonly MemoryRecord[];total:number} {
    const owned=bindScope(scope,scope.characterId);
    return this.#transaction(()=>{
      const where="character_id=? AND kind=? AND (?='all' OR state='active') AND (?='' OR instr(lower(text),lower(?))>0)";
      const args=[owned.characterId,input.kind,input.state,input.query,input.query];
      const rows=this.#db.prepare(`SELECT * FROM memory_records WHERE ${where} ORDER BY logical_order DESC,id LIMIT ? OFFSET ?`).all(...args,input.limit,input.offset) as RecordRow[];
      const {total}=this.#db.prepare(`SELECT count(*) AS total FROM memory_records WHERE ${where}`).get(...args) as {total:number};
      return {revision:this.revision(owned),records:rows.map(decodeRecord),total};
    });
  }
  dynamicsAction(scope:TurnScope,input:import('../contracts/memory-dynamics.js').MemoryRecordAction,restore:boolean):import('../contracts/memory-dynamics.js').MemoryRecordActionResult {
    return this.#transaction(()=>{
      const signature=digest({type:restore?'dynamics_restore':'dynamics_forget',...input});
      const prior=this.#managementReplay(scope,input.operationId,signature) as import('../contracts/memory-dynamics.js').MemoryRecordActionResult|null;
      if(prior)return prior;
      const record=this.inspect(scope,input.id);
      if(!record||record.kind!=='memory')throw new MemoryRuleError('management_record_not_found');
      if(record.version!==input.expectedVersion)throw new MemoryRuleError('version_conflict');
      const ancestors=new Map<string,MemoryRecord>();
      const visit=(id:string):void=>{if(ancestors.has(id))return;const r=this.inspect(scope,id);if(!r)throw new MemoryRuleError(restore?'restore_sources_unavailable':'forget_requires_source_plan');ancestors.set(id,r);for(const ref of r.sources)if(ref.id!==id)visit(ref.id);};
      for(const ref of record.sources)visit(ref.id);
      if(restore) {
        if([...ancestors.values()].some(r=>r.state!=='active'||r.evidenceEligible===false)||record.sources.some(ref=>this.inspect(scope,ref.id)?.version!==ref.version))throw new MemoryRuleError('restore_sources_unavailable');
      } else {
        const graph=this.#backing(scope.characterId).records.lineage?.();
        // Exact same-content independent sources are the only automatic whole-source case.
        // A shared or mixed-content source needs the existing strict fragment plan.
        const ownDescendants=new Set([record.id]);
        for(let changed=true;changed;){changed=false;for(const row of graph??[])if(!ownDescendants.has(row.id)&&row.sources.some(ref=>ownDescendants.has(ref.id))){ownDescendants.add(row.id);changed=true;}}
        for(const source of ancestors.values()) {
          if(source.state==='expired')continue;
          if(source.state!=='active'||source.text.trim()!==record.text.trim())throw new MemoryRuleError('forget_requires_source_plan');
          if((graph??[]).some(row=>this.inspect(scope,row.id)?.state==='active'&&!ownDescendants.has(row.id)&&!ancestors.has(row.id)&&row.sources.some(ref=>ref.id===source.id)))throw new MemoryRuleError('forget_requires_source_plan');
        }
      }
      const operation:MemoryChange={scope,operationId:`dynamics-action:${input.operationId}`,reason:input.reason,createdAt:this.now(),operation:{type:restore?'restore':'soft_delete',id:record.id,expectedVersion:record.version}};
      const result=restore?this.#ledger(scope).apply(operation,this.now()):this.#ledger(scope).applyResolvedChange(operation,[...ancestors.values()].filter(r=>r.state==='active').map(r=>r.id),this.now());
      if(result.status!=='applied')throw new MemoryRuleError(result.reason??'memory_action_failed');
      const response={characterId:scope.characterId,revision:this.revision(scope),affectedIds:result.affectedIds,status:'applied' as const};
      this.#saveManagementOperation(scope,input.operationId,signature,response);return response;
    });
  }
  /** Management writes share the operation namespace without storing a second copy of edited text. */
  #managementReplay(scope:TurnScope,operationId:string,signature:string):unknown|null {
    const prior=this.#db.prepare('SELECT signature,result_json FROM memory_operations WHERE character_id=? AND operation_id=?').get(scope.characterId,operationId) as {signature:string|null;result_json:string|null}|undefined;
    if(!prior)return null;
    if(prior.signature!==signature||!prior.result_json)throw new MemoryRuleError('operation_id_payload_mismatch');
    return JSON.parse(prior.result_json);
  }
  #saveManagementOperation(scope:TurnScope,operationId:string,signature:string,result:unknown):void {
    this.#db.prepare('INSERT INTO memory_operations(character_id,operation_id,signature,result_json) VALUES(?,?,?,?)').run(scope.characterId,operationId,signature,JSON.stringify(result));
  }
  editPrompt(scope:TurnScope,input:{expectedRevision:number;text:string;operationId:string}):{revision:number;text:string} {
    const owned=bindScope(scope,scope.characterId),signature=digest({kind:'management_prompt',characterId:owned.characterId,...input});
    return this.#transaction(()=>{
      const prior=this.#managementReplay(owned,input.operationId,signature) as {revision:number;textHash:string}|null;
      if(prior){
        const text=this.prompt(owned);
        if(this.revision(owned)!==prior.revision||digest(text)!==prior.textHash)throw new MemoryRuleError('management_operation_superseded');
        return {revision:prior.revision,text};
      }
      if(this.revision(owned)!==input.expectedRevision)throw new MemoryRuleError('version_conflict');
      this.setPrompt(owned,input.text);
      const backing=this.#backing(owned.characterId);backing.epoch++;
      const revision=backing.revision;
      this.#saveManagementOperation(owned,input.operationId,signature,{revision,textHash:digest(input.text)});
      return {revision,text:input.text};
    });
  }
  editRecord(scope:TurnScope,input:{id:string;expectedVersion:number;operationId:string;text:string;reason:string}):{record:MemoryRecord;revision:number;invalidatedIds:readonly string[]} {
    const owned=bindScope(scope,scope.characterId),signature=digest({kind:'management_record',characterId:owned.characterId,...input});
    return this.#transaction(()=>{
      const prior=this.#managementReplay(owned,input.operationId,signature) as {id:string;version:number;revision:number;textHash:string;invalidatedIds:readonly string[]}|null;
      if(prior){
        const record=this.inspect(owned,prior.id);
        if(!record||record.state!=='active'||record.version!==prior.version||digest(record.text)!==prior.textHash)throw new MemoryRuleError('management_operation_superseded');
        return {record,revision:prior.revision,invalidatedIds:prior.invalidatedIds};
      }
      const before=this.inspect(owned,input.id);
      const invalidatedIds=this.#ledger(owned).editManually(owned,input,this.now());
      this.#pruneTranscripts(this.now());
      const record=this.inspect(owned,input.id)!;
      if(record.state!=='active')throw new MemoryRuleError('edited_record_exceeds_retention');
      const revision=this.revision(owned);
      this.#saveManagementOperation(owned,input.operationId,signature,{id:record.id,version:record.version,revision,textHash:digest(record.text),invalidatedIds,
        origin:'manual',editedAt:this.now(),previousVersion:before!.version,previousSources:before!.sources});
      return {record,revision,invalidatedIds};
    });
  }
  assertContextCurrent(scope: TurnScope, revision: number): void { this.#ledger(scope).assertContextCurrent(scope, revision); }
  prompt(scope: TurnScope): string {
    bindScope(scope, scope.characterId); this.#open();
    return (this.#db.prepare('SELECT prompt FROM characters WHERE character_id=?').get(scope.characterId) as {prompt: string}).prompt;
  }
  promptSnapshot(scope:TurnScope):{revision:number;text:string} {
    const owned=bindScope(scope,scope.characterId);
    return this.#transaction(()=>({revision:this.revision(owned),text:this.prompt(owned)}));
  }
  setPrompt(scope: TurnScope, prompt: string): void {
    bindScope(scope, scope.characterId); if (!prompt.trim()) throw new Error('empty_prompt');
    this.#transaction(() => {
      this.#db.prepare('UPDATE characters SET prompt=?,revision=revision+1 WHERE character_id=?').run(prompt, scope.characterId);
      this.#db.prepare("UPDATE memory_records SET state='invalidated',text='',version=version+1,reason='prompt_changed' WHERE character_id=? AND kind='context_cache' AND state='active'").run(scope.characterId);
    });
  }

  #reference(record: MemoryRecord): MemoryReference {
    return { ...(record.origin?{origin:record.origin}:{}),characterId: record.characterId, id: record.id, version: record.version, text: record.text, sourceIds: [...new Set(record.sources.map(source => source.id))] };
  }
  search(scope: TurnScope, query: string, limit: number, mode: 'literal' | 'lexical' = 'literal'): readonly MemoryReference[] {
    bindScope(scope,scope.characterId); this.#open();
    if(this.pending.has(scope.characterId))return [];
    return this.searchForMaintenance(scope,query,limit,mode);
  }
  /** Strict writers resolve privacy targets from committed evidence while dialogue retrieval is excluded. */
  searchForMaintenance(scope:TurnScope,query:string,limit:number,mode:'literal'|'lexical'='literal'):readonly MemoryReference[] {
    bindScope(scope, scope.characterId); this.#open();
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid_search_limit');
    const term = query.trim(); if (!term || limit === 0) return [];
    // Trigram MATCH supplies indexed substrings; one/two-codepoint queries use scoped exact substring search.
    const rows = [...term].length >= 3
      ? this.#db.prepare(`SELECT r.* FROM memory_search f JOIN memory_records r ON r.character_id=f.character_id AND r.id=f.record_id
          WHERE memory_search MATCH ? AND f.character_id=? AND r.kind='memory' AND r.state='active' ORDER BY r.created_ms DESC,r.rowid DESC LIMIT ?`).all(`"${term.replaceAll('"', '""')}"`, scope.characterId, limit)
      : this.#db.prepare("SELECT * FROM memory_records WHERE character_id=? AND kind='memory' AND state='active' AND instr(text,?)>0 ORDER BY created_ms DESC,rowid DESC LIMIT ?").all(scope.characterId, term, limit);
    const exact = (rows as RecordRow[]).map(decodeRecord);
    if (mode === 'literal' || exact.length >= limit) return exact.map(record => this.#reference(record));
    // Deterministic lexical fallback for natural queries, including two-character Chinese keywords.
    // The optional relation expansion below remains candidate recall, not semantic validation.
    const terms = new Set<string>();
    const weak = new Set<string>();
    const stop = new Set([...'我你他她它们的了着过是有在把被和与及或这那哪什么怎吗呢吧啊呀得地个只件事请忘记名字叫用户一不没也都就很再还要来去说']);
    for (const run of term.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      terms.add(run);
      if (/\p{Script=Han}/u.test(run)) {
        const chars = [...run];
        for (const char of chars) if (/\p{Script=Han}/u.test(char) && !stop.has(char)) weak.add(char);
        for (let i = 0; i + 1 < chars.length; i++) terms.add(chars.slice(i, i + 2).join(''));
      }
    }
    const fallback = this.#db.prepare(`WITH terms AS (SELECT value AS term,1 AS weight FROM json_each(?) UNION ALL SELECT value,0.05 FROM json_each(?))
      SELECT r.* FROM memory_records r WHERE r.character_id=? AND r.kind='memory' AND r.state='active'
      AND EXISTS(SELECT 1 FROM terms WHERE instr(lower(r.text),term)>0)
      ORDER BY (SELECT sum(length(term)*weight) FROM terms WHERE instr(lower(r.text),term)>0) DESC,r.created_ms DESC LIMIT ?`).all(JSON.stringify([...terms]), JSON.stringify([...weak]), scope.characterId, limit) as RecordRow[];
    const related = asksCurrentEmployment(term) ? this.#db.prepare(`
      WITH terms AS (SELECT value AS term,1 AS weight FROM json_each(?) UNION ALL SELECT value,0.05 FROM json_each(?))
      SELECT r.* FROM memory_records r WHERE r.character_id=? AND r.kind='memory' AND r.state='active' AND employment_candidate(r.text)=1
      ORDER BY COALESCE((SELECT sum(length(term)*weight) FROM terms WHERE instr(lower(r.text),term)>0),0) DESC,r.created_ms DESC,r.rowid DESC LIMIT ?
      `).all(JSON.stringify([...terms]), JSON.stringify([...weak]), scope.characterId, limit) as RecordRow[] : [];
    // Preserve full-query matches, then qualified relation candidates (lexically ranked inside
    // that set), then ordinary lexical hits. Incidental substrings cannot consume every slot.
    // Creation time only orders candidates; it does not establish when an employment fact is true.
    const ranked = [...related, ...fallback];
    const seen = new Set<string>();
    return [...exact, ...ranked.map(decodeRecord)].filter(record => {
      if (seen.has(record.id)) return false;
      seen.add(record.id); return true;
    }).slice(0, limit).map(record => this.#reference(record));
  }
  contextRecords(scope: TurnScope, query: string, recentLimit: number, memoryLimit: number, summaryLimit: number, purpose:'dialogue'|'maintenance'='dialogue'): ContextRecords {
    bindScope(scope, scope.characterId);
    for (const n of [recentLimit, memoryLimit, summaryLimit]) if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid_context_limit');
    if(purpose==='dialogue'&&this.pending.has(scope.characterId))return {characterId:scope.characterId,revision:this.revision(scope),recent:[],summaries:[],memories:[]};
    return this.#db.transaction(() => {
      const recent = this.#db.prepare(`SELECT r.* FROM memory_records r WHERE r.character_id=? AND r.kind='transcript' AND r.state='active' AND r.evidence_eligible=1
        AND NOT EXISTS(SELECT 1 FROM memory_import_evidence i WHERE i.character_id=r.character_id AND i.record_id=r.id)
        ORDER BY r.logical_order DESC,r.rowid DESC LIMIT ?`).all(scope.characterId, recentLimit) as RecordRow[];
      const summaries = this.#db.prepare("SELECT * FROM memory_records WHERE character_id=? AND kind='summary' AND state='active' AND evidence_eligible=1 ORDER BY logical_order DESC,rowid DESC LIMIT ?").all(scope.characterId, summaryLimit) as RecordRow[];
      return { characterId: scope.characterId, revision: this.revision(scope), recent: recent.reverse().map(decodeRecord).map(record => record.message!),
        summaries: summaries.map(decodeRecord), memories: purpose==='maintenance'?this.searchForMaintenance(scope,query,memoryLimit,'lexical'):this.search(scope, query, memoryLimit, 'lexical') };
    })();
  }

  /** Conversation after a durable privacy boundary, never a memory/summary evidence source. */
  protectedRecent(scope:TurnScope,limit:number):ContextRecords {
    bindScope(scope,scope.characterId);
    if(!Number.isSafeInteger(limit)||limit<0)throw new Error('invalid_context_limit');
    return this.#db.transaction(()=>{
      const boundary=this.pending.contextBoundary(scope.characterId);
      if(boundary.afterOrder===null)return {characterId:scope.characterId,revision:this.revision(scope),recent:[],summaries:[],memories:[]};
      const rows=this.#db.prepare(`SELECT * FROM memory_records r WHERE character_id=? AND kind='transcript' AND state='active'
        AND NOT EXISTS(SELECT 1 FROM memory_import_evidence i WHERE i.character_id=r.character_id AND i.record_id=r.id)
        AND logical_order>? AND COALESCE(origin,'')!='manual' AND
        ((message_role='user' AND evidence_eligible=1) OR
         (message_role='assistant' AND evidence_eligible=0 AND reason='display_only_assistant' AND id LIKE '%:assistant'
          AND EXISTS(SELECT 1 FROM memory_records u WHERE u.character_id=r.character_id AND u.id=substr(r.id,1,length(r.id)-10)||':user'
            AND u.kind='transcript' AND u.message_role='user' AND u.state='active' AND u.evidence_eligible=1 AND u.logical_order>?)))
        ORDER BY logical_order DESC,rowid DESC LIMIT ?`).all(scope.characterId,boundary.afterOrder,boundary.afterOrder,limit) as RecordRow[];
      return {characterId:scope.characterId,revision:this.revision(scope),recent:rows.reverse().map(decodeRecord).map(r=>r.message!),summaries:[],memories:[]};
    })();
  }

  apply(change: MemoryChange, resolvedSourceIds?: readonly string[]): MemoryChangeResult {
    return this.#transaction(() => this.#applyInside(change, resolvedSourceIds));
  }
  #applyInside(change: MemoryChange, resolvedSourceIds?: readonly string[]): MemoryChangeResult {
    const scope = bindScope(change.scope, change.scope.characterId);
    const signature = digest({ change, resolvedSourceIds: resolvedSourceIds ?? null });
    const prior = this.#db.prepare('SELECT signature,result_json FROM memory_operations WHERE character_id=? AND operation_id=?').get(scope.characterId, change.operationId) as {signature: string | null; result_json: string | null} | undefined;
    if (prior) {
      if (prior.signature === signature && prior.result_json) return JSON.parse(prior.result_json);
      return { characterId: scope.characterId, operationId: change.operationId, status: 'rejected', affectedIds: [], retrievalInvalidated: false, reason: 'operation_id_payload_mismatch' };
    }
    const ledger = this.#ledger(scope);
    const result = resolvedSourceIds ? ledger.applyResolvedChange(change, resolvedSourceIds, this.now()) : ledger.apply(change, this.now());
    if (result.status === 'applied') { this.dynamics.sync(scope); this.dynamics.merged(scope,[change]); }
    if (result.status === 'applied') this.#db.prepare('UPDATE memory_operations SET signature=?,result_json=? WHERE character_id=? AND operation_id=?').run(signature, JSON.stringify(result), scope.characterId, change.operationId);
    return result;
  }

  prepareMaintenance(input: MemoryMaintenanceInput): PersistentTask {
    return this.#transaction(() => {
      const scope = bindScope(input.scope, input.scope.characterId);
      const ledger = this.#ledger(scope);
      const messages = input.messages.map(message => {
        if (message.characterId !== scope.characterId) throw new Error('maintenance_character_mismatch');
        const actual = ledger.inspect(scope, message.id);
        if (!actual || actual.state !== 'active' || !actual.message || canonical(actual.message) !== canonical(message)) throw new Error('maintenance_message_mismatch');
        return actual.message;
      });
      const relevantMemories = input.relevantMemories.map(memory => {
        if (memory.characterId !== scope.characterId) throw new Error('maintenance_character_mismatch');
        const actual = ledger.inspect(scope, memory.id);
        if (!actual || actual.kind !== 'memory' || actual.state !== 'active' || canonical(this.#reference(actual)) !== canonical(memory)) throw new Error('maintenance_memory_mismatch');
        return this.#reference(actual);
      });
      const id = randomUUID();
      const sources = [...new Set([...messages, ...relevantMemories].map(item => item.id))];
      this.#db.prepare("INSERT INTO maintenance_tasks(character_id,id,scope_json,epoch,sources_json,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run(scope.characterId, id, JSON.stringify(scope), this.#backing(scope.characterId).epoch, JSON.stringify(sources), this.now());
      return { id, scope, input: structuredClone({ scope, messages, relevantMemories }) };
    });
  }
  pendingTasks(scope: TurnScope): readonly {id: string; scope: TurnScope}[] {
    bindScope(scope, scope.characterId); this.#open();
    return (this.#db.prepare("SELECT id,scope_json FROM maintenance_tasks WHERE character_id=? AND status='pending' ORDER BY created_at").all(scope.characterId) as {id: string; scope_json: string}[]).map(row => ({ id: row.id, scope: JSON.parse(row.scope_json) }));
  }
  finishMaintenance(task: Pick<PersistentTask, 'id' | 'scope'>, changes: readonly MemoryChange[]): readonly MemoryChangeResult[] {
    return this.#transaction(() => {
      const scope = bindScope(task.scope, task.scope.characterId);
      const row = this.#db.prepare('SELECT * FROM maintenance_tasks WHERE character_id=? AND id=?').get(scope.characterId, task.id) as TaskRow | undefined;
      const reject = (reason: string) => changes.map(change => ({ characterId: scope.characterId, operationId: change.operationId, status: 'rejected' as const, affectedIds: [], retrievalInvalidated: false, reason }));
      if (!row || row.status !== 'pending' || !sameScope(JSON.parse(row.scope_json), scope)) return reject('unknown_or_consumed_task');
      const close = (status: string) => this.#db.prepare('UPDATE maintenance_tasks SET status=? WHERE character_id=? AND id=?').run(status, scope.characterId, task.id);
      if (row.epoch !== this.#backing(scope.characterId).epoch) { close('stale'); return reject('stale_maintenance_epoch'); }
      const sources = new Set<string>(JSON.parse(row.sources_json));
      for (const change of changes) {
        if (!sameScope(change.scope, scope)) { close('rejected'); return reject('task_scope_mismatch'); }
        const op = change.operation;
        const references = op.type === 'add' || op.type === 'update' ? op.sourceIds : op.type === 'merge' ? op.replacement.sourceIds : [];
        if (references.some(id => !sources.has(id))) { close('rejected'); return reject('source_not_in_task_input'); }
        const targets = op.type === 'add' ? [] : op.type === 'merge' ? op.targets.map(target => target.id) : [op.id];
        if (targets.some(id => !sources.has(id))) { close('rejected'); return reject('target_not_in_task_input'); }
      }
      const result = changes.map(change => {
        const op = change.operation;
        if (op.type !== 'update' && op.type !== 'soft_delete') return this.#applyInside(change);
        const target = this.inspect(scope, op.id);
        const newSources = new Set<string>();
        if (op.type === 'update') for (const id of op.sourceIds) {
          newSources.add(id); for (const ref of this.inspect(scope, id)?.sources ?? []) newSources.add(ref.id);
        }
        const oldRaw = (target?.sources ?? []).filter(ref => this.inspect(scope, ref.id)?.kind === 'transcript' && !newSources.has(ref.id)).map(ref => ref.id);
        return this.#applyInside(change, oldRaw);
      });
      close('completed'); return result;
    });
  }
  cancelMaintenance(task: Pick<PersistentTask, 'id' | 'scope'>): void {
    this.#transaction(() => {
      bindScope(task.scope, task.scope.characterId);
      const row = this.#db.prepare('SELECT scope_json FROM maintenance_tasks WHERE character_id=? AND id=?').get(task.scope.characterId, task.id) as {scope_json: string} | undefined;
      if (row && sameScope(JSON.parse(row.scope_json), task.scope)) this.#db.prepare("UPDATE maintenance_tasks SET status='cancelled' WHERE character_id=? AND id=? AND status='pending'").run(task.scope.characterId, task.id);
    });
  }

  transcriptBytes(): number { this.#open(); return (this.#db.prepare(`SELECT coalesce(sum(r.transcript_bytes),0) AS bytes FROM memory_records r WHERE r.kind='transcript'
    AND NOT EXISTS(SELECT 1 FROM memory_import_evidence i WHERE i.character_id=r.character_id AND i.record_id=r.id)`).get() as {bytes: number}).bytes; }
  #validateRetention(policy: RetentionPolicy): void {
    if (policy.transcriptQuotaScope !== 'all_characters' || !Number.isSafeInteger(policy.transcriptMaxBytes) || policy.transcriptMaxBytes <= 0 || policy.transcriptDays !== 30 || policy.deletedMemoryDays !== 30) throw new Error('unsupported_retention_policy');
  }
  #pruneTranscripts(now: string): {characterId: CharacterId; id: string}[] {
    const policy = JSON.parse((this.#db.prepare("SELECT value FROM app_settings WHERE key='retention'").get() as {value: string}).value) as RetentionPolicy;
    const rows = this.#db.prepare(`SELECT r.character_id,r.id,r.transcript_bytes,r.created_ms FROM memory_records r WHERE r.kind='transcript'
      AND (r.transcript_bytes>0 OR r.message_role IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM memory_import_evidence i WHERE i.character_id=r.character_id AND i.record_id=r.id)
      ORDER BY r.created_ms,r.rowid`).all() as {character_id: CharacterId; id: string; transcript_bytes: number; created_ms: number}[];
    let bytes = this.transcriptBytes(); const expired: {characterId: CharacterId; id: string}[] = [];
    const cutoff = timestamp(now) - policy.transcriptDays * DAY;
    const touched = new Set<CharacterId>();
    for (const row of rows) {
      if (row.created_ms > cutoff && bytes <= policy.transcriptMaxBytes) continue;
      this.#db.prepare("UPDATE memory_records SET state='expired',text='',message_role=NULL,transcript_bytes=0,reason='transcript_expired' WHERE character_id=? AND id=?").run(row.character_id, row.id);
      bytes -= row.transcript_bytes; touched.add(row.character_id); expired.push({ characterId: row.character_id, id: row.id });
    }
    for (const role of touched) {
      this.#db.prepare('UPDATE characters SET revision=revision+1,epoch=epoch+1 WHERE character_id=?').run(role);
      this.#db.prepare("UPDATE memory_records SET state='invalidated',text='',version=version+1,reason='transcript_expired' WHERE character_id=? AND kind='context_cache' AND state='active'").run(role);
    }
    return expired;
  }
  /** Internal lifecycle transaction hook; does not checkpoint inside an active transaction. */
  pruneForLifecycle(): readonly {characterId: CharacterId; id: string}[] { const expired=this.#pruneTranscripts(this.now());this.emotion?.invalidate();return expired; }
  cleanup(): CleanupResult {
    const result = this.#transaction(() => {
      const now = this.now();
      const expiredTranscripts = this.#pruneTranscripts(now);
      const purgedMemories = ROLES.flatMap(role => this.#ledger(internalScope(role)).purgeDeleted(internalScope(role), now).map(id => ({ characterId: role, id })));
      return { expiredTranscripts, purgedMemories, transcriptBytes: this.transcriptBytes() };
    });
    const checkpoint = this.#db.pragma('wal_checkpoint(TRUNCATE)') as {busy: number; log: number; checkpointed: number}[];
    return { ...result, checkpointComplete: checkpoint.every(row => row.busy === 0 && row.log === row.checkpointed) };
  }
  close(): void {
    if (this.#closed) return;
    this.#db.close(); this.#closed = true;
  }
}
