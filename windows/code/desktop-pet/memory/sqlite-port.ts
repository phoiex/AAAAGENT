import type { ConversationMessage, DialogueContext, MemoryChangeResult, MemoryMaintenanceInput, MemoryMaintenanceProvider, MemoryPort, PerceptionResult, TurnScope } from '../contracts/index.js';
import { assembleContext, type ContextOptions, type ContextSnapshot } from './context.js';
import { bindScope, sameScope } from './scope.js';
import { SqliteMemoryStore } from './sqlite-store.js';

export interface SqliteContextOptions extends Omit<ContextOptions, 'prompts'> { readonly summaryLimit: number }
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new Error('memory_cancelled'); }
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('memory_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Scheduling belongs to the application: exactly one caller queues maintenance after append commits. */
export class SqliteMemoryPort implements MemoryPort {
  constructor(readonly store: SqliteMemoryStore, private readonly options: SqliteContextOptions, private readonly provider?: MemoryMaintenanceProvider) {}
  async append(scope: TurnScope, messages: readonly ConversationMessage[]): Promise<void> { this.store.append(scope, messages); }
  async context(scope: TurnScope, text: string, perception: PerceptionResult | null, signal: AbortSignal): Promise<DialogueContext> {
    return this.createContext(scope, text, perception, signal).context;
  }
  protected createContext(scope: TurnScope, text: string, perception: PerceptionResult | null, signal: AbortSignal, excludePersonal=false): ContextSnapshot {
    checkAbort(signal); const owned = bindScope(scope, scope.characterId);
    if (perception && !sameScope(owned, perception.scope)) throw new Error('perception_scope_mismatch');
    if (perception) {
      const source = this.store.inspect(owned, `${owned.turnId}:user`);
      if (source?.state === 'active') this.store.recordPerception(owned, perception, [source.id]);
    }
    const privacyExcluded=excludePersonal||this.store.pending.has(owned.characterId);
    const data = privacyExcluded?this.store.protectedRecent(owned,excludePersonal?0:this.options.maxRecentMessages):this.store.contextRecords(owned, text, this.options.maxRecentMessages, this.options.maxMemories, this.options.summaryLimit);
    const evaluatedAt=this.store.now(),policyRevision=this.store.dynamics.policy().revision;
    const candidates=privacyExcluded?[]:this.store.recall.rank(owned,text,evaluatedAt);
    const scores=new Map(candidates.map(candidate=>[candidate.source.id,candidate.priority]));
    const snapshot = assembleContext({ characterId: owned.characterId, contextRecords: requested => {
      bindScope(requested, owned.characterId); return {...data,memories:this.store.recall.references(owned,candidates)};
    }, assertContextCurrent: (requested, revision) => this.store.assertContextCurrent(requested, revision) }, owned, text, privacyExcluded?null:perception, this.store.now(), {
      ...this.options, ...(!privacyExcluded?{emotionBackground:this.store.emotion.background(owned),messageEmotions:data.recent.flatMap(m=>{const value=this.store.emotion.message(owned,m.id);return value?[value]:[]})}:{}),
      memoryTieBreak:(a,b)=>candidates.findIndex(x=>x.source.id===a.id)-candidates.findIndex(x=>x.source.id===b.id), maxMemories:Math.min(6,this.options.maxMemories), relevance:memory=>scores.get(memory.id)??0, prompts: { [owned.characterId]: this.store.prompt(owned) },
    });
    checkAbort(signal); return {...snapshot,privacyExcluded,recall:{candidates,policyRevision,evaluatedAt,dataRevision:data.revision}};
  }
  maintenanceInput(scope: TurnScope, text: string): MemoryMaintenanceInput {
    const owned = bindScope(scope, scope.characterId);
    const data = this.store.contextRecords(owned, text, this.options.maxRecentMessages, this.options.maxMemories, this.options.summaryLimit,'maintenance');
    return { scope: owned, messages: data.recent, relevantMemories: data.memories };
  }
  async maintain(input: MemoryMaintenanceInput, signal: AbortSignal): Promise<readonly MemoryChangeResult[]> {
    checkAbort(signal);
    if (!this.provider) throw new Error('memory_maintenance_provider_not_configured');
    const task = this.store.prepareMaintenance(input);
    try {
      const changes = await abortable(this.provider.propose(structuredClone(task.input), signal), signal);
      checkAbort(signal);
      return this.store.finishMaintenance(task, changes);
    } catch (error) {
      if (!this.store.closed) this.store.cancelMaintenance(task);
      throw error;
    }
  }
}
