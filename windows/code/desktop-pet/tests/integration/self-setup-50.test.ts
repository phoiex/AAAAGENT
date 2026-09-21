import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, readFile, lstat, readdir, writeFile, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstRunDraft, startFirstRunSetup } from '../../app/self-setup.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagedCredentialStore } from '../../management/credential-store.js';
import { credentialRegistry } from '../../management/credentials.js';
import { effectiveTrialConfiguration } from '../../management/settings.js';
import { pcm16Wav } from '../../media/wav.js';

async function fixture(t:test.TestContext){
 const directory=await realpath(await mkdtemp(resolve(tmpdir(),'first-run-50-'))),root=resolve(directory,'project');await mkdir(root);
 const calls:string[]=[],authorizations:(string|null)[]=[];let refusal=false;
 const fetcher=(async(url:any,init:RequestInit={})=>{
  const address=String(url);calls.push(address);authorizations.push(new Headers(init.headers).get('Authorization'));
  if(address.includes('/uploads?'))return Response.json({data:{upload_host:'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com/',upload_dir:'dashscope-instant/testing',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true',expire_in_seconds:3600,policy:'synthetic-policy',signature:'synthetic-signature',oss_access_key_id:'synthetic-oss'}});
  if(address.includes('dashscope-file-mgr'))return new Response('');
  if(address.includes('demo.mp3'))return new Response('ID3synthetic');
  if(refusal)return new Response('',{status:403});
  const body=JSON.parse(String(init.body));
  return body.input.action==='voice_clone'?Response.json({output:{base_resp:{status_code:0},input_sensitive:false,input_sensitive_type:0,demo_audio:'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/demo.mp3?Signature=synthetic-private'},usage:{characters:3}}):Response.json({output:{base_resp:{status_code:0},data:{status:2,audio:Buffer.from(pcm16Wav(new Float32Array(2400),24000)).toString('hex')}},usage:{characters:3}});
 }) as typeof fetch;
 const options={credentialDirectory:resolve(directory,'keys'),fetch:fetcher,uiRoot:fileURLToPath(new URL('../../../management/ui',import.meta.url))};
 let service=await startFirstRunSetup(root,options);
 t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
 async function request(path='',body?:unknown,method=body?'POST':'GET'){
  const response=await fetch(service.origin+'/api/self-setup'+path,{method,headers:{Authorization:'Bearer '+service.token,...(body?{Origin:service.origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return{status:response.status,value:await response.json() as any};
 }
 return {root,calls,authorizations,options,request,get service(){return service;},setRefusal:(value:boolean)=>refusal=value,async restart(){await service.close();service=await startFirstRunSetup(root,options);}};
}
const key='sk-fixture-only';
test('real loopback first-run works with zero keys, config, voice or assets; metadata view does not call cloud or create user data',async t=>{
 const f=await fixture(t),s=await f.request();assert.equal(s.status,200);assert.equal(s.value.mode,'first-run');assert.ok(s.value.credentials.every((c:any)=>c.status==='missing'));
 assert.equal(s.value.budget.mode,'unlimited');assert.equal(s.value.budget.limitMicros,null);assert.equal(s.value.operations.length,0);assert.equal(s.value.references.length,0);assert.equal(s.value.initialization.completed,false);assert.ok(s.value.initialization.blockers.length>=2);
 assert.equal(f.calls.length,0);await assert.rejects(lstat(resolve(f.root,'data')));await assert.rejects(lstat(f.options.credentialDirectory));
 assert.ok(!JSON.stringify(s.value).includes(f.root));assert.ok(!JSON.stringify(s.value).includes('credentialFile'));
 const unauthorized=await fetch(f.service.origin+'/api/self-setup');assert.equal(unauthorized.status,401);
 const foreign=await fetch(f.service.origin+'/api/self-setup/credentials',{method:'POST',headers:{Authorization:'Bearer '+f.service.token,Origin:'https://foreign.invalid','Content-Type':'application/json'},body:'{}'});assert.equal(foreign.status,403);
 const old=await f.request('/credentials',{instanceId:'stale',provider:'dashscope',key,expectedRevision:0,operationId:'synthetic-key'});assert.equal(old.status,409);
 const malformed=await f.request('/credentials',{instanceId:s.value.instanceId,provider:'minimax',key,expectedRevision:0,operationId:'synthetic-key'});assert.equal(malformed.status,400);assert.equal(JSON.stringify(malformed).includes(key),false);
 const finish=await f.request('/finish',{instanceId:s.value.instanceId,expectedRevision:0});assert.equal(finish.status,400);assert.equal(f.calls.length,0);
 await assert.rejects(startFirstRunSetup(f.root,f.options),{code:'version_conflict'});
});
test('key saving is immutable and distinct from model selection; persisted settings reopen without keys in responses',async t=>{
 const f=await fixture(t),s=(await f.request()).value,instanceId=s.instanceId;
 const saved=await f.request('/credentials',{instanceId,provider:'deepseek',key,expectedRevision:0,operationId:'synthetic-deepseek'});assert.equal(saved.status,200);
 const bailian=await f.request('/credentials',{instanceId,provider:'dashscope',key:key+'2',expectedRevision:1,operationId:'synthetic-bailian'});assert.equal(bailian.status,200);
 assert.deepEqual((await f.request()).value.settings.saved,s.settings.saved);
 const settings=structuredClone(s.settings.saved);for(const p of Object.values(settings.providers) as any[])p.credentialRef=p.provider==='deepseek'?saved.value.credentialRef:bailian.value.credentialRef;
 assert.equal((await f.request('/settings',{instanceId,expectedRevision:0,settings},'PUT')).status,200);
 assert.deepEqual((await f.request()).value.settings.effective,s.settings.effective);assert.equal(f.calls.length,0);
 await f.restart();const reopened=(await f.request()).value;assert.deepEqual(reopened.settings.saved,settings);assert.equal(reopened.credentialRevision,2);assert.equal(JSON.stringify(reopened).includes(key),false);
 assert.equal((await f.request('/settings',{instanceId,expectedRevision:1,settings},'PUT')).status,409);
 assert.ok(reopened.credentials.filter((c:any)=>c.managed).every((c:any)=>c.status==='configured'));
 const draft=firstRunDraft(f.root,f.options.credentialDirectory),managed=new ManagedCredentialStore(f.root,f.options.credentialDirectory),registry=credentialRegistry(draft,managed);
 const finishedBase=effectiveTrialConfiguration(draft,settings,registry,true);
 const runtimeSettings=await ManagementSettingsStore.open(resolve(f.root,'.local/model-evaluation/trial/user-trial/management-settings.json'),finishedBase,undefined,{credentials:credentialRegistry(finishedBase,managed),draftOnly:true});
 assert.deepEqual(runtimeSettings.snapshot().saved,settings); // Revision-zero placeholder history survives final config preparation.
});
test('real HTTP upload/clone/first-use use two confirmations, same ledger and bound registry without changing selected voice',async t=>{
 const f=await fixture(t),s=(await f.request()).value,instanceId=s.instanceId;
 const credential=(await f.request('/credentials',{instanceId,provider:'dashscope',key,expectedRevision:0,operationId:'synthetic-bailian'})).value;
 const audioBase64=Buffer.from(pcm16Wav(new Float32Array(240000),24000)).toString('base64');
 const upload={instanceId,operationId:'synthetic-reference',filename:'private-name.wav',audioBase64};
 const reference=(await f.request('/reference',upload)).value;assert.equal(reference.durationMs,10000);assert.equal((await f.request('/reference',upload)).value.id,reference.id);
 assert.equal((await readdir(resolve(f.root,'.local/data/voice-assets/self-setup/references'))).length,2);assert.equal(f.calls.length,0);
 const op=(await f.request('/voice/prepare',{instanceId,referenceId:reference.id,label:'自己的声音',targetModel:'MiniMax/speech-2.8-turbo',credentialRef:credential.credentialRef,configRevision:0,text:'你好。'})).value;
 assert.equal(op.phase,'prepared');assert.equal(f.calls.length,0);assert.equal(op.cloneReceipt,undefined);
 assert.equal((await f.request('/voice/confirm',{instanceId,operationId:op.operationId,expectedRevision:1,costConsent:false})).status,400);assert.equal(f.calls.length,0);
 const clone=(await f.request('/voice/confirm',{instanceId,operationId:op.operationId,expectedRevision:1,costConsent:true})).value;assert.equal(clone.phase,'clone_ready');assert.equal(f.calls.length,4);
 await assert.rejects(lstat(resolve(f.root,'.local/data/registered-voices.json')));
 assert.equal((await f.request('/voice/confirm',{instanceId,operationId:op.operationId,expectedRevision:1,costConsent:true})).status,409);assert.equal(f.calls.length,4);
 const ready=(await f.request('/voice/confirm',{instanceId,operationId:op.operationId,expectedRevision:clone.revision,costConsent:true})).value;assert.equal(ready.phase,'registered');assert.equal(f.calls.length,5);
 const ledger=JSON.parse(await readFile(resolve(f.root,'.local/model-evaluation/budget.json'),'utf8'));assert.equal(ledger.entries.length,2);assert.equal(ledger.entries[1].actualMicros,9900600);
 const registry=JSON.parse(await readFile(resolve(f.root,'.local/data/registered-voices.json'),'utf8'));assert.equal(registry.voices[0].credentialRef,credential.credentialRef);
 const after=(await f.request()).value;assert.deepEqual(after.settings.saved,s.settings.saved);assert.ok(!/synthetic-private|credentialFile|cloneReceipt|private-name/.test(JSON.stringify(after)));
 const sample=await fetch(f.service.origin+'/api/self-setup/voice/sample?instanceId='+instanceId+'&operationId='+op.operationId+'&kind=activation',{headers:{Authorization:'Bearer '+f.service.token}});assert.equal(sample.status,200);assert.equal(sample.headers.get('content-type'),'audio/wav');assert.ok((await sample.arrayBuffer()).byteLength>44);
});
test('explicit 403 recovery preserves old refusal and zero-charge receipt; refresh and retry preparation do not call cloud',async t=>{
 const f=await fixture(t),s=(await f.request()).value,instanceId=s.instanceId;
 const credential=(await f.request('/credentials',{instanceId,provider:'dashscope',key,expectedRevision:0,operationId:'synthetic-bailian'})).value;
 const reference=(await f.request('/reference',{instanceId,operationId:'synthetic-reference',filename:'own.wav',audioBase64:Buffer.from(pcm16Wav(new Float32Array(240000),24000)).toString('base64')})).value;
 const op=(await f.request('/voice/prepare',{instanceId,referenceId:reference.id,label:'自己的声音',targetModel:'MiniMax/speech-2.8-turbo',credentialRef:credential.credentialRef,configRevision:0,text:'你好。'})).value;
 f.setRefusal(true);const failed=(await f.request('/voice/confirm',{instanceId,operationId:op.operationId,expectedRevision:1,costConsent:true})).value;assert.equal(failed.phase,'failed');assert.equal(failed.retryAvailable,true);
 const calls=f.calls.length;await f.request();assert.equal(f.calls.length,calls);
 const request={instanceId,operationId:failed.operationId,expectedRevision:failed.revision};const next=(await f.request('/voice/retry',request)).value;
 assert.equal(next.phase,'prepared');assert.notEqual(next.operationId,failed.operationId);assert.equal((await f.request('/voice/retry',request)).value.operationId,next.operationId);assert.equal(f.calls.length,calls);
 f.setRefusal(false);assert.equal((await f.request('/voice/confirm',{instanceId,operationId:next.operationId,expectedRevision:next.revision,costConsent:true})).value.phase,'clone_ready');
 const ledger=JSON.parse(await readFile(resolve(f.root,'.local/model-evaluation/budget.json'),'utf8'));assert.equal(ledger.entries.length,2);assert.equal(ledger.entries[0].actualMicros,0);assert.equal(ledger.entries[0].status,'settled');assert.notEqual(ledger.entries[0].operationId,ledger.entries[1].operationId);
 assert.equal((await f.request()).value.operations.find((o:any)=>o.operationId===failed.operationId).phase,'failed');
});

test('synthetic finish produces pinned prepared config and original activation CLI validates it without calls',async t=>{
 const f=await fixture(t),s=(await f.request()).value,instanceId=s.instanceId;
 const deepseek=(await f.request('/credentials',{instanceId,provider:'deepseek',key,expectedRevision:0,operationId:'synthetic-deepseek'})).value;
 const dashscope=(await f.request('/credentials',{instanceId,provider:'dashscope',key:key+'2',expectedRevision:1,operationId:'synthetic-dashscope'})).value;
 const settings=s.settings.saved;for(const p of Object.values(settings.providers) as any[])p.credentialRef=p.provider==='deepseek'?deepseek.credentialRef:dashscope.credentialRef;
 assert.equal((await f.request('/settings',{instanceId,expectedRevision:0,settings},'PUT')).status,200);
 const code=resolve(f.root,'code/desktop-pet'),sourceCode=fileURLToPath(new URL('../../../',import.meta.url));await mkdir(code,{recursive:true});
 await cp(resolve(sourceCode,'dist'),resolve(code,'dist'),{recursive:true});await cp(resolve(sourceCode,'tools'),resolve(code,'tools'),{recursive:true});await writeFile(resolve(code,'package.json'),JSON.stringify({type:'module'}));
 await symlink(resolve(sourceCode,'node_modules'),resolve(code,'node_modules'),process.platform==='win32'?'junction':'dir');
 const asset=resolve(code,'desktop/assets/local-model'),manifest=JSON.stringify({FileReferences:{Moc:'synthetic.moc3',Expressions:[],Motions:{}}}),moc='synthetic-not-a-live-model';
 await mkdir(asset,{recursive:true});await writeFile(resolve(asset,'pet.model3.json'),manifest);await writeFile(resolve(asset,'synthetic.moc3'),moc);
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),fingerprint=hash('pet.model3.json\0'+hash(manifest)+'\nsynthetic.moc3\0'+hash(moc)+'\n');
 await writeFile(resolve(asset,'presets.json'),JSON.stringify({schemaVersion:1,modelId:'synthetic',modelFingerprint:fingerprint,items:[{id:'neutral',label:'合成',category:'idle',source:'procedural',availability:'manual',defaultEnabled:false,previewable:true}]}));
 for(const path of ['desktop/build/renderer.js',...(process.platform==='win32'?['desktop/electron/main.mjs','desktop/electron/preload.cjs','desktop/electron/transport.mjs','desktop/electron/layout.mjs','desktop/electron/assets.mjs','tools/management-url.mjs']:['desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet'])]){await mkdir(dirname(resolve(code,path)),{recursive:true});await writeFile(resolve(code,path),'synthetic-pinned-bytes-never-executed');}
 assert.deepEqual((await f.request()).value.initialization.blockers,[]);
 const ready=await f.request('/finish',{instanceId,expectedRevision:1});assert.equal(ready.status,200,JSON.stringify(ready));assert.equal(ready.value.status,'prepared');
 const dir=resolve(f.root,'.local/model-evaluation/trial/user-trial'),configBefore=await readFile(resolve(dir,'config.json'),'utf8');
 assert.equal(JSON.parse(await readFile(resolve(dir,'activation.json'),'utf8')).status,'prepared');assert.equal(JSON.parse(configBefore).limitMicros,null);
 const template=await readFile(resolve(sourceCode,'tools/configure-local.mjs'),'utf8');await mkdir(resolve(code,'tools'),{recursive:true});
 await writeFile(resolve(code,'tools/configure-local.mjs'),template);
 execFileSync(process.execPath,[resolve(code,'tools/configure-local.mjs'),'--activate-existing'],{timeout:20000,stdio:'pipe'});
 assert.equal(JSON.parse(await readFile(resolve(dir,'activation.json'),'utf8')).status,'active');assert.equal(await readFile(resolve(dir,'config.json'),'utf8'),configBefore);assert.equal(f.calls.length,0);
});

test('HTTP key save normalizes only outer whitespace, rejects injection, and preserves new format across restart and voice requests',async t=>{
 const f=await fixture(t);let instanceId=(await f.request()).value.instanceId;const key='sk-ws-demo.part.signature';
 for(const bad of ['', 'key\r\nHeader:injection', 'key with space', 'key\0bad']) {
  const reply=await f.request('/credentials',{instanceId,provider:'dashscope',key:bad,expectedRevision:0,operationId:'synthetic-invalid'});assert.equal(reply.status,400);assert.equal((await f.request()).value.credentialRevision,0);
 }
 const saved=await f.request('/credentials',{instanceId,provider:'dashscope',key:' \t'+key+'\r\n',expectedRevision:0,operationId:'synthetic-new-key'});assert.equal(saved.status,200);assert.equal(JSON.stringify(saved).includes(key),false);assert.equal(f.calls.length,0);
 await f.restart();instanceId=(await f.request()).value.instanceId;
 const reference=(await f.request('/reference',{instanceId,operationId:'synthetic-new-ref',filename:'own.wav',audioBase64:Buffer.from(pcm16Wav(new Float32Array(240000),24000)).toString('base64')})).value;
 const op=(await f.request('/voice/prepare',{instanceId,referenceId:reference.id,label:'测试',targetModel:'MiniMax/speech-2.8-turbo',credentialRef:saved.value.credentialRef,configRevision:0,text:'你好。'})).value;
 const cloned=await f.request('/voice/confirm',{instanceId,operationId:op.operationId,expectedRevision:op.revision,costConsent:true});assert.equal(cloned.value.phase,'clone_ready');
 assert.deepEqual(f.authorizations,['Bearer '+key,null,'Bearer '+key,null]);
});
