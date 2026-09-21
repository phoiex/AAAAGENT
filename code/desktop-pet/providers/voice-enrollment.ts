import { normalizeApiKey } from '../core/api-key.js';
import { randomUUID } from 'node:crypto';
import { inspectPcmWav } from '../media/wav.js';
import { abortable } from '../media/scope.js';
import { MINIMAX_TTS_ENDPOINT } from './minimax-tts.js';
import { MAX_REFERENCE_BYTES, requireLive, sha256, type VoiceReference } from '../management/voice-reference-store.js';

export type EnrollmentModel = 'MiniMax/speech-2.8-turbo' | 'MiniMax/speech-2.8-hd';
export interface EnrollmentBinding { targetModel: EnrollmentModel; credentialRef: string; endpoint: string }
export interface EnrollmentAccounting {
  reserve(operationId: string, model: string, upperBoundMicros: number): Promise<void>;
  settle(operationId: string, actualMicros: number | null): Promise<void>;
}
export interface EnrollmentReceipt { voiceId: string; requestId: string | null; characters: number | null; actualMicros: number | null }
export interface CloneResult { receipt: EnrollmentReceipt; demo: Uint8Array | null; demoUnavailable: boolean }
export interface ActivationResult { receipt: EnrollmentReceipt; audio: Uint8Array }
export type EnrollmentErrorCode = 'invalid_request' | 'credential_unavailable' | 'provider_not_enabled' | 'provider_rejected' | 'unsafe_response' | 'transport_unknown' | 'cancelled' | 'accounting_failed';
export class EnrollmentError extends Error {
  constructor(readonly code: EnrollmentErrorCode, readonly outcomeUnknown = false, readonly retrySafe = false) { super(code); this.name = 'EnrollmentError'; }
}
export function validateEnrollmentBinding(binding: EnrollmentBinding): void {
  if (!binding || !['MiniMax/speech-2.8-turbo','MiniMax/speech-2.8-hd'].includes(binding.targetModel)
    || binding.endpoint !== MINIMAX_TTS_ENDPOINT || !/^dashscope-[a-f0-9]{12}$/.test(binding.credentialRef)) throw new EnrollmentError('invalid_request');
}
export function enrollmentCost(model: EnrollmentModel, text: string, firstUse = false): number {
  if (!['MiniMax/speech-2.8-turbo','MiniMax/speech-2.8-hd'].includes(model) || !text.trim() || [...text].length > 1000) throw new EnrollmentError('invalid_request');
  return Buffer.byteLength(text,'utf8') * (model.endsWith('-hd') ? 350 : 200) + (firstUse ? 9900000 : 0);
}
function voiceIdValid(id: string): void { if (!/^[A-Za-z][A-Za-z0-9_-]{6,126}[A-Za-z0-9]$/.test(id)) throw new EnrollmentError('invalid_request'); }
function record(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EnrollmentError('unsafe_response',true); return value as Record<string, any>; }
async function boundedBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new EnrollmentError('unsafe_response',true);
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) { await response.body.cancel(); throw new EnrollmentError('unsafe_response',true); }
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await abortable(reader.read(),signal); requireLive(signal);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) { chunk.value.fill(0); throw new EnrollmentError('unsafe_response',true); }
      parts.push(chunk.value);
    }
    return Buffer.concat(parts,size);
  } finally { void reader.cancel().catch(()=>{}); parts.forEach(part=>part.fill(0)); }
}
async function boundedJson(response: Response, limit: number, signal: AbortSignal): Promise<Record<string, any>> {
  const bytes = await boundedBytes(response,limit,signal);
  try { return record(JSON.parse(Buffer.from(bytes).toString('utf8'))); }
  catch { throw new EnrollmentError('unsafe_response',true); }
  finally { bytes.fill(0); }
}
/** No retry. The host supplies a stable credential reader and the existing shared ledger. */
export class VoiceEnrollment {
  constructor(private readonly options: { fetch: typeof fetch; key: (credentialRef: string) => string | Promise<string>; accounting: EnrollmentAccounting }) {}
  private async request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    requireLive(signal);
    const promise = this.options.fetch(url,{...init,signal,redirect:'error'});
    void promise.then(response=>{if(signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
    return abortable(promise,signal);
  }
  private async key(binding: EnrollmentBinding): Promise<string> {
    validateEnrollmentBinding(binding);
    let key: string | undefined;
    try { key = normalizeApiKey(await this.options.key(binding.credentialRef)); } catch { throw new EnrollmentError('credential_unavailable'); }
    if (key === undefined) throw new EnrollmentError('credential_unavailable'); return key;
  }
  private async upload(binding: EnrollmentBinding, reference: VoiceReference, bytes: Uint8Array, key: string, signal: AbortSignal): Promise<string> {
    if (bytes.length !== reference.bytes || bytes.length > MAX_REFERENCE_BYTES || sha256(bytes) !== reference.sha256
      || bytes.length===0 || !Number.isFinite(reference.durationMs) || !['wav','mp3','m4a'].includes(reference.format) || reference.durationMs < 10000 || reference.durationMs > 300000) throw new EnrollmentError('invalid_request');
    const response = await this.request('https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model='+encodeURIComponent(binding.targetModel),
      {headers:{Authorization:`Bearer ${key}`}},signal);
    if (!response.ok) { void response.body?.cancel(); throw new EnrollmentError(response.status===403 ? 'provider_not_enabled' : 'provider_rejected',false,response.status===403); }
    const policy = record((await boundedJson(response,65536,signal)).data);
    let host: URL;
    try { host = new URL(policy.upload_host); } catch { throw new EnrollmentError('unsafe_response'); }
    if (host.href !== 'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com/'
      || typeof policy.upload_dir !== 'string' || !/^dashscope-instant\/[A-Za-z0-9/_-]+$/.test(policy.upload_dir)
      || policy.x_oss_object_acl !== 'private' || policy.x_oss_forbid_overwrite !== 'true'
      || !Number.isFinite(policy.expire_in_seconds) || policy.expire_in_seconds < 60
      || ['policy','signature','oss_access_key_id'].some(name=>typeof policy[name] !== 'string' || !policy[name] || policy[name].length>16384)) throw new EnrollmentError('unsafe_response');
    const object = policy.upload_dir+'/reference-'+randomUUID()+'.'+reference.format, form = new FormData();
    for (const [name,value] of Object.entries({OSSAccessKeyId:policy.oss_access_key_id,policy:policy.policy,Signature:policy.signature,key:object,
      'x-oss-object-acl':'private','x-oss-forbid-overwrite':'true',success_action_status:'200'})) form.append(name,value as string);
    const mime = {wav:'audio/wav',mp3:'audio/mpeg',m4a:'audio/mp4'}[reference.format];
    form.append('file',new Blob([Uint8Array.from(bytes)],{type:mime}),'reference.'+reference.format);
    const uploaded = await this.request(host.href,{method:'POST',body:form},signal);
    void uploaded.body?.cancel().catch(()=>{});
    if (!uploaded.ok) throw new EnrollmentError('provider_rejected'); return 'oss://'+object;
  }
  private async paid(binding: EnrollmentBinding, id: string, voiceId: string, text: string, input: object, key: string, firstUse: boolean, signal: AbortSignal): Promise<{ receipt: EnrollmentReceipt; output: Record<string,any> }> {
    const bound = enrollmentCost(binding.targetModel,text,firstUse); voiceIdValid(voiceId); requireLive(signal);
    try { await this.options.accounting.reserve(id,binding.targetModel,bound); } catch { throw new EnrollmentError('accounting_failed'); }
    let actual: number | null = null, sent = false;
    try {
      requireLive(signal); sent = true;
      const response = await this.request(binding.endpoint,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json; charset=utf-8',
        ...(!firstUse ? {'X-DashScope-OssResourceResolve':'enable'} : {})},body:JSON.stringify({model:binding.targetModel,input})},signal);
      if (!response.ok) {
        void response.body?.cancel().catch(()=>{});
        if(response.status===403)actual=0;
        throw new EnrollmentError(response.status===403?'provider_not_enabled':'provider_rejected',response.status>=500,response.status===403);
      }
      const raw = await boundedJson(response,firstUse?24*1024*1024:65536,signal), output=record(raw.output), status=record(output.base_resp);
      const chars=raw.usage?.characters;
      const characters=Number.isSafeInteger(chars)&&chars>=0&&chars<=Buffer.byteLength(text,'utf8')?chars:null;
      if (characters!==null) actual=characters*(binding.targetModel.endsWith('-hd')?350:200)+(firstUse&&status.status_code===0?9900000:0);
      if (status.status_code===2038) {
        const zero=chars===undefined||chars===0;
        if(zero)actual=0;
        throw new EnrollmentError('provider_not_enabled',!zero,zero);
      }
      if (raw.code || raw.error || status.status_code!==0) throw new EnrollmentError('provider_rejected');
      if (!firstUse && (output.input_sensitive!==false || output.input_sensitive_type!==0)) throw new EnrollmentError('provider_rejected');
      const requestId=typeof raw.request_id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(raw.request_id)?raw.request_id:null;
      requireLive(signal);
      return {receipt:{voiceId,requestId,characters,actualMicros:actual},output};
    } catch (error) {
      if (signal.aborted) throw new EnrollmentError('cancelled',sent);
      if (error instanceof EnrollmentError) throw error;
      throw new EnrollmentError('transport_unknown',sent);
    } finally {
      try { await this.options.accounting.settle(id,sent?actual:0); } catch { throw new EnrollmentError('accounting_failed',sent); }
    }
  }
  async clone(input: { binding: EnrollmentBinding; reference: VoiceReference; bytes: Uint8Array; voiceId: string; text: string; operationId: string; beforePaid?: () => Promise<void> }, signal: AbortSignal): Promise<CloneResult> {
    validateEnrollmentBinding(input.binding); voiceIdValid(input.voiceId); enrollmentCost(input.binding.targetModel,input.text);
    const timed = AbortSignal.any([signal,AbortSignal.timeout(180000)]);
    try {
      const key=await abortable(this.key(input.binding),timed); requireLive(timed);
      const url=await this.upload(input.binding,input.reference,input.bytes,key,timed);
      await input.beforePaid?.();
      const {receipt,output}=await this.paid(input.binding,input.operationId,input.voiceId,input.text,{action:'voice_clone',voice_id:input.voiceId,audio_url:url,text:input.text,
        language_boost:'Chinese',need_noise_reduction:false,need_volume_normalization:false},key,false,timed);
      let demo: Uint8Array|null=null;
      try {
        const url=new URL(output.demo_audio);
        if (url.protocol!=='https:' || url.hostname!=='minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com' || url.port || url.username || url.password || url.hash) throw Error();
        const response=await this.request(url.href,{},timed);
        if(!response.ok){void response.body?.cancel();throw Error();}
        demo=await boundedBytes(response,MAX_REFERENCE_BYTES,timed);
        if(!(Buffer.from(demo.subarray(0,3)).toString('ascii')==='ID3'||(demo[0]===255&&((demo[1]??0)&224)===224)))throw Error();
      } catch { demo?.fill(0);demo=null; }
      if(timed.aborted){demo?.fill(0);throw new EnrollmentError('cancelled',true);}
      return {receipt,demo,demoUnavailable:demo===null};
    } catch(error) {
      if(error instanceof EnrollmentError)throw error;
      throw new EnrollmentError(timed.aborted?'cancelled':'transport_unknown',true);
    }
  }
  async activate(input: { binding: EnrollmentBinding; voiceId: string; text: string; operationId: string; beforePaid?: () => Promise<void> }, signal: AbortSignal): Promise<ActivationResult> {
    validateEnrollmentBinding(input.binding); voiceIdValid(input.voiceId); enrollmentCost(input.binding.targetModel,input.text,true);
    const timed=AbortSignal.any([signal,AbortSignal.timeout(120000)]), key=await abortable(this.key(input.binding),timed);
    await input.beforePaid?.();
    const {receipt,output}=await this.paid(input.binding,input.operationId,input.voiceId,input.text,{text:input.text,voice_setting:{voice_id:input.voiceId,speed:1,vol:1,pitch:0},
      audio_setting:{sample_rate:24000,format:'wav',channel:1},output_format:'hex',language_boost:'Chinese'},key,true,timed);
    let audio: Uint8Array|undefined;
    try {
      const data=record(output.data);
      if(data.status!==2||typeof data.audio!=='string'||!data.audio.length||data.audio.length%2||!/^[a-f0-9]+$/i.test(data.audio))throw Error();
      audio=Buffer.from(data.audio,'hex'); const wav=inspectPcmWav(audio);
      if(new DataView(audio.buffer,audio.byteOffset,audio.byteLength).getUint32(4,true)+8!==audio.length||wav.channels!==1||wav.sampleRate!==24000)throw Error();
      requireLive(timed); return {receipt,audio};
    } catch { audio?.fill(0);throw new EnrollmentError(timed.aborted?'cancelled':'unsafe_response',true); }
  }
}
