import type { DialogueContext, MemoryReference, PerceptionResult, TurnScope } from '../contracts/index.js';
import { characterPrompt } from '../companion/prompts.js';
import type { ContextRecords } from './ledger.js';
import { bindScope, sameScope, timestamp } from './scope.js';

export interface ContextReader {
  readonly characterId: TurnScope['characterId'];
  contextRecords(scope: TurnScope): ContextRecords;
  assertContextCurrent(scope: TurnScope, revision: number): void;
}
export interface ContextOptions {
  readonly messageEmotions?: readonly import('../contracts/emotion-state.js').EmotionMessageSnapshot[];
  readonly emotionBackground?: import('../contracts/emotion-state.js').EmotionBackground;
  readonly memoryTieBreak?: (a:MemoryReference,b:MemoryReference)=>number;
  readonly prompts: Parameters<typeof characterPrompt>[1];
  readonly inputTokenBudget: number;
  readonly maxRecentMessages: number;
  readonly maxMemories: number;
  /** Must account for the actual provider prompt format AND this turn's text. No built-in tokenizer estimate. */
  readonly countTokens: (context: DialogueContext, currentText: string) => number;
  /** Receives only current-character records. Real retrieval quality remains an independent validation. */
  readonly relevance: (memory: MemoryReference, query: string) => number;
}
export interface ContextSnapshot {
  readonly privacyExcluded?:boolean;
  readonly recall?: import('./sqlite-recall.js').RecallAssembly;
  readonly context: DialogueContext;
  readonly revision: number;
  readonly countedInputTokens: number;
  readonly selectedIds: readonly string[];
  readonly omittedIds: readonly string[];
}

/** Synchronous assembly. Caller must assert the revision again before consuming any retained snapshot. */
export function assembleContext(ledger: ContextReader, scope: TurnScope, text: string, perception: PerceptionResult | null, now: string, options: ContextOptions): ContextSnapshot {
  const owned = bindScope(scope, ledger.characterId);
  const at = timestamp(now);
  for (const value of [options.inputTokenBudget, options.maxRecentMessages, options.maxMemories]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_context_budget');
  }
  if (options.inputTokenBudget === 0) throw new Error('invalid_context_budget');
  if (perception && !sameScope(owned, perception.scope)) throw new Error('perception_scope_mismatch');
  const currentPerception = perception ? structuredClone({ ...perception, cues: perception.cues.filter(cue => timestamp(cue.expiresAt) > at) }) : null;
  const data = ledger.contextRecords(owned);
  let context: DialogueContext = {
    scope: owned, characterPrompt: characterPrompt(ledger.characterId, options.prompts), recent: [], summary: '', memories: [],
    perception: currentPerception, inputTokenBudget: options.inputTokenBudget,
  };
  const count = (value: DialogueContext): number => {
    const result = options.countTokens(structuredClone(value), text);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error('invalid_token_count');
    return result;
  };
  let countedInputTokens = count(context);
  if (countedInputTokens > options.inputTokenBudget) throw new Error('required_context_exceeds_budget');
  const selectedIds: string[] = [];
  const omittedIds: string[] = [];
  const consider = (id: string, candidate: DialogueContext) => {
    const tokens = count(candidate);
    if (tokens <= options.inputTokenBudget) {
      context = candidate; countedInputTokens = tokens; selectedIds.push(id);
    } else omittedIds.push(id);
  };
  // Select a contiguous suffix of complete turns. An explicitly edited manual
  // record is independent human evidence, even when its original user turn is
  // absent. Ordinary orphan assistant output still cannot enter the context.
  const turns: typeof data.recent[]=[];
  for(const message of data.recent){
    if(message.role==='user'||message.origin==='manual'&&!turns.length)turns.push([message]);
    else if(turns.length)turns[turns.length-1]=[...turns[turns.length-1]!,message];
    else omittedIds.push(message.id);
  }
  let stopped=false;
  for(const turn of turns.reverse()){
    const candidate={...context,recent:[...turn,...context.recent]};
    const tokens=stopped?Infinity:count(candidate);
    if(stopped||candidate.recent.length>options.maxRecentMessages||tokens>options.inputTokenBudget){
      stopped=true;omittedIds.push(...turn.map(m=>m.id));
    }else{context=candidate;countedInputTokens=tokens;selectedIds.push(...turn.map(m=>m.id));}
  }
  for (const summary of [...data.summaries].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || a.id.localeCompare(b.id))) {
    const summaryText=summary.origin==='manual'?`[人工编辑摘要] ${summary.text}`:summary.text;
    consider(summary.id, { ...context, summary: [context.summary, summaryText].filter(Boolean).join('\n') });
  }
  const candidates = data.memories.map(memory => {
    const score = options.relevance(structuredClone(memory), text);
    if (!Number.isFinite(score)) throw new Error('invalid_relevance_score');
    return { memory, score };
  }).sort((a, b) => b.score - a.score || options.memoryTieBreak?.(a.memory,b.memory) || a.memory.id.localeCompare(b.memory.id));
  for (const { memory, score } of candidates) {
    if (score <= 0 || context.memories.length >= options.maxMemories) { omittedIds.push(memory.id); continue; }
    consider(memory.id, { ...context, memories: [...context.memories, memory] });
  }
  if(options.messageEmotions?.length){
    const metadata=new Map(options.messageEmotions.map(m=>[m.message.id,m]));
    const candidate={...context,recent:context.recent.map(m=>metadata.has(m.id)?{...m,emotionSnapshot:metadata.get(m.id)!}:m)};
    const tokens=count(candidate);if(tokens<=options.inputTokenBudget){context=candidate;countedInputTokens=tokens;}
  }
  // Optional emotion metadata receives remaining space only after recent dialogue, summaries and relevant memories.
  if(options.emotionBackground){
    const candidate={...context,emotionBackground:options.emotionBackground};
    const tokens=count(candidate);if(tokens<=options.inputTokenBudget){context=candidate;countedInputTokens=tokens;}
  }
  ledger.assertContextCurrent(owned, data.revision);
  return { context: structuredClone(context), revision: data.revision, countedInputTokens, selectedIds, omittedIds };
}
