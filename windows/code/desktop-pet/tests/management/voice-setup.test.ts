import { isPrivateFileSync } from '../../core/platform-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile, stat, symlink, readdir, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceReferenceStore, privateDirectory, privateRead } from '../../management/voice-reference-store.js';
import { VoiceSetupService } from '../../management/voice-setup.js';
import { RegisteredVoiceStore } from '../../providers/registered-voices.js';
import { VoiceEnrollment } from '../../providers/voice-enrollment.js';
import { pcm16Wav } from '../../media/wav.js';
const signal=()=>new AbortController().signal;
const wav=()=>pcm16Wav(new Float32Array(160000),16000);
const json=(data:unknown)=>new Response(JSON.stringify(data));
async function fixture(t:any){
 const root=await realpath(await mkdtemp(join(tmpdir(),'voice-setup-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const references=await VoiceReferenceStore.open(join(root,'references')), registry=await RegisteredVoiceStore.open(join(root,'registered.json'));
 const reservations:string[]=[],calls:string[]=[],settlements:any[]=[];let current=true,delay:Promise<Response>|undefined;
 const fetcher=(async(url:any,init:RequestInit={})=>{
  const u=String(url);calls.push(u);
  if(u.includes('/uploads?'))return json({data:{upload_host:'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com/',upload_dir:'dashscope-instant/testing',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true',expire_in_seconds:3600,policy:'secret-policy',signature:'secret-signature',oss_access_key_id:'test-oss'}});
  if(u.includes('dashscope-file-mgr'))return new Response('');
  if(u.includes('demo.mp3'))return new Response('ID3synthetic');
  if(delay)return delay;
  const body=JSON.parse(init.body as string);
  return body.input.action==='voice_clone'?json({output:{base_resp:{status_code:0},input_sensitive:false,input_sensitive_type:0,demo_audio:'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/demo.mp3?Signature=secret'},usage:{characters:5},request_id:'clone-request'}):json({output:{base_resp:{status_code:0},data:{status:2,audio:Buffer.from(pcm16Wav(new Float32Array(2400),24000)).toString('hex')}},usage:{characters:5},request_id:'activation-request'});
 }) as typeof fetch;
 const enrollment=new VoiceEnrollment({fetch:fetcher,key:()=> 'sk-synthetic',accounting:{async reserve(id){if(reservations.includes(id))throw Error();reservations.push(id);},async settle(...args){settlements.push(args);}}});
 const options={directory:join(root,'operations'),references,registry,enrollment,isCurrent:()=>current};
 const service=await VoiceSetupService.open(options), reference=await references.save({bytes:wav(),filename:'private user name.wav'},signal());
 const prepareInput={referenceId:reference.id,label:'自定义',targetModel:'MiniMax/speech-2.8-turbo' as const,credentialRef:'dashscope-123456abcdef',configRevision:1,text:'你好。'};
 return{root,references,registry,enrollment,options,service,reference,prepareInput,reservations,calls,settlements,setCurrent:(value:boolean)=>current=value,setDelay:(value:Promise<Response>)=>delay=value};
}
test('reference storage preserves exact bytes, private permissions and path-free metadata',async t=>{
 const f=await fixture(t),metadata=await f.references.get(f.reference.id),stored=await f.references.read(metadata.id);
 assert.deepEqual(stored.bytes,Buffer.from(wav()));assert.equal(metadata.durationMs,10000);assert.ok(!JSON.stringify(metadata).includes('private user name'));
 for(const name of await readdir(join(f.root,'references')))assert.equal(isPrivateFileSync(join(f.root,'references',name)),true);
 await assert.rejects(f.references.get('../outside'));
 await writeFile(join(f.root,'references',metadata.id+'.wav'),'changed');await assert.rejects(f.references.read(metadata.id));
});
test('bad WAV, short/oversized duration, cancellation and symlink escape reject with cleanup',async t=>{
 const f=await fixture(t),before=(await readdir(join(f.root,'references'))).length;
 for(const bytes of [Buffer.from('not wav'),pcm16Wav(new Float32Array(1600),16000)])await assert.rejects(f.references.save({bytes,filename:'a.wav'},signal()));
 const c=new AbortController();c.abort();await assert.rejects(f.references.save({bytes:wav(),filename:'a.wav'},c.signal));
 assert.equal((await readdir(join(f.root,'references'))).length,before);
 await mkdir(join(f.root,'target'));await symlink(join(f.root,'target'),join(f.root,'link'),process.platform==='win32'?'junction':'dir');await assert.rejects(VoiceReferenceStore.open(join(f.root,'link','refs')));
});
test('compressed audio uses bounded injected probe and never caller duration',async t=>{
 const f=await fixture(t);let calls=0;
 const store=await VoiceReferenceStore.open(join(f.root,'compressed'),async(file,format)=>{calls++;assert.equal(format,'mp3');assert.equal((await readFile(file)).toString(),'ID3fixture');return 12000;});
 const value=await store.save({bytes:Buffer.from('ID3fixture'),filename:'own.mp3'},signal());assert.equal(value.durationMs,12000);assert.equal(calls,1);
 await assert.rejects(store.save({bytes:Buffer.from('garbage'),filename:'own.mp3'},signal()));assert.equal(calls,1);
});
test('prepare is zero-cloud, repeat prepare dedupes across restart and forged voice ID is rejected',async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal());
 assert.equal(f.calls.length,0);assert.equal(f.reservations.length,0);
 const again=await(await VoiceSetupService.open(f.options)).prepare(f.prepareInput,signal());assert.deepEqual(again,op);
 const reordered=Object.fromEntries(Object.entries(f.prepareInput).reverse()) as typeof f.prepareInput;assert.equal((await f.service.prepare(reordered,signal())).operationId,op.operationId);
 await assert.rejects(f.service.prepare({...f.prepareInput,voiceId:'ForgedVoice'} as any,signal()));
 await assert.rejects(f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:false},signal()));assert.equal(f.calls.length,0);
});
test('two explicit confirmations required, exact successful first-use receipt registers and never changes settings',async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal());
 const ready=await f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal());
 assert.equal(ready.phase,'clone_ready');assert.equal(f.registry.snapshot().voices.length,0);assert.equal(ready.revision,3);assert.equal(ready.demoAvailable,true);
 await assert.rejects(f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal()));assert.equal(f.calls.length,4);
 const finished=await f.service.confirm({operationId:op.operationId,expectedRevision:ready.revision,costConsent:true},signal());
 assert.equal(finished.phase,'registered');assert.equal(f.registry.snapshot().voices.length,1);assert.equal(f.registry.snapshot().voices[0]!.credentialRef,f.prepareInput.credentialRef);
 assert.equal(f.registry.snapshot().voices[0]!.referenceSha256,f.reference.sha256);assert.equal(f.reservations.length,2);assert.equal(f.settlements[1][1],9901000);
 assert.equal((await f.service.sample(op.operationId,'activation')).mime,'audio/wav');
 const persisted=await readFile(join(f.root,'operations',op.operationId+'.json'),'utf8');assert.ok(!/sk-synthetic|Signature=|secret-policy|secret-signature|oss:\/\//.test(persisted));
 const reopened=await VoiceSetupService.open(f.options);await assert.rejects(reopened.confirm({operationId:op.operationId,expectedRevision:finished.revision,costConsent:true},signal()));assert.equal(f.calls.length,5);
});
test('configuration change blocks confirmation with no calls',async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal());f.setCurrent(false);
 await assert.rejects(f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal()));assert.equal(f.calls.length,0);
});
test('concurrent confirms do not duplicate clone; cancellation blocks late success and future retry',async t=>{
 const f=await fixture(t);let finish!:(r:Response)=>void;f.setDelay(new Promise(resolve=>finish=resolve));
 const op=await f.service.prepare(f.prepareInput,signal()), pending=f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal());
 await assert.rejects(f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal()));
 while(f.reservations.length===0)await new Promise(resolve=>setImmediate(resolve));
 const cancelled=await f.service.cancel(op.operationId);assert.equal(cancelled.phase,'unknown');assert.equal((await pending).phase,'unknown');
 finish(json({output:{base_resp:{status_code:0},input_sensitive:false,input_sensitive_type:0},usage:{characters:5}}));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.registry.snapshot().voices.length,0);assert.equal(f.reservations.length,1);
 const reopened=await VoiceSetupService.open(f.options), same=await reopened.prepare(f.prepareInput,signal());assert.equal(same.phase,'unknown');
 await assert.rejects(reopened.confirm({operationId:op.operationId,expectedRevision:same.revision,costConsent:true},signal()));assert.equal(f.reservations.length,1);
});
test('interrupted durable stage is displayed unknown and never resumed',async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal());
 await writeFile(join(f.root,'operations',op.operationId+'.json'),JSON.stringify({...op,phase:'cloning',revision:2}));
 const reopened=await VoiceSetupService.open(f.options);assert.equal((await reopened.get(op.operationId)).phase,'unknown');
 await assert.rejects(reopened.confirm({operationId:op.operationId,expectedRevision:2,costConsent:true},signal()));assert.equal(f.calls.length,0);
});
test('cancel prepared remains cancelled after reopen, no calls',async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal());assert.equal((await f.service.cancel(op.operationId)).phase,'cancelled');
 const reopened=await VoiceSetupService.open(f.options);assert.equal((await reopened.prepare(f.prepareInput,signal())).phase,'cancelled');assert.equal(f.calls.length,0);
});
test('config changes while clone is pending reject late receipt and registration',async t=>{
 const f=await fixture(t);let finish!:(r:Response)=>void;f.setDelay(new Promise(resolve=>finish=resolve));
 const op=await f.service.prepare(f.prepareInput,signal()),pending=f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal());
 while(f.reservations.length===0)await new Promise(resolve=>setImmediate(resolve));f.setCurrent(false);
 finish(json({output:{base_resp:{status_code:0},input_sensitive:false,input_sensitive_type:0,demo_audio:'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/demo.mp3'},usage:{characters:5}}));
 const result=await pending;assert.equal(result.phase,'unknown');assert.equal(result.errorCode,'configuration_changed');assert.equal(result.cloneReceipt,null);assert.equal(f.registry.snapshot().voices.length,0);
});
test('first-use unknown failure retains cloned ID, never registers and cannot retry',async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal()),ready=await f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal());
 f.setDelay(Promise.resolve(new Response('secret-provider-body',{status:503})));
 const failed=await f.service.confirm({operationId:op.operationId,expectedRevision:ready.revision,costConsent:true},signal());
 assert.equal(failed.phase,'unknown');assert.equal(failed.voiceId,ready.voiceId);assert.equal(failed.activationReceipt,null);assert.equal(f.registry.snapshot().voices.length,0);assert.equal(f.settlements[1][1],null);
 const reopened=await VoiceSetupService.open(f.options);await assert.rejects(reopened.confirm({operationId:op.operationId,expectedRevision:failed.revision,costConsent:true},signal()));assert.equal(f.reservations.length,2);
});
test('private reads reject loosened reference, operation and sample permissions without chmod repair', {skip:process.platform==='win32'}, async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal());
 const ready=await f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal());
 const targets=[join(f.root,'references',f.reference.id+'.wav'),join(f.root,'references',f.reference.id+'.json'),join(f.root,'operations',op.operationId+'.json'),join(f.root,'operations',op.operationId+'-demo.audio')];
 for(const file of targets){
  await chmod(file,0o644);await assert.rejects(privateRead(file,20*1024*1024),{code:'unsafe_storage'});assert.equal((await stat(file)).mode&0o777,0o644);await chmod(file,0o600);
 }
 await chmod(join(f.root,'operations',op.operationId+'-demo.audio'),0o644);await assert.rejects(f.service.sample(ready.operationId,'demo'),{code:'unsafe_storage'});
});
test('private directory rejects public final directory and leaves existing parents unchanged', {skip:process.platform==='win32'}, async t=>{
 const f=await fixture(t),parent=join(f.root,'public-parent'),leaf=join(parent,'private-child');
 await mkdir(parent,{mode:0o755});await privateDirectory(leaf);assert.equal((await stat(parent)).mode&0o777,0o755);assert.equal((await stat(leaf)).mode&0o777,0o700);
 await chmod(leaf,0o755);await assert.rejects(privateDirectory(leaf),{code:'unsafe_storage'});assert.equal((await stat(leaf)).mode&0o777,0o755);
});
test('close aborts and drains active paid operation, rejects new work and never accepts late success',async t=>{
 const f=await fixture(t);let finish!:(r:Response)=>void;f.setDelay(new Promise(resolve=>finish=resolve));
 const op=await f.service.prepare(f.prepareInput,signal()),pending=f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal());
 while(f.reservations.length===0)await new Promise(resolve=>setImmediate(resolve));
 const closing=f.service.close();assert.equal(f.service.close(),closing);await closing;
 assert.equal((await pending).phase,'unknown');assert.deepEqual(f.settlements,[[op.operationId+':clone',null]]);
 await assert.rejects(f.service.prepare(f.prepareInput,signal()),{code:'operation_unavailable'});
 await assert.rejects(f.service.confirm({operationId:op.operationId,expectedRevision:3,costConsent:true},signal()),{code:'operation_unavailable'});
 finish(json({output:{base_resp:{status_code:0},input_sensitive:false,input_sensitive_type:0},usage:{characters:5}}));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.registry.snapshot().voices.length,0);assert.equal(f.reservations.length,1);assert.equal((await f.service.get(op.operationId)).phase,'unknown');
});
test('explicit retry after model enablement preserves original rejection and needs a fresh confirmation',async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal());f.setDelay(Promise.resolve(new Response('forbidden',{status:403})));
 const rejected=await f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal());
 assert.equal(rejected.phase,'failed');assert.equal(rejected.errorCode,'provider_not_enabled');
 const calls=f.calls.length, retry=await f.service.retry({operationId:op.operationId,expectedRevision:rejected.revision},signal());
 assert.equal(f.calls.length,calls);assert.equal(retry.phase,'prepared');assert.notEqual(retry.operationId,op.operationId);assert.notEqual(retry.voiceId,op.voiceId);
 assert.equal((await f.service.retry({operationId:op.operationId,expectedRevision:rejected.revision},signal())).operationId,retry.operationId);
 assert.equal((await f.service.get(op.operationId)).phase,'failed');assert.equal(f.settlements[0][1],0);
 f.setDelay(Promise.resolve(json({output:{base_resp:{status_code:0},input_sensitive:false,input_sensitive_type:0,demo_audio:'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/demo.mp3'},usage:{characters:5}})));
 const ready=await f.service.confirm({operationId:retry.operationId,expectedRevision:retry.revision,costConsent:true},signal());assert.equal(ready.phase,'clone_ready');assert.equal(f.reservations.length,2);assert.notEqual(f.reservations[0],f.reservations[1]);
});
test('explicit first-use permission retry reuses clone and never repeats upload or cloning',async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal()),ready=await f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal());
 f.setDelay(Promise.resolve(json({output:{base_resp:{status_code:2038}}})));
 const failed=await f.service.confirm({operationId:op.operationId,expectedRevision:ready.revision,costConsent:true},signal());assert.equal(failed.phase,'failed');
 const retry=await f.service.retry({operationId:op.operationId,expectedRevision:failed.revision},signal());assert.equal(retry.phase,'clone_ready');assert.equal(retry.voiceId,ready.voiceId);assert.deepEqual(retry.cloneReceipt,ready.cloneReceipt);assert.equal(retry.demoAvailable,true);
 assert.equal(f.settlements[1][1],0);const before=f.calls.length;
 f.setDelay(Promise.resolve(json({output:{base_resp:{status_code:0},data:{status:2,audio:Buffer.from(pcm16Wav(new Float32Array(2400),24000)).toString('hex')}},usage:{characters:5}})));
 const done=await f.service.confirm({operationId:retry.operationId,expectedRevision:retry.revision,costConsent:true},signal());assert.equal(done.phase,'registered');assert.equal(f.calls.length,before+1);assert.equal(f.registry.snapshot().voices.length,1);
});
test('explicit retry refuses unknown, cancelled, wrong revision and changed configuration',async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal());
 await assert.rejects(f.service.retry({operationId:op.operationId,expectedRevision:1},signal()));
 f.setDelay(Promise.resolve(new Response('uncertain',{status:503})));
 const unknown=await f.service.confirm({operationId:op.operationId,expectedRevision:1,costConsent:true},signal());assert.equal(unknown.phase,'unknown');
 await assert.rejects(f.service.retry({operationId:op.operationId,expectedRevision:unknown.revision},signal()));
 const prepared=await f.service.prepare({...f.prepareInput,label:'second'},signal()),cancelled=await f.service.cancel(prepared.operationId);
 await assert.rejects(f.service.retry({operationId:prepared.operationId,expectedRevision:cancelled.revision},signal()));
 const last=await f.service.prepare({...f.prepareInput,label:'third'},signal());f.setDelay(Promise.resolve(new Response('forbidden',{status:403})));
 const failed=await f.service.confirm({operationId:last.operationId,expectedRevision:1,costConsent:true},signal());
 await assert.rejects(f.service.retry({operationId:last.operationId,expectedRevision:1},signal()));f.setCurrent(false);
 await assert.rejects(f.service.retry({operationId:last.operationId,expectedRevision:failed.revision},signal()));
});
test('legacy permission failure without explicit settled-zero proof cannot retry',async t=>{
 const f=await fixture(t),op=await f.service.prepare(f.prepareInput,signal());
 const legacy={...op,phase:'failed',errorCode:'provider_not_enabled',revision:3};delete legacy.retryAvailable;
 await writeFile(join(f.root,'operations',op.operationId+'.json'),JSON.stringify(legacy));
 assert.equal((await f.service.get(op.operationId)).retryAvailable,false);
 await assert.rejects(f.service.retry({operationId:op.operationId,expectedRevision:3},signal()),{code:'operation_unavailable'});assert.equal(f.calls.length,0);
});
test('POSIX ownership mismatch is rejected without altering filesystem owner', {skip:process.platform==='win32'}, async t=>{
 const f=await fixture(t);assert.equal(typeof process.getuid,'function');
 const posixProcess=process as NodeJS.Process & { getuid: () => number };
 const uid=posixProcess.getuid(),mocked=t.mock.method(posixProcess,'getuid',()=>uid+1);
 try{
  await assert.rejects(privateRead(join(f.root,'references',f.reference.id+'.wav'),20*1024*1024),{code:'unsafe_storage'});
  await assert.rejects(privateDirectory(join(f.root,'references')),{code:'unsafe_storage'});
 }finally{mocked.mock.restore();}
});
