import type { DialogueRequest } from '../contracts/index.js';
import type { EmotionAssessment, EmotionObservation } from '../contracts/emotion-state.js';

export const EMOTION_RESPONSE_RULES = `同时返回emotionAssessment:{"user":null,"companion":null}。两个值各自可为null（本轮无新依据，保持原背景），或{label:简短情绪词,intensity:null,confidence:null}。user的label使用neutral/happy/sad/angry/fear/disgust/surprise/unknown；user结合本轮用户文字、最近连续对话和实际感知推测用户此刻的情绪；companion独立描述助手自己的持续心情，可为关心或平静，不要复制用户难过。expression只是本轮表现，不能代替这两个判断。没有可靠强度或置信度时分别填null，不把类别换算成数字。“嗯”“然后呢”等无新线索允许null；用户明确否认旧判断且无法确认新情绪时label用unknown、两数值null。第三人称“朋友今天很难过”、过去时“以前很难过，现在好多了”、假设“如果没通过我会很难过”不能直接标为用户现在难过。近期用户纠正优先，背景只是历史线索。`;
export function normalizeUserEmotion(value:string):string|null {
  const aliases:Record<string,string>={neutral:'neutral',平静:'neutral',中性:'neutral',happy:'happy',开心:'happy',高兴:'happy',快乐:'happy',sad:'sad',难过:'sad',伤心:'sad',悲伤:'sad',angry:'angry',生气:'angry',愤怒:'angry',fear:'fear',fearful:'fear',害怕:'fear',disgust:'disgust',disgusted:'disgust',厌恶:'disgust',surprise:'surprise',surprised:'surprise',惊讶:'surprise',unknown:'unknown',未知:'unknown',未确定:'unknown'};
  return aliases[value.trim().toLowerCase()]??null;
}
const score = (v: unknown): v is number | null => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
/** Optional metadata fails independently; never discards an otherwise usable spoken reply. */
export function parseEmotionAssessment(raw: unknown, request: DialogueRequest): EmotionAssessment | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string,unknown>;
  const current = request.context.recent.find(m => m.id === `${request.scope.turnId}:user`);
  if (!current || current.role !== 'user' || current.text !== request.text) return undefined;
  const source = current.emotionSnapshot?.message ?? {id:current.id,version:1};
  const parse = (subject:'user'|'companion'): EmotionObservation | null => {
    const v=value[subject];
    if (v === null) return null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('invalid_emotion');
    const item = v as Record<string,unknown>;
    if (typeof item.label !== 'string' || !item.label.trim() || item.label.length>80 || /[\u0000-\u001f]/.test(item.label)
      || !score(item.intensity) || !score(item.confidence)) throw Error('invalid_emotion');
    const label=subject==='user'?normalizeUserEmotion(item.label):item.label.trim();if(!label)throw Error('invalid_emotion');
    return {subject,label,intensity:item.intensity,confidence:item.confidence,
      provenance:subject==='user'?'text_recent_context':'companion_inference',sources:[source]};
  };
  try { return {user:parse('user'),companion:parse('companion')}; } catch { return undefined; }
}
