import test from 'node:test';
import assert from 'node:assert/strict';
import {CredentialSmoke,safeCredentialError,KEY_TEST_ENDPOINTS} from '../../management/credential-smoke.js';
const input={instanceId:'fixture-instance',provider:'deepseek' as const,credentialRef:'selected-key',operationId:'operation-one'};
const secret='synthetic.key+not/real=';
const success=()=>Response.json({object:'list',data:[]});
const setup=(fetcher:typeof fetch,extra={})=>new CredentialSmoke({key:async(ref,provider)=>{assert.equal(ref,input.credentialRef);assert.equal(provider,input.provider);return secret;},fetch:fetcher,signal:new AbortController().signal,ready:()=>true,...extra});
test('selected complete key, fixed GET, no redirects or request content; cached same operation and coalesced same credential',async()=>{
 let calls=0,release!:()=>void;const wait=new Promise<void>(r=>release=r);
 const service=setup(async(url,init)=>{calls++;assert.equal(url,KEY_TEST_ENDPOINTS.deepseek);assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal(init?.body,undefined);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+secret);await wait;return success();});
 const first=service.test(input),second=service.test({...input,operationId:'operation-two'});assert.equal(first,second);release();assert.equal((await first).ok,true);assert.equal(await service.test(input),await first);assert.equal(calls,1);
 assert.throws(()=>service.test({...input,credentialRef:'other'}));assert.equal((await service.test({...input,operationId:'operation-three'})).ok,true);assert.equal(calls,2);
});
test('provider JSON and plaintext failures preserve diagnostics while removing key and sensitive fields',async()=>{
 for(const response of [Response.json({error:{code:'permission_denied',message:'No access '+secret+' https://private.invalid/?token=sensitive'}},{status:403}),new Response('Authentication Fails (governor) '+secret,{status:401})]){
  const r=await setup(async()=>response).test(input);assert.equal(r.ok,false);assert.match(r.error!,/permission_denied|Authentication Fails/);assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!JSON.stringify(r).includes('sensitive'));assert.ok(!JSON.stringify(r).includes('private.invalid'));
 }
 assert.doesNotMatch(safeCredentialError('key='+secret+' Bearer other.secret token '+encodeURIComponent(secret),secret),/synthetic|other.secret/);
});
test('timeouts, shutdown and activation changes suppress late work without automatic retry',async()=>{
 let calls=0;const service=setup(async()=>{calls++;return new Promise(()=>{});},{timeoutMs:20});
 const result=await service.test(input);assert.match(result.error!,/超时/);assert.equal((await service.test(input)),result);assert.equal(calls,1);
 const stopped=new AbortController();const active=setup(async()=>new Promise(()=>{}),{signal:stopped.signal});const job=active.test(input);stopped.abort();assert.match((await job).error!,/取消|实例/);
 assert.equal((await setup(async()=>{throw Error('must not run');},{ready:()=>false}).test(input)).ok,false);
});
test('only valid provider-specific success accepted; oversized body, redirect/network and malformed JSON fail closed',async()=>{
 for(const response of [Response.json({}),Response.json({success:false,code:'AccountDisabled',message:'account unavailable'}),new Response('not json'),new Response('x'.repeat(65537))])assert.equal((await setup(async()=>response).test(input)).ok,false);
 const network=await setup(async()=>{throw Error(secret);}).test(input);assert.doesNotMatch(network.error!,/synthetic/);
 const aliyun=new CredentialSmoke({key:async()=>secret,fetch:async(url)=>{assert.equal(url,KEY_TEST_ENDPOINTS.dashscope);return Response.json({success:true,code:null,output:{models:[]}});},signal:new AbortController().signal,ready:()=>true});assert.equal((await aliyun.test({...input,provider:'dashscope'})).ok,true);
});
