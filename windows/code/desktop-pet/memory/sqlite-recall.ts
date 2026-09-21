import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DialogueContext, TurnScope, MemoryReference } from '../contracts/index.js';
import { MEMORY_DAY_TIME_ZONE, type MemoryRecallCandidate, type MemoryRecallTrace, type MemoryRecallTracePage, type MemoryDynamicsPageQuery, type MemoryDynamicsSnapshot, type MemoryPolicyPreviewInput, type MemoryPolicyPreview } from '../contracts/memory-dynamics.js';
import type { SourceVersion } from '../contracts/memory-lifecycle.js';
import type { EmotionStatePort } from '../contracts/emotion-state.js';
import type { SqliteMemoryStore } from './sqlite-store.js';
import type { ContextSnapshot } from './context.js';
import { decodeRecord, type RecordRow } from './sqlite-backing.js';
import { scoreCue } from './dynamics-cues.js';
import { evolve, priority } from './dynamics.js';
import { policyParameters } from './dynamics-policy.js';
import { bindScope, timestamp, MemoryRuleError } from './scope.js';

const owned=(characterId:TurnScope['characterId']):TurnScope=>bindScope({characterId,sessionId:'management-dynamics',turnId:'read',generation:0},characterId);
const paginate=(offset:number,limit:number):void=>{if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new MemoryRuleError('invalid_management_request');};
export interface RecallAssembly {readonly candidates:readonly MemoryRecallCandidate[];readonly policyRevision:number;readonly evaluatedAt:string;readonly dataRevision:number}
export class SqliteMemoryRecall {
  private readonly actual=new WeakMap<DialogueContext,string>();
  constructor(private readonly db:Database.Database,private readonly store:SqliteMemoryStore,private readonly emotions?:Pick<EmotionStatePort,'affinity'>) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_recall_trace(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,payload_json TEXT NOT NULL,sources_json TEXT NOT NULL);`);
  }
  rank(scope:TurnScope,query:string,at=this.store.now(),preview?:MemoryPolicyPreviewInput['policy'],effectiveFrom=this.store.now()):readonly MemoryRecallCandidate[] {
    bindScope(scope,scope.characterId);
    const rows=this.db.prepare("SELECT * FROM memory_records WHERE character_id=? AND kind='memory'").all(scope.characterId) as RecordRow[];
    const parameters=policyParameters(preview??this.store.dynamics.policy().policy);
    const ranked=rows.map(row=>{
      const record=decodeRecord(row),state=this.store.dynamics.state(scope,record.id,preview?effectiveFrom:at);
      const gate=this.store.pending.has(scope.characterId)||record.state!=='active'||record.evidenceEligible===false||!state;
      const future=preview&&state?evolve({activity:state.activation,emotion:state.emotion,importance:state.traits.importance,stable:state.traits.category==='stable_profile',elapsedMs:timestamp(at)-timestamp(effectiveFrom)},parameters):null;
      const cue=gate?null:scoreCue(query,record.text),activation=gate?0:future?.activity??state!.activation,emotion=gate?0:future?.emotion??state!.emotion;
      const relevance=cue?.score??0,importance=gate?0:state!.traits.importance;
      const score=gate?0:priority({cue:relevance,activity:activation,importance,emotion},parameters);
      const omission=gate?'hard_gate':relevance===0?'no_cue':score<0.35?'below_threshold':null;
      const cueKind=cue?.phrase?'phrase':cue?.relation&&relevance===0.8?'supported_relation':relevance>0?'keywords':'none';
      const emotionAffinity=this.emotions&&!gate?this.emotions.affinity(scope,this.sourceLineage(scope,record.sources)):undefined;
      return {source:{id:record.id,version:record.version},activation,importance,emotion,relevance,priority:score,matchedTerms:cue?.matchedKeywords??[],cueKind,selected:omission===null,omission,
        ...(emotionAffinity===undefined?{}:{emotionAffinity})} as MemoryRecallCandidate;
    }).sort((a,b)=>b.priority-a.priority||(b.emotionAffinity??0)-(a.emotionAffinity??0)||a.source.id.localeCompare(b.source.id));
    let selected=0;
    return ranked.map(candidate=>candidate.selected&&++selected>6?{...candidate,selected:false,omission:'limit'}:candidate);
  }
  references(scope:TurnScope,candidates:readonly MemoryRecallCandidate[]):readonly MemoryReference[] {
    return candidates.filter(item=>item.omission===null||item.omission==='limit').map(item=>{
      const record=this.store.inspect(scope,item.source.id)!;
      return {characterId:scope.characterId,id:record.id,version:record.version,text:record.text,sourceIds:record.sources.map(ref=>ref.id),...(record.origin?{origin:record.origin}:{})};
    });
  }
  private sourceLineage(scope:TurnScope,initial:readonly SourceVersion[]):readonly SourceVersion[] {
    const found=new Map<string,SourceVersion>(),queue=[...initial];
    while(queue.length) {
      const ref=queue.shift()!,key=`${ref.id}\0${ref.version}`;
      if(found.has(key))continue;
      const record=this.store.inspect(scope,ref.id);
      if(!record||record.state!=='active'||record.version!==ref.version)continue;
      found.set(key,ref);queue.push(...record.sources);
    }
    return [...found.values()];
  }
  snapshot(query:MemoryDynamicsPageQuery):MemoryDynamicsSnapshot {
    const scope=owned(query.characterId);paginate(query.offset,query.limit);
    if(typeof query.query!=='string'||!['active','all'].includes(query.state))throw new MemoryRuleError('invalid_management_request');
    return this.db.transaction(()=>{
      const at=this.store.now(),where="character_id=? AND (?='all' OR state='active') AND (?='' OR id=? OR instr(lower(text),lower(?))>0)",args=[scope.characterId,query.state,query.query,query.query,query.query];
      const total=(this.db.prepare(`SELECT count(*) AS n FROM memory_records WHERE ${where}`).get(...args) as {n:number}).n;
      const rows=this.db.prepare(`SELECT * FROM memory_records WHERE ${where} ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,logical_order DESC,id LIMIT ? OFFSET ?`).all(...args,query.query,query.limit,query.offset) as RecordRow[];
      const edges=this.db.prepare('SELECT id,sources_json FROM memory_records WHERE character_id=?').all(scope.characterId) as {id:string;sources_json:string}[];
      return {characterId:scope.characterId,dataRevision:this.store.revision(scope),evaluatedAt:at,policy:this.store.dynamics.policy(),policyHistory:this.store.dynamics.history(),total,offset:query.offset,limit:query.limit,timeZone:MEMORY_DAY_TIME_ZONE,
        items:rows.map(row=>{const r=decodeRecord(row);return {record:{characterId:r.characterId,id:r.id,kind:r.kind,version:r.version,state:r.state,text:r.text,createdAt:r.createdAt,role:r.message?.role??null,sources:r.sources,editable:r.state==='active'&&['memory','transcript','summary'].includes(r.kind),origin:r.origin??(r.kind==='transcript'?'conversation':'automatic')},dynamics:this.store.dynamics.state(scope,r.id,at),relatedIds:edges.filter(edge=>(JSON.parse(edge.sources_json) as SourceVersion[]).some(ref=>ref.id===r.id)).map(edge=>edge.id)};})};
    })();
  }
  preview(input:MemoryPolicyPreviewInput):MemoryPolicyPreview {
    const scope=owned(input.characterId);policyParameters(input.policy);
    if(typeof input.query!=='string')throw new MemoryRuleError('invalid_management_request');
    return this.db.transaction(()=>{
      const now=this.store.now(),evaluatedAt=input.evaluatedAt==='now'?now:input.evaluatedAt;if(timestamp(evaluatedAt)<timestamp(now))throw new MemoryRuleError('preview_before_effective_time');
      if(this.store.revision(scope)!==input.expectedDataRevision||this.store.dynamics.policy().revision!==input.expectedPolicyRevision)throw new MemoryRuleError('version_conflict');
      return {kind:'preview' as const,characterId:scope.characterId,dataRevision:input.expectedDataRevision,policyRevision:input.expectedPolicyRevision,evaluatedAt,effectiveFrom:now,
        before:this.rank(scope,input.query,evaluatedAt),after:this.rank(scope,input.query,evaluatedAt,input.policy,now)};
    })();
  }
  /** Called only after a foreground current-message identity was verified, never for management previews. */
  capture(snapshot:ContextSnapshot,current:SourceVersion|null,sources:readonly SourceVersion[]):void {
    const assembly=snapshot.recall;if(!assembly)return;
    const context=snapshot.context;
    if(assembly.policyRevision!==this.store.dynamics.policy().revision)throw new MemoryRuleError('stale_context');
    const selected=new Set(context.memories.map(item=>item.id));
    const candidates=assembly.candidates.map(candidate=>{
      if(selected.has(candidate.source.id))return {...candidate,selected:true,omission:null};
      if(candidate.omission===null||candidate.omission==='limit')return {...candidate,selected:false,omission:selected.size>=6?'limit' as const:'budget' as const};
      return candidate;
    });
    const trace:MemoryRecallTrace={id:randomUUID(),kind:'actual',scope:context.scope,dataRevision:assembly.dataRevision,policyRevision:assembly.policyRevision,evaluatedAt:assembly.evaluatedAt,candidates,countedInputTokens:snapshot.countedInputTokens,inputTokenBudget:context.inputTokenBudget,status:'assembled',
      recentContext:{messageIds:context.recent.map(m=>m.id),omittedIds:snapshot.omittedIds.filter(id=>this.store.inspect(context.scope,id)?.kind==='transcript'),policy:snapshot.privacyExcluded?'post_privacy_boundary':'normal'}};
    // Include query provenance and unselected scored records: they may contain forgotten matched terms.
    const refs=new Map([...sources,...(current?[current]:[]),...candidates.filter(item=>item.omission!=='hard_gate').map(item=>item.source)].map(ref=>[ref.id,ref]));
    this.db.prepare('INSERT INTO memory_recall_trace VALUES(?,?,?,?)').run(trace.id,context.scope.characterId,JSON.stringify(trace),JSON.stringify([...refs.values()]));
    this.actual.set(context,trace.id);
  }
  consumed(context:DialogueContext):void {
    const id=this.actual.get(context);if(!id)return;
    const row=this.db.prepare('SELECT payload_json FROM memory_recall_trace WHERE id=?').get(id) as {payload_json:string}|undefined;
    if(!row)return;const trace=JSON.parse(row.payload_json) as MemoryRecallTrace;
    // Audit candidates include unselected records. Their redaction must not reject a
    // reply whose actual source versions were already checked by lifecycle state.
    if(trace.status==='invalidated')return;
    this.db.prepare('UPDATE memory_recall_trace SET payload_json=? WHERE id=?').run(JSON.stringify({...trace,status:'consumed'}),id);
  }
  invalidate():void {
    const rows=this.db.prepare('SELECT id,character_id,payload_json,sources_json FROM memory_recall_trace').all() as {id:string;character_id:TurnScope['characterId'];payload_json:string;sources_json:string}[];
    for(const row of rows) {
      const trace=JSON.parse(row.payload_json) as MemoryRecallTrace;if(trace.status==='invalidated')continue;
      if((JSON.parse(row.sources_json) as SourceVersion[]).some(ref=>{const record=this.store.inspect(owned(row.character_id),ref.id);return !record||record.state!=='active'||record.version!==ref.version;}))
        this.db.prepare('UPDATE memory_recall_trace SET payload_json=?,sources_json=? WHERE id=?').run(JSON.stringify({...trace,status:'invalidated',candidates:[]}), '[]',row.id);
    }
  }
  traces(query:{characterId:TurnScope['characterId'];offset:number;limit:number}):MemoryRecallTracePage {
    const scope=owned(query.characterId);paginate(query.offset,query.limit);
    return this.db.transaction(()=>{
      const total=(this.db.prepare('SELECT count(*) AS n FROM memory_recall_trace WHERE character_id=?').get(scope.characterId) as {n:number}).n;
      const rows=this.db.prepare('SELECT payload_json,sources_json FROM memory_recall_trace WHERE character_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(scope.characterId,query.limit,query.offset) as {payload_json:string;sources_json:string}[];
      return {characterId:scope.characterId,total,offset:query.offset,limit:query.limit,records:rows.map(row=>{
        const trace=JSON.parse(row.payload_json) as MemoryRecallTrace;
        const valid=(JSON.parse(row.sources_json) as SourceVersion[]).every(ref=>{const record=this.store.inspect(scope,ref.id);return record?.state==='active'&&record.version===ref.version;});
        return valid?trace:{...trace,status:'invalidated' as const,candidates:[]};
      })};
    })();
  }
}
