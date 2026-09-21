import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceEnrollment, EnrollmentError, enrollmentCost, type EnrollmentBinding } from '../../providers/voice-enrollment.js';
import { pcm16Wav } from '../../media/wav.js';
import { sha256 } from '../../management/voice-reference-store.js';
const binding:EnrollmentBinding={targetModel:'MiniMax/speech-2.8-turbo',credentialRef:'dashscope-123456abcdef',endpoint:'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'};
const referenceBytes=pcm16Wav(new Float32Array(160000),16000);
const reference={id:'a'.repeat(32),format:'wav' as const,bytes:referenceBytes.length,sha256:sha256(referenceBytes),durationMs:10000,createdAt:new Date().toISOString()};
const input={binding,reference,bytes:referenceBytes,voiceId:'Voice12345678',text:'你好。',operationId:'test:clone'};
const policy={upload_host:'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com/',upload_dir:'dashscope-instant/test',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true',expire_in_seconds:3600,policy:'test-policy',signature:'test-signature',oss_access_key_id:'test-id'};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const cloneResponse=()=>json({output:{base_resp:{status_code:0},input_sensitive:false,input_sensitive_type:0,demo_audio:'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/demo.mp3?Signature=secret'},usage:{characters:5},request_id:'request-clone'});
function rig(respond?:(url:string,init:RequestInit,n:number)=>Response|Promise<Response>, key = 'sk-synthetic-only'){
 const requests:{url:string;init:RequestInit}[]=[],reserves:any[]=[],settles:any[]=[];
 const fetcher=(async(url:any,init:RequestInit={})=>{requests.push({url:String(url),init});return respond?respond(String(url),init,requests.length):String(url).includes('/uploads?')?json({data:policy}):String(url).includes('dashscope-file-mgr')?new Response(''):String(url).includes('/demo.mp3')?new Response('ID3synthetic'):cloneResponse();}) as typeof fetch;
 const provider=new VoiceEnrollment({fetch:fetcher,key:()=>key,accounting:{async reserve(...args){reserves.push(args);},async settle(...args){settles.push(args);}}});
 return{provider,requests,reserves,settles};
}
test('bounded private upload, clone receipt and unauthenticated demo; no implicit first use',async()=>{
 const r=rig(),result=await r.provider.clone(input,new AbortController().signal);
 assert.equal(r.requests.length,4);assert.equal(r.reserves.length,1);assert.deepEqual(r.settles,[['test:clone',1000]]);
 const upload=r.requests[1]!.init;assert.equal(upload.headers,undefined);assert.equal((upload.body as FormData).get('x-oss-object-acl'),'private');
 const payload=JSON.parse(r.requests[2]!.init.body as string);assert.equal(payload.input.action,'voice_clone');assert.equal(payload.model,binding.targetModel);
 assert.equal(payload.input.voice_id,input.voiceId);assert.match(payload.input.audio_url,/^oss:\/\/dashscope-instant\/test\/reference-/);
 assert.equal((r.requests[2]!.init.headers as any)['X-DashScope-OssResourceResolve'],'enable');
 assert.equal(r.requests[3]!.init.headers,undefined);assert.ok(r.requests.every(r=>r.init.redirect==='error'));
 assert.equal(result.receipt.requestId,'request-clone');assert.equal(result.demoUnavailable,false);assert.ok(!JSON.stringify(result.receipt).includes('Signature'));
});
test('forged endpoint, voice id, reference hash and malformed key cause no model POST',async()=>{
 for(const change of [{binding:{...binding,endpoint:'https://attacker.invalid'}},{voiceId:'../file'},{reference:{...reference,sha256:'b'.repeat(64)}}]){
  const r=rig();await assert.rejects(r.provider.clone({...input,...change},new AbortController().signal));assert.equal(r.requests.length,0);
 }
 const r=rig();await assert.rejects(r.provider.clone({...input,text:'a'.repeat(1001)},new AbortController().signal));assert.equal(r.requests.length,0);
});
test('SSRF policy hosts and non-private upload are rejected without sending audio',async()=>{
 for(const change of [{upload_host:'https://127.0.0.1/'},{upload_host:'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com.evil/'},{x_oss_object_acl:'public-read'},{upload_dir:'dashscope-instant/../outside'}]){
  const r=rig(()=>json({data:{...policy,...change}}));await assert.rejects(r.provider.clone(input,new AbortController().signal));assert.equal(r.requests.length,1);assert.equal(r.reserves.length,0);
 }
});
test('403 and 2038 remain safe model-opening errors, HTTP200 sensitive is not registration',async()=>{
 for(const response of [()=>new Response('sk-do-not-leak',{status:403}),()=>json({output:{base_resp:{status_code:2038,status_msg:'sk-secret'}}}),()=>json({output:{base_resp:{status_code:0},input_sensitive:true,input_sensitive_type:2},usage:{characters:5}})]){
  const r=rig((url,init,n)=>n===1?json({data:policy}):n===2?new Response(''):response());
  await assert.rejects(r.provider.clone(input,new AbortController().signal),(error:EnrollmentError)=>{assert.ok(!String(error).includes('sk-'));return ['provider_not_enabled','provider_rejected'].includes(error.code);});
  assert.equal(r.requests.length,3);assert.equal(r.reserves.length,1);assert.equal(r.settles.length,1);
 }
});
test('first formal synthesis reserves first-use fee; validates actual PCM; never retries',async()=>{
 const wav=pcm16Wav(new Float32Array(2400),24000);
 const r=rig(()=>json({output:{base_resp:{status_code:0},data:{status:2,audio:Buffer.from(wav).toString('hex')}},usage:{characters:5},request_id:'activation'}));
 const result=await r.provider.activate(input,new AbortController().signal);
 assert.equal(Buffer.compare(Buffer.from(result.audio),Buffer.from(wav)),0);assert.equal(r.requests.length,1);assert.equal(r.reserves[0][2],enrollmentCost(binding.targetModel,input.text,true));assert.equal(r.settles[0][1],9901000);
 const payload=JSON.parse(r.requests[0]!.init.body as string);assert.equal(payload.input.action,undefined);assert.equal(payload.input.voice_setting.emotion,undefined);
 const failed=rig(()=>new Response('server secret',{status:503}));await assert.rejects(failed.provider.activate(input,new AbortController().signal));assert.equal(failed.requests.length,1);assert.equal(failed.settles[0][1],null);
});
test('cancel ignored fetch returns promptly, settles unknown once and discards late response',async()=>{
 let finish!:(value:Response)=>void;const controller=new AbortController();
 const r=rig(()=>new Promise(resolve=>{finish=resolve;}));const pending=r.provider.activate(input,controller.signal);
 while(!finish)await new Promise(resolve=>setImmediate(resolve));controller.abort();
 await assert.rejects(pending,(e:EnrollmentError)=>e.code==='cancelled'&&e.outcomeUnknown);
 assert.deepEqual(r.settles,[['test:clone',null]]);finish(json({secret:'sk-do-not-leak'}));await new Promise(resolve=>setImmediate(resolve));assert.equal(r.requests.length,1);
});
test('config guard after reference upload prevents paid POST and reservation',async()=>{
 const r=rig();await assert.rejects(r.provider.clone({...input,beforePaid:async()=>{throw new EnrollmentError('invalid_request');}},new AbortController().signal));
 assert.equal(r.requests.length,2);assert.equal(r.reserves.length,0);
});
test('unsafe demo URL does not fetch; successful clone is retained with unavailable demo',async()=>{
 const r=rig((u,i,n)=>n===1?json({data:policy}):n===2?new Response(''):json({output:{base_resp:{status_code:0},input_sensitive:false,input_sensitive_type:0,demo_audio:'http://localhost/private'},usage:{characters:5}}));
 const result=await r.provider.clone(input,new AbortController().signal);assert.equal(result.demoUnavailable,true);assert.equal(r.requests.length,3);assert.equal(result.receipt.actualMicros,1000);
});
test('unknown usage stays unknown despite success; damaged successful first-use WAV cannot register',async()=>{
 const r=rig(()=>json({output:{base_resp:{status_code:0},data:{status:2,audio:'0000'}}}));
 await assert.rejects(r.provider.activate(input,new AbortController().signal),(e:EnrollmentError)=>e.code==='unsafe_response'&&e.outcomeUnknown);
 assert.equal(r.requests.length,1);assert.equal(r.settles[0][1],null);
});
test('response body size bound cancels oversized policy before upload',async()=>{
 const r=rig(()=>new Response('x',{headers:{'content-length':'70000'}}));
 await assert.rejects(r.provider.clone(input,new AbortController().signal),(e:EnrollmentError)=>e.code==='unsafe_response');assert.equal(r.requests.length,1);
});
test('2038 with contradictory usage cannot claim settled-zero retry safety',async()=>{
 const r=rig(()=>json({output:{base_resp:{status_code:2038}},usage:{characters:5}}));
 await assert.rejects(r.provider.activate(input,new AbortController().signal),(e:EnrollmentError)=>e.code==='provider_not_enabled'&&e.outcomeUnknown&&e.retrySafe===false);
 assert.equal(r.settles[0][1],1000);
});

test('voice clone and synthesis preserve a dotted opaque key, with no secret sent to upload or demo hosts',async()=>{
 const key='sk-ws-demo.part.signature',r=rig(undefined,' \t'+key+'\r\n');
 await r.provider.clone(input,new AbortController().signal);
 for (const [i,request] of r.requests.entries()) assert.equal(new Headers(request.init.headers).get('Authorization'),i===0||i===2?'Bearer '+key:null);
 const wav=pcm16Wav(new Float32Array(2400),24000),a=rig(()=>json({output:{base_resp:{status_code:0},data:{status:2,audio:Buffer.from(wav).toString('hex')}},usage:{characters:5}}),key);
 await a.provider.activate(input,new AbortController().signal);assert.equal(new Headers(a.requests[0]!.init.headers).get('Authorization'),'Bearer '+key);
});
test('invalid opaque voice credentials fail before any request or accounting reservation',async()=>{
 for (const key of ['', ' ', 'a'.repeat(4097), 'key\r\nInjected:yes', 'key with space', 'key\0value']) {
  const r=rig(undefined,key);await assert.rejects(r.provider.activate(input,new AbortController().signal),(e:EnrollmentError)=>e.code==='credential_unavailable');assert.equal(r.requests.length,0);assert.equal(r.reserves.length,0);
 }
});
