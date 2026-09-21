import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { ConversationMessage, DialogueContext, MemoryChangeResult, MemoryReference, TurnScope } from '../contracts/index.js';
import type { MemorySource, MemoryTurnInput, MemoryTurnOutcome, MemoryTurnPlan, SourceVersion, SummaryInput, SummaryProposal, SummaryResult } from '../contracts/memory-lifecycle.js';
import type { ContextSnapshot } from './context.js';
import { RoleMemoryLedger, type MemoryRecord } from './ledger.js';
import { MemoryRuleError, bindScope, sameScope, timestamp } from './scope.js';
import { SqliteLedgerBacking, decodeRecord, type RecordRow } from './sqlite-backing.js';
import type { SqliteMemoryStore } from './sqlite-store.js';
import {sourceGraph,related,readable,descendants,effectCandidates} from './source-graph.js';
import {SqliteManagementForget,type ManagementForgetTicket} from './sqlite-management-forget.js';
import type {MemoryRecordAction,MemoryRecordActionResult} from '../contracts/memory-dynamics.js';
export type {ManagementForgetTicket} from './sqlite-management-forget.js';
import {applySourcePlan,prepareSourcePlan} from './sqlite-source-plan.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface InputBudget<T> { readonly inputTokenBudget: number; readonly countTokens: (input: T) => number }
export interface TurnReadOptions extends InputBudget<MemoryTurnInput> { readonly maxRecentMessages: number; readonly maxMemories: number; readonly summaryLimit: number }
export interface SummaryReadOptions extends InputBudget<SummaryInput> { readonly minMessages: number; readonly maxMessages: number }
interface Ticket<T> { readonly input: T; readonly epoch: number }
export interface TurnTicket extends Ticket<MemoryTurnInput> { readonly textHash: string }
export type SummaryTicket = Ticket<SummaryInput>;
export type TurnExpansion = {status:'unchanged'} | {status:'expanded';ticket:TurnTicket} | {status:'rejected';outcome:MemoryTurnOutcome};
interface OutcomeRow { scope_json: string; text_hash: string; plan_hash: string; outcome_json: string }
interface CurrentIdentity {scope:TurnScope;id:string;textHash:string;displayOnly:boolean}
interface AppendedUser {scope:TurnScope;textHash:string}
const scopeKey = (scope:TurnScope) => JSON.stringify([scope.characterId,scope.sessionId,scope.turnId,scope.generation]);
const messageKey = (scope:TurnScope,id:string) => JSON.stringify([scope.characterId,id]);
// Message identity must not depend on property insertion order after SQLite decoding.
const messageHash = (message:ConversationMessage) => hash([message.characterId,message.id,message.role,message.text,message.createdAt,message.origin??null]);
const assistantSignature = (scope:TurnScope,message:ConversationMessage,currentMessageId:string) => hash([scopeKey(scope),messageHash(message),currentMessageId]);
interface ContextStamp { foreground:boolean;privacyExcluded:boolean;pendingHolds:readonly string[];policyRevision:number; scope: TurnScope; epoch: number; sources: readonly SourceVersion[]; fingerprint: string; prompt: string;
  current?: {identity:CurrentIdentity;version:number;state:MemoryRecord['state']}; saved?: {id:string;signature:string} }

/** Internal SQLite lifecycle boundary. All model I/O is performed by the port outside these methods. */
export class SqliteLifecycleState {
  readonly #turns = new WeakMap<TurnTicket, TurnTicket>();
  readonly #summaries = new WeakMap<SummaryTicket, SummaryTicket>();
  readonly #contexts = new WeakMap<DialogueContext, ContextStamp>();
  readonly #currents = new Map<string,CurrentIdentity>();
  // Admission evidence for this store instance only. Historical rows do not prove session ownership.
  readonly #appendedUsers = new Map<string,AppendedUser>();
  private readonly managementForget:SqliteManagementForget;
  private readonly managementCurrents=new Set<string>();
  constructor(private readonly db: Database.Database, private readonly store: SqliteMemoryStore) {
    this.managementForget=new SqliteManagementForget(db,store,(input,plan)=>{
      const current=input.sources.find(source=>source.id===input.currentMessageId)!;
      const ticket:TurnTicket=Object.freeze({input:structuredClone(input),epoch:this.#epoch(input.scope),textHash:hash(current.text)});
      this.#turns.set(ticket,structuredClone(ticket));
      this.managementCurrents.add(input.currentMessageId);
      try{return this.commitTurn(ticket,plan);}finally{this.managementCurrents.delete(input.currentMessageId);}
    });
  }
  managementForgetOutcome(action:MemoryRecordAction):MemoryRecordActionResult|null {return this.managementForget.outcome(action);}
  readManagementForget(action:MemoryRecordAction,budget:InputBudget<MemoryTurnInput>):ManagementForgetTicket {this.assertReady();return this.managementForget.read(action,budget);}
  commitManagementForget(ticket:ManagementForgetTicket,plan:MemoryTurnPlan):MemoryRecordActionResult {return this.managementForget.apply(ticket,plan);}
  discardManagementForget(ticket:ManagementForgetTicket):void {this.managementForget.discard(ticket);}
  #ledger(scope: TurnScope) { return new RoleMemoryLedger(scope.characterId, new SqliteLedgerBacking(this.db, scope.characterId)); }
  #epoch(scope: TurnScope): number { return new SqliteLedgerBacking(this.db, scope.characterId).epoch; }
  #source(scope: TurnScope, record: MemoryRecord): MemorySource {
    if (!['transcript', 'summary', 'memory'].includes(record.kind) || record.state !== 'active') throw new MemoryRuleError('invalid_model_source');
    return { ...(record.origin?{origin:record.origin}:{}),scope, id: record.id, version: record.version, kind: record.kind as MemorySource['kind'], text: record.text, createdAt: record.createdAt, messageRole: record.message?.role ?? null, sourceVersions:record.sources.map(ref=>({...ref})), evidenceEligible:record.evidenceEligible!==false };
  }
  #reference(record: MemoryRecord): MemoryReference {
    return { ...(record.origin?{origin:record.origin}:{}),characterId: record.characterId, id: record.id, version: record.version, text: record.text, sourceIds: [...new Set(record.sources.map(source => source.id))] };
  }
  #fits<T>(input: T, options: InputBudget<T>): boolean {
    const count = options.countTokens(structuredClone(input));
    if (!Number.isSafeInteger(count) || count < 0) throw new MemoryRuleError('invalid_token_count');
    return count <= options.inputTokenBudget;
  }
  #assertSources(scope: TurnScope, sources: readonly MemorySource[]): void {
    for (const source of sources) {
      const actual = this.store.inspect(scope, source.id);
      if (!sameScope(scope, source.scope) || !actual || actual.state !== 'active' || actual.version !== source.version || hash(this.#source(scope, actual)) !== hash(source)) throw new MemoryRuleError('stale_lifecycle_source');
    }
  }
  outcome(scope: TurnScope, currentMessageId: string, text: string): MemoryTurnOutcome | null {
    bindScope(scope, scope.characterId);
    const row = this.db.prepare('SELECT * FROM memory_turn_outcomes WHERE character_id=? AND current_message_id=?').get(scope.characterId, currentMessageId) as OutcomeRow | undefined;
    if (!row) return null;
    if (!sameScope(scope, JSON.parse(row.scope_json)) || row.text_hash !== hash(text)) throw new MemoryRuleError('processed_turn_identity_mismatch');
    return JSON.parse(row.outcome_json);
  }
  assertReady(): void {
    for (const characterId of ['companion'] as const) {
      const graph=sourceGraph(this.db,{characterId,sessionId:'lifecycle',turnId:'lifecycle',generation:0});
      const unsafe=[...graph.values()].filter(node=>node.kind==='transcript'&&!node.eligible);
      for (const root of unsafe) for(const id of descendants(graph,[root.id])) {
        const node=graph.get(id);
        if(id!==root.id && node?.state==='active' && ['memory','summary'].includes(node.kind)) throw new MemoryRuleError('unbound_assistant_derivatives');
      }
    }
  }
  bindAppendedUsers(scope:TurnScope,messages:readonly ConversationMessage[]):void {
    const owned=bindScope(scope,scope.characterId);
    for(const message of messages)if(message.role==='user') {
      this.#assertAppendedScope(owned,message.id);
      this.#appendedUsers.set(messageKey(owned,message.id),{scope:owned,textHash:hash(message.text)});
    }
  }
  #assertAppendedScope(scope:TurnScope,id:string):void {
    const binding=this.#appendedUsers.get(messageKey(scope,id));
    if(binding&&!sameScope(binding.scope,scope))throw new MemoryRuleError('current_message_scope_mismatch');
  }
  beginPendingMutation(scope:TurnScope,currentMessageId:string,pending:{request:'correction'|'forget'|'uncertain';sources:null}):void {
    const owned=bindScope(scope,scope.characterId);this.#assertAppendedScope(owned,currentMessageId);
    if(!this.#appendedUsers.get(messageKey(owned,currentMessageId)))throw new MemoryRuleError('pending_current_not_bound');
    if(pending.sources!==null)throw new MemoryRuleError('pending_targets_not_supported');
    this.db.transaction(()=>{const record=this.store.inspect(owned,currentMessageId);
      if(!record||record.message?.role!=='user'||record.state!=='active'||record.evidenceEligible===false)throw new MemoryRuleError('pending_current_unavailable');
      this.store.pending.begin(owned,currentMessageId,record.version,pending.request);
    }).immediate();
  }
  registerForegroundCurrent(scope:TurnScope,id:string,text:string):boolean {
    const owned=bindScope(scope,scope.characterId);
    return this.db.transaction(()=>{
      this.assertReady();this.#assertAppendedScope(owned,id);
      const binding=this.#appendedUsers.get(messageKey(owned,id));
      if(!binding)throw new MemoryRuleError('foreground_current_not_bound');
      const current=this.store.inspect(owned,id);
      const completedPending=this.store.pending.completed(owned,id,1);
      if(binding.textHash!==hash(text)||!current||current.kind!=='transcript'||(!completedPending&&(current.state!=='active'||current.version!==1||current.message?.role!=='user'||current.text!==text)))throw new MemoryRuleError('foreground_current_not_available');
      this.registerCurrent(owned,id,text);
      return completedPending;
    })();
  }
  registerCurrent(scope:TurnScope,id:string,text:string,outcome?:MemoryTurnOutcome):void {
    const owned=bindScope(scope,scope.characterId);this.#assertAppendedScope(owned,id);
    this.#currents.set(scopeKey(owned),{scope:owned,id,textHash:hash(text),displayOnly:outcome?.status==='needs_clarification'});
  }
  readTurn(scope: TurnScope, currentMessageId: string, text: string, options: TurnReadOptions): TurnTicket {
    const owned=bindScope(scope,scope.characterId);this.assertReady();this.#assertAppendedScope(owned,currentMessageId);this.store.pending.assertWritable(owned,currentMessageId);
    return this.db.transaction(()=>{
      const graph=sourceGraph(this.db,owned), current=this.store.inspect(owned,currentMessageId), node=graph.get(currentMessageId);
      if(!current||!node||current.kind!=='transcript'||current.state!=='active'||current.message?.role!=='user'||current.text!==text) throw new MemoryRuleError('current_message_not_available');
      this.store.pending.assertWritable(owned,currentMessageId,current.version);
      const chosen=new Map<string,MemoryRecord>([[currentMessageId,current]]);
      const input=():MemoryTurnInput=>({scope:owned,currentMessageId,sources:[...chosen.values()].map(record=>this.#source(owned,record)),
        messages:[...chosen.values()].filter(record=>record.kind==='transcript'&&record.id!==currentMessageId).sort((a,b)=>(a.logicalOrder??0)-(b.logicalOrder??0)||a.id.localeCompare(b.id)).map(record=>record.message!).concat(current.message!),
        relevantMemories:[...chosen.values()].filter(record=>record.kind==='memory').map(record=>this.#reference(record))});
      const fits=()=>{
        const records=[...chosen.values()];
        return records.filter(r=>r.kind==='memory').length<=options.maxMemories && records.filter(r=>r.kind==='transcript').length<=options.maxRecentMessages && records.filter(r=>r.kind==='summary').length<=options.summaryLimit && this.#fits(input(),options);
      };
      if(!fits())throw new MemoryRuleError('current_message_exceeds_turn_budget');
      const includeNodes=(ids:Iterable<string>,required:boolean)=>{
        const nodes=[...ids].map(key=>graph.get(key)).filter((item):item is NonNullable<typeof item>=>!!item&&readable(item));
        const added:string[]=[];
        const future=nodes.some(item=>item.kind==='transcript'&&item.order>=node.order&&item.id!==currentMessageId);
        if(!future)for(const item of nodes)if(!chosen.has(item.id)){chosen.set(item.id,this.store.inspect(owned,item.id)!);added.push(item.id);}
        if(future||!fits()){
          for(const key of added)chosen.delete(key);
          if(required)throw new MemoryRuleError(future?'turn_group_contains_future_source':'turn_source_group_exceeds_budget');
          return false;
        }
        return true;
      };
      const include=(id:string,required:boolean)=>{
        const core=related(graph,id);
        if(includeNodes(core,required))includeNodes(effectCandidates(graph,core),false);
      };
      include(currentMessageId,true);
      for(const memory of this.store.searchForMaintenance(owned,text,options.maxMemories,'lexical'))include(memory.id,true);
      const prior=[...graph.values()].filter(item=>readable(item)&&item.order<node.order&&!this.store.imports.isEvidence(owned,item.id)).sort((a,b)=>b.order-a.order||a.id.localeCompare(b.id));
      for(const item of prior.filter(item=>item.kind==='transcript').slice(0,Math.max(0,options.maxRecentMessages-1)))include(item.id,false);
      for(const item of prior.filter(item=>item.kind==='summary').slice(0,options.summaryLimit))include(item.id,true);
      const ticket=Object.freeze({input:structuredClone(input()),epoch:this.#epoch(owned),textHash:hash(text)});
      this.#turns.set(ticket,structuredClone(ticket));return ticket;
    })();
  }
  discardTurn(ticket: TurnTicket): void { this.#turns.delete(ticket); }
  #rejection(scope: TurnScope, plan: MemoryTurnPlan, reason: string): MemoryTurnOutcome {
    return { scope, request: ['none','correction','forget'].includes(plan.request) ? plan.request : 'none', status: 'rejected',
      results: (Array.isArray(plan.changes) ? plan.changes : []).map(change => ({ characterId: scope.characterId, operationId: change.operationId, status: 'rejected', affectedIds: [], retrievalInvalidated: false, reason })),
      affectedIds: [], retrievalInvalidated: false, clarification: null, rejectionCode:reason };
  }
  #assertTurn(ticket:TurnTicket,plan:MemoryTurnPlan):void {
    const scope=ticket.input.scope;
    if(!plan?.scope||!sameScope(plan.scope,scope)||!['none','correction','forget'].includes(plan.request)||!Array.isArray(plan.changes)||!Array.isArray(plan.suppressSources)||!plan.reason?.trim())throw new MemoryRuleError('invalid_turn_plan');
    if(this.#epoch(scope)!==ticket.epoch)throw new MemoryRuleError('stale_lifecycle_epoch');
    this.#assertSources(scope,ticket.input.sources);
    const current=ticket.input.sources.find(source=>source.id===ticket.input.currentMessageId);
    if(!current||current.kind!=='transcript'||current.messageRole!=='user'||hash(current.text)!==ticket.textHash)throw new MemoryRuleError('current_message_not_available');
    if(plan.clarification!==null&&(!plan.clarification?.trim()||plan.changes.length||plan.suppressSources.length||(plan.retainSources?.length??0)))throw new MemoryRuleError('clarification_with_mutations');
    this.#assertDynamics(ticket,plan);
  }
  #assertDynamics(ticket:TurnTicket,plan:MemoryTurnPlan):void {
    if(!plan.dynamics)return;
    const {traits,reinforcements}=plan.dynamics;
    if(!Array.isArray(traits)||!Array.isArray(reinforcements))throw new MemoryRuleError('invalid_dynamics_plan');
    if(plan.clarification!==null&&(traits.length||reinforcements.length))throw new MemoryRuleError('clarification_with_mutations');
    if(plan.request!=='none'&&reinforcements.length)throw new MemoryRuleError('correction_forget_cannot_reinforce');
    const known=new Map(ticket.input.sources.map(source=>[source.id,source]));
    const written=new Set(plan.changes.flatMap(({operation:op})=>op.type==='add'||op.type==='update'?[op.id]:op.type==='merge'?[op.replacement.id]:[]));
    for(const item of [...traits,...reinforcements]) {
      if(!Number.isSafeInteger(item.expectedVersion)||item.expectedVersion<1||(!written.has(item.recordId)&&known.get(item.recordId)?.kind!=='memory'))throw new MemoryRuleError('unread_dynamics_target');
    }
    for(const item of traits) {
      for(const ref of [...item.traits.evidenceSources,...item.traits.emotion.sources])if(known.get(ref.id)?.version!==ref.version)throw new MemoryRuleError('unread_dynamics_evidence');
    }
    for(const item of reinforcements)if(item.source.id!==ticket.input.currentMessageId||known.get(item.source.id)?.version!==item.source.version)throw new MemoryRuleError('reinforcement_not_current_user');
  }
  rejectTurn(ticket:TurnTicket,plan:MemoryTurnPlan,reason:string):MemoryTurnOutcome {
    const captured=this.#turns.get(ticket);this.#turns.delete(ticket);
    return this.#rejection((captured??ticket).input.scope,plan,reason);
  }
  /** Only absent necessary evidence permits a second plan. This path never applies a draft. */
  expandTurn(ticket:TurnTicket,proposal:MemoryTurnPlan,options:InputBudget<MemoryTurnInput>):TurnExpansion {
    const captured=this.#turns.get(ticket);
    if(!captured)return {status:'rejected',outcome:this.#rejection(ticket.input.scope,proposal,'unknown_or_consumed_turn')};
    const plan=structuredClone(proposal),scope=captured.input.scope;
    try{return this.db.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM memory_turn_outcomes WHERE character_id=? AND current_message_id=?').get(scope.characterId,captured.input.currentMessageId))return {status:'unchanged' as const};
      this.assertReady();this.#assertTurn(captured,plan);
      if(plan.clarification!==null)return {status:'unchanged' as const};
      const prepared=prepareSourcePlan(this.db,this.store,captured.input,plan);
      if(prepared.status==='ready')return {status:'unchanged' as const};
      const graph=sourceGraph(this.db,scope),cutoff=graph.get(captured.input.currentMessageId)!.order;
      const chosen=new Map(captured.input.sources.map(source=>[source.id,this.store.inspect(scope,source.id)!]));
      const pending=[...prepared.missing],seen=new Set<string>();
      for(let i=0;i<pending.length;i++){
        const ref=pending[i]!;if(seen.has(ref.id))continue;seen.add(ref.id);
        const node=graph.get(ref.id);
        if(!node||!readable(node)||node.version!==ref.version)throw new MemoryRuleError('required_source_unavailable');
        if(node.kind==='transcript'&&node.order>=cutoff&&node.id!==captured.input.currentMessageId)throw new MemoryRuleError('source_expansion_contains_future_message');
        if(!chosen.has(node.id))chosen.set(node.id,this.store.inspect(scope,node.id)!);
        // Read the registered valid supports of newly required text so unrelated fragments can
        // retain their evidence. Unavailable ancestors remain metadata, never reopened payloads.
        for(const support of node.sources){const parent=graph.get(support.id);if(parent&&readable(parent)&&parent.version===support.version&&!seen.has(parent.id))pending.push(support);}
      }
      const current=chosen.get(captured.input.currentMessageId)!;
      const input:MemoryTurnInput={scope,currentMessageId:captured.input.currentMessageId,
        sources:[...chosen.values()].map(record=>this.#source(scope,record)),
        messages:[...chosen.values()].filter(record=>record.kind==='transcript'&&record.id!==current.id).sort((a,b)=>(a.logicalOrder??0)-(b.logicalOrder??0)||a.id.localeCompare(b.id)).map(record=>record.message!).concat(current.message!),
        relevantMemories:[...chosen.values()].filter(record=>record.kind==='memory').map(record=>this.#reference(record))};
      // Necessary edit evidence is bounded by its actual provider wire, not the recent sample count.
      if(!this.#fits(input,options))throw new MemoryRuleError('source_expansion_exceeds_budget');
      const expanded=Object.freeze({input:structuredClone(input),epoch:captured.epoch,textHash:captured.textHash});
      this.#turns.set(expanded,structuredClone(expanded));this.#turns.delete(ticket);
      return {status:'expanded' as const,ticket:expanded};
    })();}catch(error){if(!(error instanceof MemoryRuleError))throw error;return {status:'rejected',outcome:this.#rejection(scope,plan,error.message)};}
  }
  commitTurn(ticket: TurnTicket, proposal: MemoryTurnPlan): MemoryTurnOutcome {
    const captured = this.#turns.get(ticket);
    this.#turns.delete(ticket);
    if (captured) ticket = captured;
    const scope = bindScope(ticket.input.scope, ticket.input.scope.characterId);
    if (!captured) return this.#rejection(scope, proposal, 'unknown_or_consumed_turn');
    const plan = structuredClone(proposal);
    try {
      return this.db.transaction(() => {
        const prior = this.db.prepare('SELECT * FROM memory_turn_outcomes WHERE character_id=? AND current_message_id=?').get(scope.characterId, ticket.input.currentMessageId) as OutcomeRow | undefined;
        if (prior) {
          if (sameScope(JSON.parse(prior.scope_json), scope) && prior.text_hash === ticket.textHash && prior.plan_hash === hash(plan)) return JSON.parse(prior.outcome_json) as MemoryTurnOutcome;
          throw new MemoryRuleError('turn_already_processed');
        }
        this.#assertTurn(ticket,plan);
        const base = { scope, request: plan.request, results: [] as readonly MemoryChangeResult[], affectedIds: [] as readonly string[], retrievalInvalidated: false, clarification: null };
        if (plan.clarification !== null) {
          if (!plan.clarification?.trim() || plan.changes.length || plan.suppressSources.length || (plan.retainSources?.length??0)) throw new MemoryRuleError('clarification_with_mutations');
          return { ...base, status: 'needs_clarification' as const, clarification: plan.clarification };
        }
        const {results,affectedIds}=applySourcePlan(this.db,this.store,ticket.input,plan,{prune:!this.managementCurrents.has(ticket.input.currentMessageId)});
        this.store.emotion.invalidate();
        this.store.recall.invalidate();
        const outcome:MemoryTurnOutcome={...base,status:affectedIds.length?'applied':'unchanged',results,affectedIds,retrievalInvalidated:affectedIds.length>0,rejectionCode:null};
        this.db.prepare('INSERT INTO memory_turn_outcomes(character_id,current_message_id,scope_json,text_hash,plan_hash,outcome_json) VALUES(?,?,?,?,?,?)')
          .run(scope.characterId, ticket.input.currentMessageId, JSON.stringify(scope), ticket.textHash, hash(plan), JSON.stringify(outcome));
        const dynamicIds=new Set<string>();
        const operationPrefix=`dynamics-turn:${hash([scopeKey(scope),ticket.input.currentMessageId])}`;
        for(const [index,item] of (plan.dynamics?.traits??[]).entries()) {
          this.store.dynamics.applyTraits(scope,{...item,operationId:`${operationPrefix}:traits:${index}`});dynamicIds.add(item.recordId);
        }
        for(const [index,item] of (plan.dynamics?.reinforcements??[]).entries()) {
          const result=this.store.dynamics.reinforce(scope,{...item,operationId:`${operationPrefix}:reinforce:${index}`});if(result.reinforced)dynamicIds.add(item.recordId);
        }
        const finalOutcome:MemoryTurnOutcome=dynamicIds.size?{...outcome,status:'applied',affectedIds:[...new Set([...outcome.affectedIds,...dynamicIds])],retrievalInvalidated:true}:outcome;
        this.db.prepare('UPDATE memory_turn_outcomes SET outcome_json=? WHERE character_id=? AND current_message_id=?').run(JSON.stringify(finalOutcome),scope.characterId,ticket.input.currentMessageId);
        this.store.pending.finish(scope,ticket.input.currentMessageId,finalOutcome);
        return finalOutcome;
      }).immediate();
    } catch (error) {
      if (!(error instanceof MemoryRuleError)) throw error; // Native errors must roll back and remain visible to the caller.
      return this.#rejection(scope, plan, error.message);
    }
  }
  trackContext(snapshot: ContextSnapshot, text: string, foreground=false): DialogueContext {
    const context = snapshot.context; const scope = bindScope(context.scope, context.scope.characterId);
    this.db.transaction(() => {
      this.assertReady();
      this.store.assertContextCurrent(scope, snapshot.revision);
      const sources = snapshot.selectedIds.map(id => { const record = this.store.inspect(scope, id)!; return {id, version: record.version}; });
      const addEmotionSources=(background:import('../contracts/emotion-state.js').EmotionBackground|undefined)=>{
        for(const state of background?[background.user,background.companion]:[])for(const ref of state.observation?.sources??[]){
          const actual=this.store.inspect(scope,ref.id);if(!actual||actual.state!=='active'||actual.version!==ref.version)throw new MemoryRuleError('stale_context');
          if(!sources.some(s=>s.id===ref.id&&s.version===ref.version))sources.push({...ref});
        }
      };
      addEmotionSources(context.emotionBackground);
      for(const message of context.recent){addEmotionSources(message.emotionSnapshot?.background);for(const obs of message.emotionSnapshot?.observations??[])for(const ref of obs.sources){
        const actual=this.store.inspect(scope,ref.id);if(!actual||actual.state!=='active'||actual.version!==ref.version)throw new MemoryRuleError('stale_context');
        if(!sources.some(s=>s.id===ref.id&&s.version===ref.version))sources.push({...ref});
      }}
      const candidate=this.#currents.get(scopeKey(scope));
      const identity=candidate&&sameScope(candidate.scope,scope)?candidate:undefined;
      const record=identity?this.store.inspect(scope,identity.id):null;
      if(identity && (identity.textHash!==hash(text)||!record||record.kind!=='transcript'))throw new MemoryRuleError('current_context_identity_mismatch');
      if(identity&&record)this.store.recall.capture(snapshot,snapshot.privacyExcluded?null:{id:record.id,version:record.version},sources);
      this.#contexts.set(context, { foreground,privacyExcluded:snapshot.privacyExcluded===true,pendingHolds:this.store.pending.contextBoundary(scope.characterId).holds,policyRevision:this.store.dynamics.policy().revision, ...(identity&&record?{current:{identity:structuredClone(identity),version:record.version,state:record.state}}:{}), scope, epoch: this.#epoch(scope), sources, fingerprint: hash(context), prompt: this.store.prompt(scope) });
    })();
    return context;
  }
  assertContextCurrent(context: DialogueContext): void {
    const stamp = this.#contexts.get(context);
    if (!stamp || hash(context) !== stamp.fingerprint) throw new MemoryRuleError('unissued_or_modified_context');
    this.db.transaction(() => {
      if (stamp.policyRevision!==this.store.dynamics.policy().revision || !sameScope(context.scope, stamp.scope) || (!stamp.foreground&&this.#epoch(stamp.scope) !== stamp.epoch) || this.store.prompt(stamp.scope) !== stamp.prompt) throw new MemoryRuleError('stale_context');
      if(!stamp.privacyExcluded&&this.store.pending.has(stamp.scope.characterId))throw new MemoryRuleError('stale_context');
      // Tightening privacy invalidates an issued context. Failed status or removal
      // of a hold does not invalidate a safe subset; source checks below still apply.
      if(this.store.pending.contextBoundary(stamp.scope.characterId).holds.some(hold=>!stamp.pendingHolds.includes(hold)))throw new MemoryRuleError('stale_context');
      for (const source of stamp.sources) {
        const actual = this.store.inspect(stamp.scope, source.id);
        if (!actual || actual.state !== 'active' || actual.version !== source.version) throw new MemoryRuleError('stale_context');
      }
    })();
  }
  /** Exact source selection of an issued preview; a second retrieval would misreport budget omissions. */
  contextSources(context:DialogueContext):readonly SourceVersion[] {
    this.assertContextCurrent(context);
    return structuredClone(this.#contexts.get(context)!.sources);
  }
  appendAssistant(scope:TurnScope,message:ConversationMessage,context:DialogueContext,currentMessageId:string,signal:AbortSignal):void {
    if(message.origin==='manual')throw new MemoryRuleError('manual_origin_requires_management');
    const checkAbort=()=>{if(signal.aborted)throw new MemoryRuleError('assistant_write_cancelled');};
    checkAbort();
    this.db.transaction(()=>{
      checkAbort();this.assertReady();const stamp=this.#contexts.get(context);
      if(!stamp||!stamp.current||stamp.current.identity.id!==currentMessageId||!sameScope(scope,stamp.scope)||!sameScope(stamp.current.identity.scope,scope)||message.characterId!==scope.characterId||message.role!=='assistant')throw new MemoryRuleError('assistant_context_identity_mismatch');
      const signature=assistantSignature(scope,message,currentMessageId);
      if(stamp.saved){
        if(stamp.saved.id!==message.id||stamp.saved.signature!==signature)throw new MemoryRuleError('assistant_context_already_used');
        const prior=this.store.inspect(scope,message.id);
        if(!prior?.message||messageHash(prior.message)!==messageHash(message))throw new MemoryRuleError('assistant_replay_conflict');
        this.assertContextCurrent(context);return;
      }
      this.assertContextCurrent(context);
      const current=this.store.inspect(scope,currentMessageId);
      const completedPending=stamp.privacyExcluded&&this.store.pending.completed(scope,currentMessageId,stamp.current.version);
      if(!current||(!completedPending&&(current.version!==stamp.current.version||current.state!==stamp.current.state||(current.state==='active'&&hash(current.text)!==stamp.current.identity.textHash))))throw new MemoryRuleError('stale_assistant_current');
      timestamp(message.createdAt);
      const backing=new SqliteLedgerBacking(this.db,scope.characterId);
      if(backing.records.has(message.id)||!message.id)throw new MemoryRuleError('duplicate_or_empty_id');
      const eligible=current.state==='active'&&!stamp.current.identity.displayOnly&&!stamp.privacyExcluded;
      const sources=new Map<string,SourceVersion>();
      if(eligible)for(const ref of [...stamp.sources,{id:current.id,version:current.version}]){
        const record=this.store.inspect(scope,ref.id)!;
        if(record.evidenceEligible===false)throw new MemoryRuleError('assistant_source_not_evidence');
        for(const ancestor of [...record.sources,ref])sources.set(ancestor.id,{...ancestor});
      }
      const record:MemoryRecord={...(message.origin?{origin:message.origin}:{}),characterId:scope.characterId,id:message.id,kind:'transcript',state:'active',version:1,text:message.text,sources:[...sources.values()],createdAt:message.createdAt,deletedAt:null,reason:eligible?null:'display_only_assistant',message:structuredClone(message),perception:null,evidenceEligible:eligible};
      checkAbort();this.store.recall.consumed(context);backing.records.set(record.id,record);
      this.store.emotion.captureMessage(scope,{id:record.id,version:record.version},message.emotionObservations??[]);
      for(const cache of backing.records.select('context_cache','active'))backing.records.set(cache.id,{...cache,state:'invalidated',text:'',version:cache.version+1,reason:'context_revision_changed'});
      backing.revision++;
      this.store.pruneForLifecycle();checkAbort();
    }).immediate();
    const stamp=this.#contexts.get(context)!;stamp.saved={id:message.id,signature:assistantSignature(scope,message,currentMessageId)};
  }
  #covered(scope: TurnScope, source: SourceVersion): boolean {
    return !!this.db.prepare("SELECT 1 FROM summary_coverage c JOIN memory_records s ON s.character_id=c.character_id AND s.id=c.summary_id WHERE c.character_id=? AND c.source_id=? AND c.source_version=? AND s.state='active'").get(scope.characterId, source.id, source.version);
  }
  readSummary(scope: TurnScope, options: SummaryReadOptions): SummaryTicket | SummaryResult {
    this.assertReady();
    const owned = bindScope(scope, scope.characterId);
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT r.* FROM memory_records r WHERE r.character_id=? AND r.kind='transcript' AND r.state='active' AND r.evidence_eligible=1
        AND NOT EXISTS(SELECT 1 FROM memory_import_evidence i WHERE i.character_id=r.character_id AND i.record_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM summary_coverage c JOIN memory_records s ON s.character_id=c.character_id AND s.id=c.summary_id
          WHERE c.character_id=r.character_id AND c.source_id=r.id AND c.source_version=r.version AND s.state='active') ORDER BY r.logical_order,r.rowid LIMIT ?`).all(owned.characterId, options.maxMessages) as RecordRow[];
      const unchanged = (reason: string): SummaryResult => ({ scope: owned, status: 'unchanged', summaryId: null, reason });
      if (rows.length < options.minMessages) return unchanged('summary_threshold_not_met');
      const sources: MemorySource[] = [];
      for (const record of rows.map(decodeRecord)) {
        sources.push(this.#source(owned, record));
        if (!this.#fits({scope: owned, sources}, options)) { sources.pop(); break; }
      }
      if (sources.length < options.minMessages) return { scope: owned, status: 'rejected' as const, summaryId: null, reason: 'summary_input_budget_too_small' };
      const ticket = Object.freeze({ input: {scope: owned, sources}, epoch: this.#epoch(owned) });
      this.#summaries.set(ticket, structuredClone(ticket)); return ticket;
    })();
  }
  discardSummary(ticket: SummaryTicket): void { this.#summaries.delete(ticket); }
  commitSummary(ticket: SummaryTicket, proposal: SummaryProposal): SummaryResult {
    const captured = this.#summaries.get(ticket);
    this.#summaries.delete(ticket);
    if (captured) ticket = captured;
    const scope = bindScope(ticket.input.scope, ticket.input.scope.characterId);
    const rejected = (reason: string): SummaryResult => ({scope, status: 'rejected', summaryId: null, reason});
    if (!captured) return rejected('unknown_or_consumed_summary');
    try {
      return this.db.transaction(() => {
        if (!sameScope(scope, proposal.scope) || !proposal.text?.trim()) throw new MemoryRuleError('invalid_summary_proposal');
        if (ticket.epoch !== this.#epoch(scope)) throw new MemoryRuleError('stale_lifecycle_epoch');
        this.#assertSources(scope, ticket.input.sources);
        const provided = new Map(proposal.sourceVersions.map(source => [source.id, source.version]));
        if (provided.size !== proposal.sourceVersions.length || provided.size !== ticket.input.sources.length || ticket.input.sources.some(source => provided.get(source.id) !== source.version)) throw new MemoryRuleError('summary_source_versions_mismatch');
        const covered = ticket.input.sources.filter(source => this.#covered(scope, source));
        if (covered.length === ticket.input.sources.length) return {scope, status: 'unchanged' as const, summaryId: null, reason: 'summary_sources_already_covered'};
        if (covered.length) throw new MemoryRuleError('summary_sources_partially_covered');
        const id = `summary:${randomUUID()}`;
        this.#ledger(scope).recordDerived(scope, {id, kind:'summary', text:proposal.text, sourceIds:ticket.input.sources.map(source => source.id), createdAt:this.store.now()});
        for (const source of ticket.input.sources) this.db.prepare('INSERT INTO summary_coverage(character_id,source_id,source_version,summary_id) VALUES(?,?,?,?)').run(scope.characterId, source.id, source.version, id);
        return {scope, status:'applied' as const, summaryId:id, reason:null};
      }).immediate();
    } catch (error) { if (!(error instanceof MemoryRuleError)) throw error; return rejected(error.message); }
  }
}
