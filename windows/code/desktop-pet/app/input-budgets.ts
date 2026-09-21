import { EMOTION_RESPONSE_RULES } from '../providers/emotion-inference.js';
import type { DialogueContext } from '../contracts/index.js';
import type { MemoryTurnInput, SummaryInput } from '../contracts/memory-lifecycle.js';
import { SUMMARY_PROMPT } from '../providers/memory-lifecycle-prompt.js';
import { checkedSources, MemoryWire, type MemoryWireMode } from '../providers/memory-wire.js';
import { buildMemoryTurnFormat } from '../providers/memory-turn-format.js';
import { DIALOGUE_RESPONSE_RULES } from '../companion/dialogue-rules.js';

/** Conservative UTF-8 byte upper bounds, including current provider instructions and framing.
 * These are not exact tokenizer counts. No bound is applied to the reply's output length. */
export function contextInputUpperBound(context: DialogueContext, currentText: string): number {
  return Buffer.byteLength(JSON.stringify({ context, currentText }), 'utf8') + 4096
    + Buffer.byteLength(JSON.stringify(`\n${DIALOGUE_RESPONSE_RULES}\n${EMOTION_RESPONSE_RULES}`), 'utf8');
}
export function memoryTurnInputUpperBound(input: MemoryTurnInput, mode: MemoryWireMode = 'numeric-v1'): number {
  const format = buildMemoryTurnFormat(input, mode);
  return Buffer.byteLength(JSON.stringify(format.data), 'utf8') + Buffer.byteLength(format.system, 'utf8') + 2048;
}
export function summaryInputUpperBound(input: SummaryInput): number {
  const wire = new MemoryWire(checkedSources(input.scope, input.sources));
  return Buffer.byteLength(JSON.stringify(wire.data()), 'utf8') + Buffer.byteLength(SUMMARY_PROMPT, 'utf8') + 2048;
}
