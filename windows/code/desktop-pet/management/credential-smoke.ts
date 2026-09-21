import type { SetupProvider, CredentialTestResult, TestSetupCredential } from '../contracts/self-setup.js';
import { ManagementError } from '../contracts/management.js';

export const KEY_TEST_ENDPOINTS:Record<SetupProvider,string>={
 deepseek:'https://api.deepseek.com/models',
 dashscope:'https://dashscope.aliyuncs.com/api/v1/models?page_size=1',
};
/** Extracted provider code/message only; never return response headers, URLs, or complete bodies. */
export function safeCredentialError(value:string,key:string):string {
 let result=value;
 for(const secret of new Set([key,encodeURIComponent(key),JSON.stringify(key).slice(1,-1)]))if(secret)result=result.split(secret).join('[已隐藏]');
 return result.replace(/Bearer\s+\S+/gi,'Bearer [已隐藏]').replace(/sk-[^\s"'<>]+/gi,'[已隐藏]')
  .replace(/https?:\/\/[^\s<>"']+/gi,'[链接已隐藏]').replace(/(?:authorization|api[-_ ]?key|access[-_ ]?token|secret|signature)\s*[=:]\s*[^\s,;]+/gi,'[凭据已隐藏]')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,1000);
}
interface Options {key:(ref:string,provider:SetupProvider)=>Promise<string>;fetch?:typeof fetch;signal:AbortSignal;ready:()=>boolean;timeoutMs?:number}
/** Per-instance operation receipts and per-key in-flight coalescing; viewing metadata never calls it. */
export class CredentialSmoke {
 private receipts=new Map<string,{binding:string;job:Promise<CredentialTestResult>}>();
 private pending=new Map<string,Promise<CredentialTestResult>>();
 constructor(private options:Options){}
 test(input:TestSetupCredential):Promise<CredentialTestResult>{
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(input.operationId))throw new ManagementError('invalid_request','测试操作标识无效。');
  const binding=input.provider+':'+input.credentialRef,old=this.receipts.get(input.operationId);
  if(old){if(old.binding!==binding)throw new ManagementError('version_conflict','测试操作标识已使用。');return old.job;}
  const job=this.pending.get(binding)??this.run(input);
  this.pending.set(binding,job);this.receipts.set(input.operationId,{binding,job});
  void job.finally(()=>{if(this.pending.get(binding)===job)this.pending.delete(binding);
   // Retain the latest 1024 completed receipts; never evict an in-flight operation.
   for(const [id,receipt] of this.receipts){if(this.receipts.size<=1024)break;if(!this.pending.has(receipt.binding))this.receipts.delete(id);}
  }).catch(()=>{});
  return job;
 }
 private async run(input:TestSetupCredential):Promise<CredentialTestResult>{
  const {provider,credentialRef}=input;
  const result=(ok:boolean,error:string|null,httpStatus:number|null=null):CredentialTestResult=>({provider,credentialRef,ok,error,httpStatus,checkedAt:new Date().toISOString(),scope:'model-list-authentication'});
  const abort=new AbortController(),signal=AbortSignal.any([abort.signal,this.options.signal]);
  let timer:ReturnType<typeof setTimeout>|undefined;
  const work=(async()=>{
   if(signal.aborted||!this.options.ready())return result(false,'本地实例已变化，请重新打开设置页。');
   let key:string;try{key=await this.options.key(credentialRef,provider);}catch{return result(false,'无法读取此凭据。');}
   if(signal.aborted||!this.options.ready())return result(false,'本地实例已变化，请重新打开设置页。');
   const response=await(this.options.fetch??fetch)(KEY_TEST_ENDPOINTS[provider],{method:'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json'},redirect:'error',signal});
   const reader=response.body?.getReader();let bytes=0,body='';const decoder=new TextDecoder();
   if(reader)try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>65536){await reader.cancel();return result(false,'HTTP '+response.status+'：供应商响应过大。',response.status);}body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();}finally{reader.releaseLock();}
   let data:any;try{data=JSON.parse(body);}catch{return result(false,!response.ok?safeCredentialError('HTTP '+response.status+(body.trim()?' · '+body.trim():''),key):'HTTP '+response.status+'：供应商响应无法解析。',response.status);}
   if(!response.ok||data?.error||data?.success===false||data?.code){
    const source=data?.error&&typeof data.error==='object'?data.error:data;
    const code=typeof source?.code==='string'?source.code:'';
    const message=typeof source?.message==='string'?source.message:'';
    return result(false,safeCredentialError(['HTTP '+response.status,code,message].filter(Boolean).join(' · '),key),response.status);
   }
   const valid=provider==='deepseek'?data?.object==='list'&&Array.isArray(data.data):data?.success===true&&Array.isArray(data?.output?.models);
   return valid?result(true,null,response.status):result(false,'HTTP '+response.status+'：供应商响应无法识别。',response.status);
  })();
  const timeout=new Promise<CredentialTestResult>(resolve=>{timer=setTimeout(()=>{abort.abort();resolve(result(false,'连接测试超时。'));},this.options.timeoutMs??10000);});
  const stopped=new Promise<CredentialTestResult>(resolve=>{if(this.options.signal.aborted)resolve(result(false,'连接测试已取消。'));else this.options.signal.addEventListener('abort',cancel,{once:true});function cancel(){resolve(result(false,'连接测试已取消。'));}abort.signal.addEventListener('abort',()=>this.options.signal.removeEventListener('abort',cancel),{once:true});});
  try{return await Promise.race([work,timeout,stopped]);}catch{return result(false,'无法连接供应商，请检查网络。');}finally{clearTimeout(timer);abort.abort();}
 }
}
