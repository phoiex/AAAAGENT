import { normalizeApiKey, MAX_API_KEY_FILE_BYTES } from '../core/api-key.js';
import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { ManagementError } from '../contracts/management.js';
import type { SelfSetupManagement, SelfSetupSnapshot, SetupVoiceOperation, SetupReference } from '../contracts/self-setup.js';
import type { TrialConfiguration } from '../app/trial-config.js';
import { EvaluationBudget } from '../core/evaluation-budget.js';
import { VoiceEnrollment, EnrollmentError } from '../providers/voice-enrollment.js';
import { MINIMAX_TTS_ENDPOINT } from '../providers/minimax-tts.js';
import { ManagedCredentialStore } from './credential-store.js';
import { credentialRegistry } from './credentials.js';
import { ManagementSettingsStore } from './settings-store.js';
import { availableAdapters } from './settings.js';
import { VoiceSetupService, VoiceSetupError, type VoiceSetupOperation } from './voice-setup.js';
import { VoiceReferenceStore, VoiceReferenceError, privateRead, privateJson, privateDirectory, sha256, requireLive, MAX_REFERENCE_BYTES } from './voice-reference-store.js';

const links:SelfSetupSnapshot['links']={dashscopeConsole:'https://bailian.console.aliyun.com/',dashscopeKeys:'https://bailian.console.aliyun.com/?tab=model#/api-key',voiceClone:'https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api',voicePricing:'https://help.aliyun.com/zh/model-studio/minimax-synchronous-speech-synthesis-api',deepseekKeys:'https://platform.deepseek.com/api_keys',harness:'https://github.com/deepseek-ai/deepseek-harness',codex:'https://openai.com/codex/for-work/'};
interface Options {
 base:TrialConfiguration; settings:ManagementSettingsStore; instanceId:string; mode:'first-run'|'runtime';
 credentials?:ManagedCredentialStore; fetch?:typeof fetch;
 initialization?:()=>Promise<{completed:boolean;blockers:string[]}>;
 finish?:()=>Promise<void>;
 /** Recheck activation/configuration at the actual key-read boundary in a running backend. */
 runtimeReady?:()=>boolean;
}
function projectOperation(op:VoiceSetupOperation):SetupVoiceOperation {
 const {operationId,revision,phase,referenceId,label,targetModel,credentialRef,endpoint,configRevision,voiceId,text,cloneUpperBoundMicros,activationUpperBoundMicros,createdAt,updatedAt,errorCode,demoAvailable,activationAvailable}=op;
 return {retryAvailable:op.retryAvailable===true&&phase==='failed'&&errorCode==='provider_not_enabled',operationId,revision,phase,referenceId,label,targetModel,credentialRef,endpoint,configRevision,voiceId,text,cloneUpperBoundMicros,activationUpperBoundMicros,createdAt,updatedAt,errorCode,demoAvailable,activationAvailable};
}
function safeError(error:unknown):never {
 if(error instanceof ManagementError)throw error;
 if(error instanceof VoiceSetupError){
  if(['version_conflict','configuration_changed'].includes(error.code))throw new ManagementError('version_conflict','配置或音色操作已变化，请刷新；原请求不会自动重发。');
  throw new ManagementError('invalid_request','音色操作当前不可执行，请刷新状态。');
 }
 if(error instanceof VoiceReferenceError)throw new ManagementError('invalid_request',error.code==='probe_unavailable'?'请在本机转成 PCM WAV 后上传。':'参考音频须为10秒至5分钟、20MiB以内的完整音频，且本地存储权限有效。');
 if(error instanceof EnrollmentError)throw new ManagementError('invalid_request',error.code==='provider_not_enabled'?'请先在百炼开通对应模型；保存Key不代表模型可用。':'本次音色请求未完成，请查看状态；不会自动重试。');
 throw new ManagementError('unavailable','本地设置暂不可用，请检查文件权限或重新打开；原数据保持。');
}
/** Reads exactly one selected credential only following an explicit paid-action confirmation. */
export async function readSetupKey(file:string,projectRoot:string):Promise<string>{
 const actual=await realpath(file),root=await realpath(projectRoot),part=relative(root,actual),before=await lstat(file);
 if(!isAbsolute(file)||(!part.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&part!=='..')||before.isSymbolicLink()||!before.isFile()||(before.mode&0o077)!==0||(process.getuid&&before.uid!==process.getuid())||before.size>MAX_API_KEY_FILE_BYTES)throw Error('credential_unavailable');
 const h=await open(actual,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const after=await h.stat();if(after.ino!==before.ino||after.dev!==before.dev||after.size>MAX_API_KEY_FILE_BYTES||!after.isFile()||(after.mode&0o077)!==0)throw Error('credential_unavailable');
  const bytes=await h.readFile();try{const value=normalizeApiKey(bytes.toString('utf8'));if(value===undefined)throw Error('credential_unavailable');return value;}finally{bytes.fill(0);}
 }finally{await h.close();}
}
/** One backend owns configuration writes. Lazy private stores keep viewing first-run setup read-only. */
export function createSelfSetup(options:Options):SelfSetupManagement {
 const {base,settings,instanceId}=options,managed=options.credentials??new ManagedCredentialStore(base.projectRoot),credentials=credentialRegistry(base,managed);
 const directory=resolve(base.projectRoot,'.local/data/voice-assets/self-setup'),referencesDirectory=resolve(directory,'references'),operationsDirectory=resolve(directory,'operations');
 const budget=new EvaluationBudget(base.budgetFile,base.budgetBatchId,base.limitMicros),shutdown=new AbortController();
 let referenceStore:Promise<VoiceReferenceStore>|undefined,voiceStore:Promise<VoiceSetupService>|undefined,tail:Promise<unknown>=Promise.resolve();
 const references=()=>referenceStore??=VoiceReferenceStore.open(referencesDirectory);
 const voice=()=>voiceStore??=(async()=>{
  if(!settings.registeredVoices)throw new ManagementError('unavailable','本地音色登记尚未就绪。');
  return VoiceSetupService.open({directory:operationsDirectory,references:await references(),registry:settings.registeredVoices,
   enrollment:new VoiceEnrollment({fetch:options.fetch??fetch,key:async ref=>{if(shutdown.signal.aborted||options.runtimeReady?.()===false)throw Error('instance_unavailable');return readSetupKey(credentials.file(ref,'dashscope'),base.projectRoot);},accounting:budget}),
   isCurrent:(binding,revision)=>!shutdown.signal.aborted&&options.runtimeReady?.()!==false&&revision===settings.snapshot().revision&&binding.endpoint===MINIMAX_TTS_ENDPOINT&&credentials.list().some(c=>c.id===binding.credentialRef&&c.provider==='dashscope'&&c.status==='configured')});
 })();
 function identity(id:string):void{if(id!==instanceId||shutdown.signal.aborted)throw new ManagementError('version_conflict','本地实例已变化，请重新打开设置页。');}
 async function attempt<T>(action:()=>Promise<T>):Promise<T>{try{return await action();}catch(error){return safeError(error);}}
 async function exists(path:string):Promise<boolean>{try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
 return {
  async snapshot(){return attempt(async()=>({apiVersion:1,instanceId,mode:options.mode,credentialRevision:managed.revision(),credentials:credentials.list().map(c=>({...c,provider:c.provider!,managed:c.managed!})),adapters:availableAdapters(base,settings.registeredVoices),settings:settings.snapshot(),
   references:await exists(referencesDirectory)?await(await references()).list():[],operations:await exists(operationsDirectory)?(await(await voice()).list()).map(projectOperation):[],budget:{mode:base.limitMicros===null?'unlimited':'bounded',limitMicros:base.limitMicros,currency:'CNY'},initialization:options.initialization?await options.initialization():{completed:options.mode==='runtime',blockers:[]},links}));},
  async saveCredential(input){identity(input.instanceId);return attempt(async()=>managed.save({provider:input.provider,key:input.key,expectedRevision:input.expectedRevision,operationId:input.operationId}));},
  async saveSettings(input){identity(input.instanceId);return settings.save(input.expectedRevision,input.settings);},
  async uploadReference(input,signal){identity(input.instanceId);
   if(!/^[A-Za-z0-9_-]{8,100}$/.test(input.operationId)||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.audioBase64)||input.audioBase64.length>Math.ceil(MAX_REFERENCE_BYTES/3)*4)throw new ManagementError('invalid_request','音频内容或上传操作标识无效。');
   const run=tail.then(()=>attempt(async()=>{
    const combined=AbortSignal.any([signal,shutdown.signal]);requireLive(combined);const bytes=Buffer.from(input.audioBase64,'base64');
    try{
     if(bytes.length>MAX_REFERENCE_BYTES||bytes.toString('base64')!==input.audioBase64)throw new VoiceReferenceError('invalid_audio');
     const receipts=await privateDirectory(resolve(directory,'uploads')),file=resolve(receipts,sha256(input.operationId)+'.json'),digest=sha256(bytes),store=await references();
     if(await exists(file)){const old=JSON.parse((await privateRead(file,4096)).toString());if(old.sha256!==digest||old.filename!==input.filename)throw new ManagementError('version_conflict','上传操作标识已使用，请重新选择文件。');return store.get(old.referenceId);}
     const result=await store.save({bytes,filename:input.filename},combined);await privateJson(file,{sha256:digest,filename:input.filename,referenceId:result.id});return result;
    }finally{bytes.fill(0);}
   }));tail=run.catch(()=>{});return run;
  },
  async prepareVoice({instanceId:id,...input},signal){identity(id);return attempt(async()=>projectOperation(await(await voice()).prepare(input,AbortSignal.any([signal,shutdown.signal]))));},
  async confirmVoice({instanceId:id,...input},signal){identity(id);return attempt(async()=>projectOperation(await(await voice()).confirm(input,AbortSignal.any([signal,shutdown.signal]))));},
  async retryVoice({instanceId:id,...input}){identity(id);return attempt(async()=>projectOperation(await(await voice()).retry(input,shutdown.signal)));},
  async cancelVoice(input){identity(input.instanceId);return attempt(async()=>projectOperation(await(await voice()).cancel(input.operationId)));},
  async sample(input){identity(input.instanceId);return attempt(async()=>{const value=await(await voice()).sample(input.operationId,input.kind);return{bytes:value.bytes,mimeType:value.mime};});},
  async finish(input){identity(input.instanceId);if(input.expectedRevision!==settings.snapshot().revision)throw new ManagementError('version_conflict','配置已更新，请刷新。');if(!options.finish)throw new ManagementError('invalid_request','配置保存后请使用已有入口重启。');await attempt(options.finish);return{status:'prepared',requiresRestart:true};},
  async close(){shutdown.abort();await tail;if(voiceStore){await(await voiceStore).close();}await settings.drain();}
 };
}
