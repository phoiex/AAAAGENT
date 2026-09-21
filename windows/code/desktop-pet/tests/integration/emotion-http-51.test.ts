import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { ManagementSnapshot, ManagementMemoryPort } from '../../contracts/management.js';
import type { EmotionStateSnapshot } from '../../contracts/emotion-state.js';
import { startManagementServer } from '../../management/server.js';
import type { ManagementSettingsStore } from '../../management/settings-store.js';

const empty=(subject:'user'|'companion')=>({subject,revision:0,observation:null,updatedAt:null,sourceMessage:null,logicalOrder:null,sessionId:null});
test('actual HTTP route serves readonly authenticated emotion state and the UI module; rejects invalid access before reading',async t=>{
 let reads=0;const state:EmotionStateSnapshot={characterId:'companion',user:empty('user'),companion:empty('companion'),revision:7,pending:0,messages:[],analyses:[],total:0,offset:0,limit:20};
 const server=await startManagementServer({uiRoot:fileURLToPath(new URL('../../../management/ui/',import.meta.url)),memory:{} as ManagementMemoryPort,settings:{async drain(){}} as ManagementSettingsStore,
  snapshot:()=>({runtime:{instanceId:'synthetic-instance'}} as ManagementSnapshot),emotion:{snapshot(characterId,offset,limit){reads++;return {...state,characterId,offset,limit};}}});t.after(()=>server.close());
 const url=server.origin+'/api/emotion?characterId=companion&offset=0&limit=20',headers={Authorization:'Bearer '+server.token,Origin:server.origin};
 assert.equal((await fetch(url)).status,401);assert.equal(reads,0);
 assert.equal((await fetch(url,{headers:{...headers,Origin:'https://foreign.invalid'}})).status,403);assert.equal(reads,0);
 const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{...state,instanceId:'synthetic-instance',version:'0.1.1'});assert.equal(reads,1);
 for(const query of ['characterId=other','characterId=companion&offset=-1','characterId=companion&limit=101','characterId=companion&limit=NaN'])assert.equal((await fetch(server.origin+'/api/emotion?'+query,{headers})).status,400);
 assert.equal((await fetch(url,{method:'POST',headers})).status,404);assert.equal(reads,1);
 const asset=await fetch(server.origin+'/emotion-view.mjs');assert.equal(asset.status,200);assert.match(await asset.text(),/当前情绪/);
});

test('actual HTTP reads runtime SQLite emotion state and source editing removes the dependent state',async t=>{
 const {mkdirSync,mkdtempSync,rmSync}=await import('node:fs'),{join}=await import('node:path');
 const {SqliteMemoryStore,CONFIRMED_RETENTION}=await import('../../memory/sqlite-store.js');
 const {confirmedInvitationPolicy}=await import('../../companion/invitations.js');
 const {SqliteManagementMemoryPort}=await import('../../memory/management-port.js');
 const {lifecycle}=await import('../memory/lifecycle-fixture.js');
 const base=fileURLToPath(new URL('../../../../../.local/emotion-state-51/tmp/',import.meta.url));mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'http-'));
 const store=new SqliteMemoryStore({filename:join(directory,'synthetic.sqlite'),retention:CONFIRMED_RETENTION,invitations:confirmedInvitationPolicy('Asia/Shanghai')});
 const scope={characterId:'companion' as const,sessionId:'synthetic-http',turnId:'synthetic-user',generation:1},source={id:'synthetic-user:user',version:1};
 store.append(scope,[{characterId:'companion',id:source.id,role:'user',text:'我有点难过',createdAt:new Date().toISOString(),emotionObservations:[{subject:'user',label:'sad',intensity:null,confidence:null,provenance:'user_explicit',sources:[source]}]}]);
 const server=await startManagementServer({uiRoot:fileURLToPath(new URL('../../../management/ui/',import.meta.url)),memory:new SqliteManagementMemoryPort(store,lifecycle(store)),settings:{async drain(){}} as ManagementSettingsStore,
  snapshot:()=>({runtime:{instanceId:'synthetic-database'}} as ManagementSnapshot),emotion:store.emotion});
 t.after(async()=>{await server.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const headers={Authorization:'Bearer '+server.token,Origin:server.origin,'Content-Type':'application/json'};
 const read=async()=>{const r=await fetch(server.origin+'/api/emotion?characterId=companion',{headers});assert.equal(r.status,200);return await r.json() as EmotionStateSnapshot;};
 const before=await read();assert.equal(before.user.observation?.label,'sad');assert.equal(before.messages[0]?.observations[0]?.intensity,null);
 const edited=await fetch(server.origin+'/api/records/edit',{method:'POST',headers,body:JSON.stringify({characterId:'companion',id:source.id,expectedVersion:1,operationId:'synthetic-correction',text:'我现在很平静',reason:'合成来源纠正'})});assert.equal(edited.status,200);
 const after=await read();assert.equal(after.user.observation,null);assert.equal(after.total,0);assert.ok(after.revision>before.revision);
});
