import { restrictPrivatePathSync } from '../../core/platform-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedCredentialStore } from '../../management/credential-store.js';
import { readSetupKey } from '../../management/self-setup.js';
import { keyReader } from '../../app/trial-backend.js';
import type { TrialConfiguration } from '../../app/trial-config.js';
import { ProviderTransport } from '../../providers/transport.js';
import { normalizeApiKey } from '../../core/api-key.js';

function fixture(t: test.TestContext) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'key-format-52-'))),project=join(root,'project');mkdirSync(project);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config={projectRoot:project,phaseId:'synthetic-key-52'} as TrialConfiguration;
  const configFile=join(project,'config.json'),activationFile=join(project,'activation.json'),raw=JSON.stringify(config);
  writeFileSync(configFile,raw);writeFileSync(activationFile,JSON.stringify({version:1,status:'active',phaseId:config.phaseId,configSha256:createHash('sha256').update(raw).digest('hex')}));
  return {root,project,config,configFile,activationFile,directory:join(root,'keys')};
}

test('opaque keys survive save, reopen, both production readers and actual Authorization header construction',async t=>{
  const f=fixture(t),store=new ManagedCredentialStore(f.project,f.directory);
  const keys=['sk-old_demo','sk-ws-demo.part.signature','opaque.demo+/=:_-','x'.repeat(4096)];
  for (const [i,key] of keys.entries()) {
    const input={provider:'dashscope' as const,key:' \t'+key+'\r\n',expectedRevision:i,operationId:'synthetic-key-'+i};
    const saved=store.save(input),reopened=new ManagedCredentialStore(f.project,f.directory),file=reopened.entries()[i]!.file;
    assert.equal(readFileSync(file,'utf8'),key);assert.equal(JSON.stringify(saved).includes(key),false);
    assert.deepEqual(reopened.save({...input,key}),saved,'normalized retries remain idempotent');
    assert.equal(await readSetupKey(file,f.project),key);
    writeFileSync(file,' \t'+key+'\r\n');
    assert.equal(await readSetupKey(file,f.project),key);
    const reader=keyReader(file,f.config,f.configFile,f.activationFile);assert.equal(reader(),key);
    let requests=0;
    const transport=new ProviderTransport((async (_url,init)=>{requests++;assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+key);return Response.json({ok:true});}) as typeof fetch);
    await transport.request({endpoint:'https://synthetic.invalid/chat',model:'synthetic',apiKey:reader,authorizer:{async authorize(){return {async settle(){}};}}},{characterId:'companion',sessionId:'synthetic',turnId:'turn-'+i,generation:1},'dialogue',{},new AbortController().signal);
    assert.equal(requests,1);
    writeFileSync(file,key);
  }
});

test('empty, oversized, embedded whitespace and header-unsafe content fail without creating or exposing credentials',async t=>{
  const f=fixture(t),store=new ManagedCredentialStore(f.project,f.directory),file=join(f.root,'external.key');
  for(const key of ['', ' \r\n', 'a'.repeat(4097), 'opaque key', 'opaque\tkey', 'opaque\r\nInjected:yes', 'opaque\0key', 'opaque\x7fkey', 'opaque\x85key', 'opaque\u2003key', 'opaque\u4e2dkey']) {
    assert.equal(normalizeApiKey(key),undefined);
    assert.throws(()=>store.save({provider:'dashscope',key,expectedRevision:0,operationId:'synthetic-invalid'}),{code:'invalid_request'});
    assert.equal(store.entries().length,0);
    writeFileSync(file,key,{mode:0o600});restrictPrivatePathSync(file);
    await assert.rejects(readSetupKey(file,f.project),/credential_unavailable/);
    assert.throws(keyReader(file,f.config,f.configFile,f.activationFile));
  }
  assert.equal(normalizeApiKey(null),undefined);assert.equal(normalizeApiKey(42),undefined);
});

test('new-format keys retain file protection and activation checks',{skip:process.platform==='win32'},async t=>{
  const f=fixture(t),file=join(f.root,'external.key');writeFileSync(file,'sk-ws-demo.signature',{mode:0o600});
  chmodSync(file,0o644);await assert.rejects(readSetupKey(file,f.project));assert.throws(keyReader(file,f.config,f.configFile,f.activationFile));
  chmodSync(file,0o600);writeFileSync(f.activationFile,'{}');assert.throws(keyReader(file,f.config,f.configFile,f.activationFile),/not active/);
});
