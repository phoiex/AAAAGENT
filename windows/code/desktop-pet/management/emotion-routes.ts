import type { IncomingMessage } from 'node:http';
import { EMOTION_STATE_VERSION, type EmotionManagement } from '../contracts/emotion-state.js';
import { isProductCharacter } from '../contracts/character.js';
import { ManagementError } from '../contracts/management.js';

/** Authenticated read-only metadata; no source text, mutation or model scheduling. */
export async function emotionRoute(req:IncomingMessage,url:URL,port:EmotionManagement|undefined,instanceId:string,
  respond:(value:unknown)=>void):Promise<boolean> {
  if(url.pathname!=='/api/emotion')return false;
  if(req.method!=='GET')throw new ManagementError('not_found','当前情绪提供只读查看。');
  if(!port)throw new ManagementError('unavailable','当前版本尚未接入情绪记录。');
  const characterId=url.searchParams.get('characterId');
  if(!isProductCharacter(characterId))throw new ManagementError('invalid_request','请选择有效角色。');
  const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??20);
  if(!Number.isSafeInteger(offset)||offset<0||offset>1_000_000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ManagementError('invalid_request','分页参数无效。');
  respond({...await port.snapshot(characterId,offset,limit),instanceId,version:EMOTION_STATE_VERSION});return true;
}
