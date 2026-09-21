import { EMOTION_RESPONSE_RULES } from '../../providers/emotion-inference.js';
import { DIALOGUE_RESPONSE_RULES } from '../../companion/dialogue-rules.js';

/** Adapt synthetic historical fixtures to current product admission. Does not edit raw text,
 * request strings, hashes, source IDs, versions, sessions or saved fixture modules.
 * This is a current-product regression, not a replay of the original product identity. */
export function companionFixture<T>(value:T):T {
  return JSON.parse(JSON.stringify(value), (key, item) => key==='characterId' && item==='friend' ? 'companion' : item) as T;
}

/** B51 emotion protocol is independently checked in emotion-inference.test;
 * Presentation/manual-edit rules and B-COMPANION-FEEDBACK-01's exact shared policy
 * postdate the frozen factor experiments. Compare the old prefix separately from
 * these identified additions, without regenerating raw fixtures or reclassifying
 * their semantic failures. spoken-text.test independently checks policy composition. */
export function historicalDialoguePrefix(current:string):string {
  const lines=current.replace(`\n${DIALOGUE_RESPONSE_RULES}`, '').replace(`\n${EMOTION_RESPONSE_RULES}`, '').split('\n');
  return lines.filter(line=>!line.startsWith('expression描述助手本轮回复的表达') && !line.startsWith('origin为manual的资料由用户在管理页人工编辑')).join('\n');
}
