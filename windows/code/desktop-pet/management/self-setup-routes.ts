import { normalizeApiKey } from '../core/api-key.js';
import type { IncomingMessage } from 'node:http';
import { ManagementError } from '../contracts/management.js';
import type { SelfSetupManagement } from '../contracts/self-setup.js';
function invalid():never {throw new ManagementError('invalid_request','自助配置请求格式无效。');}
const text=(x:unknown,max=200):string=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\u0000-\u001f\u007f]/.test(x)?x:invalid();
const revision=(x:unknown):number=>Number.isSafeInteger(x)&&Number(x)>=0?Number(x):invalid();
function exact(value:Record<string,unknown>,keys:string[]):void{if(Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))invalid();}
export async function selfSetupRoute(req:IncomingMessage,url:URL,setup:SelfSetupManagement|undefined,body:(limit?:number)=>Promise<Record<string,unknown>>,reply:(value:unknown)=>void,audio:(bytes:Uint8Array,mime:string)=>void):Promise<boolean>{
 if(!url.pathname.startsWith('/api/self-setup'))return false;
 if(!setup)throw new ManagementError('unavailable','此实例尚未提供自助配置入口。');
 if(url.pathname==='/api/self-setup'&&req.method==='GET'){reply(await setup.snapshot());return true;}
 if(url.pathname==='/api/self-setup/voice/sample'&&req.method==='GET'){
  const kind=url.searchParams.get('kind');if(kind!=='demo'&&kind!=='activation')invalid();
  const data=await setup.sample({instanceId:text(url.searchParams.get('instanceId')),operationId:text(url.searchParams.get('operationId')),kind});audio(data.bytes,data.mimeType);return true;
 }
 const allowed:Record<string,string>={'/api/self-setup/credentials/test':'POST','/api/self-setup/credentials':'POST','/api/self-setup/settings':'PUT','/api/self-setup/reference':'POST','/api/self-setup/voice/prepare':'POST','/api/self-setup/voice/confirm':'POST','/api/self-setup/voice/retry':'POST','/api/self-setup/voice/cancel':'POST','/api/self-setup/finish':'POST'};
 if(allowed[url.pathname]!==req.method)throw new ManagementError('not_found','没有这个自助配置操作。');
 const b=await body(url.pathname.endsWith('/reference')?28*1024*1024:undefined),instanceId=text(b.instanceId);
 const controller=new AbortController();const abort=()=>controller.abort();req.once('aborted',abort);
 try{
  switch(url.pathname){
   case '/api/self-setup/credentials':exact(b,['instanceId','provider','key','expectedRevision','operationId']);if(b.provider!=='deepseek'&&b.provider!=='dashscope')invalid();reply(await setup.saveCredential({instanceId,provider:b.provider,key:normalizeApiKey(b.key)??invalid(),expectedRevision:revision(b.expectedRevision),operationId:text(b.operationId)}));break;
   case '/api/self-setup/credentials/test':exact(b,['instanceId','provider','credentialRef','operationId']);if(b.provider!=='deepseek'&&b.provider!=='dashscope')invalid();reply(await setup.testCredential({instanceId,provider:b.provider,credentialRef:text(b.credentialRef),operationId:text(b.operationId)}));break;
   case '/api/self-setup/settings':exact(b,['instanceId','expectedRevision','settings']);reply(await setup.saveSettings({instanceId,expectedRevision:revision(b.expectedRevision),settings:b.settings as never}));break;
   case '/api/self-setup/reference':exact(b,['instanceId','operationId','filename','audioBase64']);reply(await setup.uploadReference({instanceId,operationId:text(b.operationId),filename:text(b.filename,200),audioBase64:text(b.audioBase64,28*1024*1024)},controller.signal));break;
   case '/api/self-setup/voice/prepare':exact(b,['instanceId','referenceId','label','targetModel','credentialRef','configRevision','text']);if(b.targetModel!=='MiniMax/speech-2.8-turbo'&&b.targetModel!=='MiniMax/speech-2.8-hd')invalid();reply(await setup.prepareVoice({instanceId,referenceId:text(b.referenceId),label:text(b.label,120),targetModel:b.targetModel,credentialRef:text(b.credentialRef),configRevision:revision(b.configRevision),text:text(b.text,4000)},controller.signal));break;
   case '/api/self-setup/voice/confirm':exact(b,['instanceId','operationId','expectedRevision','costConsent']);if(b.costConsent!==true)throw new ManagementError('invalid_request','请先确认本次云端调用及费用。');reply(await setup.confirmVoice({instanceId,operationId:text(b.operationId),expectedRevision:revision(b.expectedRevision),costConsent:true},controller.signal));break;
   case '/api/self-setup/voice/retry':exact(b,['instanceId','operationId','expectedRevision']);reply(await setup.retryVoice({instanceId,operationId:text(b.operationId),expectedRevision:revision(b.expectedRevision)}));break;
   case '/api/self-setup/voice/cancel':exact(b,['instanceId','operationId']);reply(await setup.cancelVoice({instanceId,operationId:text(b.operationId)}));break;
   case '/api/self-setup/finish':exact(b,['instanceId','expectedRevision']);reply(await setup.finish({instanceId,expectedRevision:revision(b.expectedRevision)}));break;
  }
  return true;
 }finally{req.off('aborted',abort);}
}
