import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import type { CharacterId, MemoryChange, MemoryReference, TurnScope } from '../../contracts/index.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteMemoryPort, type SqliteContextOptions } from '../../memory/sqlite-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { contextInputUpperBound } from '../../app/input-budgets.js';
import { scope, message, change, NOW } from './sqlite-fixture.js';
import { lifecycle, signal, deferred } from './lifecycle-fixture.js';

const query = '我现在在哪家公司工作？';
const originalText = '用户这周入职青禾，开始做产品设计。';
const historicalText = '用户在青禾公司做产品设计。';
const options: SqliteContextOptions = { inputTokenBudget:32768, maxRecentMessages:24, maxMemories:32, summaryLimit:8, countTokens:contextInputUpperBound, relevance:()=>1 };
const evidence: unknown[] = [];
test.after(() => {
  if (process.env.W3_RECALL_RECEIPT) writeFileSync(process.env.W3_RECALL_RECEIPT, JSON.stringify({query, validation:'controlled SQLite and context only; no model call', cases:evidence}, null, 2)+'\n');
});

function fixture() {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.local/companion-step1-01/tmp');
  mkdirSync(parent, {recursive:true});
  const directory = mkdtempSync(join(parent, 'case-'));
  const filename = join(directory, 'pet.sqlite');
  let time = NOW;
  const storeOptions = {filename, retention:CONFIRMED_RETENTION, invitations:confirmedInvitationPolicy('Asia/Shanghai'), clock:()=>time};
  const stores: SqliteMemoryStore[] = [];
  return {filename, storeOptions, setTime:(value:string)=>{time=value;}, open:()=>{const s=new SqliteMemoryStore(storeOptions);stores.push(s);return s;},
    cleanup:()=>{for(const s of stores)s.close();rmSync(directory,{recursive:true,force:true});}};
}
function seed(store:SqliteMemoryStore, text:string, id='job', owned=scope()) {
  const sourceId=`${id}:raw`;
  store.append(owned,[message(sourceId,text,owned.characterId,store.now())]);
  assert.equal(store.apply({...change({type:'add',id,text,sourceIds:[sourceId]},`add:${id}`,owned),createdAt:store.now()}).status,'applied');
  return {characterId:owned.characterId,id,version:1,text,sourceIds:[sourceId]};
}
const port=(store:SqliteMemoryStore, overrides:Partial<SqliteContextOptions>={})=>new SqliteMemoryPort(store,{...options,...overrides});
const ids=(records:readonly MemoryReference[])=>records.map(record=>record.id);

test('new product version-two fact survives reopen and reaches context without importing historical checkpoints', async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();seed(store,'用户刚开始找工作。');
  store.append(scope(),[message('confirmed','现在供职于青禾，做产品设计。')]);
  assert.equal(store.apply(change({type:'update',id:'job',expectedVersion:1,text:originalText,sourceIds:['confirmed']},'confirm')).status,'applied');
  const expected:MemoryReference={characterId:'companion',id:'job',version:2,text:originalText,sourceIds:['confirmed']};
  const first=await port(store).context(scope(),query,null,signal());assert.deepEqual(first.memories,[expected]);
  store.close();store=f.open();
  const reopened=await port(store,{maxRecentMessages:0}).context({...scope(),sessionId:'new-session'},query,null,signal());
  assert.deepEqual(reopened.memories,[expected]);assert.deepEqual(reopened.recent,[]);assert.equal(reopened.summary,'');
  assert.ok(contextInputUpperBound(reopened,query)<=options.inputTokenBudget);
  evidence.push({case:'new-product-v2-reopen',first,reopened,oldDatabaseInputs:0});
});

test('both original phrasings and additional finite employment paraphrases reach the issued memory channel unchanged',async t=>{
  const texts=[originalText,historicalText,'用户已入职云杉，担任设计师。','用户目前就职于星海。','用户供职于North Lake。','我刚受雇于远帆。','用户现在在明川上班。','用户在清泉任职。'];
  const questions=[query,'我在哪儿上班？','我目前就职于哪家单位？','我现在的工作单位是哪里？'];
  const rows=[];
  for(const text of texts){
    const f=fixture();t.after(f.cleanup);const store=f.open();const expected=seed(store,text);
    const contexts=[];
    for(const question of questions){
      const context=await port(store,{maxRecentMessages:0}).context(scope(),question,null,signal());
      assert.deepEqual(context.memories,[expected],`${question}: ${text}`);contexts.push(context);
    }
    assert.deepEqual(store.search(scope(),text,1),[expected]);
    rows.push({text,contexts});store.close();
  }
  evidence.push({case:'finite-positive-vocabulary',questions,rows});
});

test('whole-record negative/time/person/topic probes keep legacy maintenance hits out of approved ordinary recall',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();
  const negatives:Record<string,string>={
    negation:'用户没有入职云杉。',future:'用户下月计划入职云杉。',otherPerson:'用户的父亲入职云杉。',
    hypothetical:'用户如果入职云杉就搬家。',past:'用户曾经任职云杉，已经离职。',
    visit:'用户去云杉公司参观。',interview:'用户考虑去云杉公司面试。',residence:'用户目前住在云杉附近。',
    designTopic:'用户设计了入职引导界面。',hobby:'用户喜欢周末设计手帐。',noEmployment:'用户目前无业。',
    suffixNegation:'用户入职云杉，这件事并不是真的。',suffixDeparture:'用户已入职云杉，但后来离职。',
    suffixFuture:'用户入职云杉，是下月的计划。',suffixConditional:'用户入职云杉，只是一个假设。',
    yesterday:'用户昨天入职云杉。',uncertain:'用户可能入职云杉。',quoted:'用户说父亲已入职云杉。',suffixPerson:'用户入职云杉，说的是父亲的经历。',
  };
  // These known lexical hits predate expansion: 公司 in visit/interview, 家 in hypothetical.
  const legacyIds=['hypothetical','interview','visit'];
  for(const [id,text] of Object.entries(negatives))seed(store,text,id);
  assert.deepEqual(ids(store.search(scope(),query,32,'lexical')).sort(),legacyIds);
  const context=await port(store,{maxRecentMessages:0}).context(scope(),query,null,signal());
  assert.deepEqual(context.memories,[]);assert.deepEqual(store.search(scope(),query,32),[]);
  for(const id of legacyIds)assert.ok(store.recall.rank(scope(),query).find(item=>item.source.id===id)!.priority<0.35);
  evidence.push({case:'negative-matrix',negatives,legacyIds,newRelationCandidates:[],context,semanticTruth:'not established by lexical inclusion'});
});

test('employment expansion does not activate for past/future/third-person/unrelated questions',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store,originalText);
  const questions=['我以前在哪家公司工作？','我明年在哪家公司工作？','我的父亲在哪家公司工作？','我现在住在哪里？','午餐吃啥？'];
  for(const question of questions)assert.deepEqual(store.search(scope(),question,32,'lexical'),[],question);
  assert.deepEqual(store.search(scope(),query,0,'lexical'),[]);assert.throws(()=>store.search(scope(),query,-1,'lexical'),/invalid_search_limit/);
  evidence.push({case:'query-relation-gate',questions,results:[]});
});

test('newer record creation cannot turn explicit past or future employment into a current relation candidate',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();const current=seed(store,'用户已入职朔风。','current');
  f.setTime('2026-09-07T12:00:00.000Z');seed(store,'用户曾任职松柏，已经离职。','past');
  f.setTime('2026-09-08T12:00:00.000Z');seed(store,'用户计划明年入职云杉。','future');
  const context=await port(store,{maxRecentMessages:0}).context(scope(),query,null,signal());
  assert.deepEqual(context.memories,[current]);
  const records=['current','past','future'].map(id=>store.inspect(scope(),id));
  assert.ok(records[0]!.createdAt<records[1]!.createdAt&&records[1]!.createdAt<records[2]!.createdAt);
  evidence.push({case:'creation-time-is-not-event-truth',records,context});
});

test('recall survives 32 unrelated user/assistant turns, new session and reopen without recent or summary help',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();const expected=seed(store,originalText);
  for(let i=0;i<32;i++)store.append(scope('companion',`other-${i}`),[
    message(`u-${i}`,`今天读一本小说 ${i}`),{...message(`a-${i}`,`聊聊书中的人物 ${i}`),role:'assistant'},
  ]);
  store.close();store=f.open();const owned={...scope(),sessionId:'after-32-turns'};
  const normal=await port(store).context(owned,query,null,signal());
  const isolated=await port(store,{maxRecentMessages:0}).context(owned,query,null,signal());
  assert.equal(normal.recent.length,24);assert.ok(normal.recent.every(m=>!m.text.includes('青禾')));
  assert.deepEqual(normal.memories,[expected]);assert.deepEqual(isolated.memories,[expected]);
  assert.deepEqual(isolated.recent,[]);assert.equal(isolated.summary,'');
  evidence.push({case:'outside-recent',unrelatedTurns:32,normal,isolated});
});

test('companion survives raw expiry and independent process recall; legacy colliding IDs are refused',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();
  const friend=seed(store,originalText);assert.throws(()=>seed(store,'旧角色内容','job',scope('sweetheart')),/unknown_character/);
  store.close();f.setTime('2026-10-08T12:00:00.000Z');store=f.open();
  for(const characterId of ['companion'] as CharacterId[]){
    assert.equal(store.inspect(scope(characterId),'job:raw')!.state,'expired');
    assert.equal(store.inspect(scope(characterId),'job')!.state,'active');
    assert.deepEqual(store.visible(scope(characterId),'transcript'),[]);
  }
  assert.deepEqual((await port(store).context(scope('companion'),query,null,signal())).memories,[friend]);
  await assert.rejects(()=>port(store).context(scope('sweetheart'),query,null,signal()),/unknown_character/);
  store.close();
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {SqliteMemoryStore} from ${JSON.stringify(new URL('../../memory/sqlite-store.js',import.meta.url).href)};
    import {SqliteMemoryPort} from ${JSON.stringify(new URL('../../memory/sqlite-port.js',import.meta.url).href)};
    const s=new SqliteMemoryStore({...JSON.parse(process.argv[1]),clock:()=> '2026-10-08T12:00:00.000Z'});
    const p=new SqliteMemoryPort(s,{inputTokenBudget:32768,maxRecentMessages:0,maxMemories:32,summaryLimit:8,countTokens:(c,q)=>Buffer.byteLength(JSON.stringify({context:c,currentText:q}),'utf8')+4096,relevance:()=>1});
    const contexts=[];for(const characterId of ['companion'])contexts.push(await p.context({characterId,sessionId:'independent',turnId:'recall',generation:1},process.argv[2],null,new AbortController().signal));
    console.log(JSON.stringify(contexts));s.close();`,JSON.stringify({...f.storeOptions,clock:undefined}),query],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const contexts=JSON.parse(child.stdout);
  assert.deepEqual(contexts[0].memories,[friend]);
  assert.ok(contexts.every((c:{recent:unknown[];summary:string})=>c.recent.length===0&&c.summary===''));
  evidence.push({case:'expired-raw-companion-process-restart',rawExpired:true,processExit:child.status,contexts});
});

test('versioned correction and forgetting invalidate all retrieval paths, derived records, stale contexts and late tasks',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();
  seed(store,'用户在晨星公司工作。');assert.throws(()=>seed(store,'旧角色内容','job',scope('sweetheart')),/unknown_character/);
  store.recordDerived(scope(),{id:'summary',kind:'summary',text:'用户在晨星公司工作。',sourceIds:['job'],createdAt:NOW});
  store.recordDerived(scope(),{id:'cache',kind:'context_cache',text:'用户在晨星公司工作。',sourceIds:['summary'],createdAt:NOW});
  const tracking=lifecycle(store,undefined,undefined,{context:options});const before=await tracking.context(scope(),query,null,signal());
  store.append(scope(),[message('new-raw','我这周刚入职青禾，开始做产品设计了。')]);
  const data=store.contextRecords(scope(),query,24,32,8);
  const task=store.prepareMaintenance({scope:scope(),messages:data.recent,relevantMemories:data.memories});
  const updated=store.finishMaintenance(task,[change({type:'update',id:'job',expectedVersion:1,text:originalText,sourceIds:['new-raw']},'correct-job')]);
  assert.equal(updated[0]!.status,'applied');assert.throws(()=>tracking.assertContextCurrent(before),/stale_context/);
  assert.deepEqual(store.search(scope(),'晨星',32),[]);assert.deepEqual(store.search(scope(),'晨星',32,'lexical'),[]);
  assert.equal(store.inspect(scope(),'job:raw')!.state,'invalidated');assert.deepEqual(store.visible(scope(),'summary'),[]);assert.equal(store.inspect(scope(),'cache')!.text,'');
  const corrected=await tracking.context(scope(),query,null,signal());
  const expected={characterId:'companion',id:'job',version:2,text:originalText,sourceIds:['new-raw']};
  assert.deepEqual(corrected.memories,[expected]);assert.deepEqual(store.search(scope(),'青禾',32),[expected]);
  for(const kind of ['summary','keyword_index','vector_index','context_cache'] as const)store.recordDerived(scope(),{id:`new-${kind}`,kind,text:originalText,sourceIds:['job'],createdAt:NOW});
  const lateData=store.contextRecords(scope(),query,24,32,8);
  const late=store.prepareMaintenance({scope:scope(),messages:lateData.recent,relevantMemories:lateData.memories});
  await assert.rejects(()=>port(store).context(scope('sweetheart'),query,null,signal()),/unknown_character/);
  assert.equal(store.apply(change({type:'soft_delete',id:'job',expectedVersion:2},'forget-job'),['new-raw']).status,'applied');
  assert.throws(()=>tracking.assertContextCurrent(corrected),/stale_context/);
  for(const kind of ['summary','keyword_index','vector_index','context_cache'] as const){assert.deepEqual(store.visible(scope(),kind),[]);assert.equal(store.inspect(scope(),`new-${kind}`)!.text,'');}
  for(const text of ['青禾',query])for(const mode of ['literal','lexical'] as const)assert.deepEqual(store.search(scope(),text,32,mode),[]);
  const forgotten=await tracking.context(scope(),query,null,signal());assert.deepEqual(forgotten.memories,[]);assert.deepEqual(forgotten.recent,[]);assert.equal(forgotten.summary,'');
  store.close();store=f.open();
  const lateResult=store.finishMaintenance(late,[change({type:'add',id:'resurrection',text:originalText,sourceIds:['new-raw']},'late')]);
  assert.equal(lateResult[0]!.reason,'stale_maintenance_epoch');assert.equal(store.inspect(scope(),'resurrection'),null);
  assert.deepEqual(store.search(scope(),query,32,'lexical'),[]);assert.throws(()=>store.search(scope('sweetheart'),query,32,'lexical'),/unknown_character/);
  const db=new Database(f.filename,{readonly:true});
  try{assert.deepEqual(db.prepare('SELECT record_id FROM memory_search WHERE character_id=?').all('companion'),[]);}finally{db.close();}
  evidence.push({case:'update-forget-propagation',before,updated,corrected,forgotten,lateResult,legacyRole:'rejected',companionFtsRows:0});
});

test('asynchronous maintenance retains creation role; cancellation prevents a late expansion write',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();const friend=seed(store,originalText);assert.throws(()=>seed(store,'旧角色内容','job',scope('sweetheart')),/unknown_character/);
  const pending=deferred<readonly MemoryChange[]>();
  const memory=new SqliteMemoryPort(store,options,{propose:async()=>pending.promise});
  const controller=new AbortController();
  const work=memory.maintain(memory.maintenanceInput(scope(),query),controller.signal);
  await assert.rejects(()=>memory.context(scope('sweetheart'),query,null,signal()),/unknown_character/);
  controller.abort(new Error('cancelled-test'));await assert.rejects(work,/cancelled-test/);
  pending.resolve([change({type:'add',id:'late',text:originalText,sourceIds:['job']},'late')]);await Promise.resolve();
  assert.equal(store.inspect(scope(),'late'),null);assert.throws(()=>store.inspect(scope('sweetheart'),'late'),/unknown_character/);
  const scoped=store.prepareMaintenance(memory.maintenanceInput(scope(),query));
  const wrong=store.finishMaintenance(scoped,[change({type:'update',id:'job',expectedVersion:1,text:'用户供职于远帆。',sourceIds:['job']},'wrong',scope('sweetheart'))]);
  assert.equal(wrong[0]!.reason,'task_scope_mismatch');
  assert.deepEqual(store.search(scope(),query,32,'lexical'),[friend]);assert.throws(()=>store.search(scope('sweetheart'),query,32,'lexical'),/unknown_character/);
  await assert.rejects(memory.context(scope(),query,null,controller.signal),/cancelled-test/);
  evidence.push({case:'async-role-and-cancel',friend,legacyRole:'rejected',wrong,lateWrite:false});
});

test('approved priority controls ordinary context despite legacy relevance callback, with real token budget',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();
  const relation=seed(store,originalText,'a-relation');const strong=seed(store,'用户在清泉公司工作。','z-strong');
  for(let i=0;i<40;i++)seed(store,`用户喜欢手工艺 ${i}`,`noise-${i}`);
  const searchOrder=ids(store.search(scope(),query,2,'lexical'));assert.deepEqual(searchOrder,['z-strong','a-relation']);
  const normal=await port(store,{maxRecentMessages:0,maxMemories:2}).context(scope(),query,null,signal());
  assert.deepEqual(normal.memories,[relation,strong]);
  const {emotionBackground: _optionalEmotion, ...coreContext}=normal;
  const oneBudget=contextInputUpperBound({...coreContext,memories:[relation]},query);
  const limited=await port(store,{maxRecentMessages:0,maxMemories:2,inputTokenBudget:oneBudget}).context(scope(),query,null,signal());
  assert.deepEqual(limited.memories,[relation]);assert.ok(contextInputUpperBound(limited,query)<=oneBudget);
  const relevance=await port(store,{maxRecentMessages:0,maxMemories:2,relevance:m=>m.id==='z-strong'?2:0}).context(scope(),query,null,signal());
  assert.deepEqual(relevance.memories,normal.memories); // Fixed approved formula replaces caller-defined scoring.
  const literal=seed(store,query,'exact');assert.deepEqual(store.search(scope(),query,1),[literal]);assert.deepEqual(store.search(scope(),query,1,'lexical'),[literal]);
  evidence.push({case:'candidate-and-context-limits',distractors:40,searchOrder,normal,limited,oneBudget,relevance,literal,limitation:'context may omit an eligible candidate under a tight budget; search order is not issued order'});
});

test('qualified employment candidates survive forty distractors under the approved six-memory ceiling',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();const relation=seed(store,originalText,'z-relation');const strong=seed(store,'用户在清泉公司工作。','a-strong');
  for(let i=0;i<40;i++)seed(store,`用户喜欢收藏手工作品 ${i}`,`noise-${i}`);
  const two=store.search(scope(),query,2,'lexical');assert.deepEqual(two,[strong,relation]);
  const context=await port(store,{maxRecentMessages:0}).context(scope(),query,null,signal());
  assert.equal(context.memories.length,2);assert.deepEqual(context.memories.find(m=>m.id==='z-relation'),relation);
  assert.deepEqual(context.memories.find(m=>m.id==='a-strong'),strong);assert.deepEqual(context.recent,[]);assert.equal(context.summary,'');
  assert.ok(contextInputUpperBound(context,query)<=options.inputTokenBudget);
  evidence.push({case:'original-strong-lexical-crowding-repaired',distractors:40,two,context,relationOmitted:false,remainingLimit:'incidental lexical records can still occupy remaining slots; candidate presence does not establish employer truth'});
});

test('workplace occupations generalize across units and duties while activities and whole-record qualifiers stay excluded',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();
  const positive=[
    '用户在松涛研究所做算法研发。','用户在远帆企业从事市场运营。','用户在白鹭工作室负责平面设计。',
    '用户目前在启明学校担任数学教师。','我在长河银行做财务工作。','用户在North Lake机构从事软件开发。',
  ].map((text,i)=>seed(store,text,`positive-${i}`));
  const negatives=[
    '用户在启明学校做作业。','用户在长河医院做检查。','用户在松涛公司做体操。','用户在松涛公司参观产品设计。',
    '用户以前在松涛研究所做算法研发。','用户在松涛研究所做算法研发，只是明年的计划。',
    '用户在松涛研究所做算法研发，这是父亲的经历。','用户在松涛研究所做算法研发，但并未受雇。',
    '用户如果在白鹭工作室做平面设计，就搬家。','用户在白鹭设计公司看设计展。',
  ];
  for(const [i,text] of negatives.entries())seed(store,text,`negative-${i}`);
  const question='我在哪儿上班？';
  const context=await port(store,{maxRecentMessages:0}).context(scope(),question,null,signal());
  assert.deepEqual(context.memories,positive);assert.deepEqual(context.recent,[]);assert.equal(context.summary,'');
  evidence.push({case:'workplace-occupation-generalization',question,positive,negatives,context});
});

test('maintenance lexical order remains separate from approved relation-score ties in ordinary context',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();
  const strongest=seed(store,'用户在松涛公司工作。','strongest');
  const occupation=seed(store,'用户在松涛公司从事算法研发。','occupation');
  const join=seed(store,'用户已入职天际。','join');
  f.setTime('2026-09-07T12:00:00.000Z');
  const future=seed(store,'用户计划在天际公司工作。','future');const incidental=seed(store,'用户收藏手工艺。','incidental');
  assert.deepEqual(store.search(scope(),query,3,'lexical'),[strongest,occupation,join]);
  assert.deepEqual((await port(store,{maxRecentMessages:0,maxMemories:1}).context(scope(),query,null,signal())).memories,[join]); // Equal relation scores use stable ID order.
  assert.deepEqual(ids(store.search(scope(),'公司',32)).sort(),['future','occupation','strongest']);
  assert.deepEqual(store.search(scope(),'手工艺',32),[incidental]);
  // Preserve ordinary lexical behavior, including pre-existing low-weight 工 matches.
  assert.deepEqual(store.search(scope(),'手工艺怎么样？',32,'lexical'),[incidental,future,strongest]);
  assert.deepEqual(store.search(scope(),'天际',32),[future,join]);
  assert.deepEqual(store.search(scope(),query,32),[]);
  const quoted=seed(store,`用户记下了问题：${query}`,'quoted-question');
  assert.deepEqual(store.search(scope(),query,1),[quoted]);assert.deepEqual(store.search(scope(),query,1,'lexical'),[quoted]);
  const context=await port(store,{maxRecentMessages:0,maxMemories:1}).context(scope(),query,null,signal());
  assert.deepEqual(context.memories,[quoted]);
  evidence.push({case:'qualified-competition-and-literal',ranked:[strongest,occupation,join],future,incidental,quotedExactContext:context,interpretation:'full-query quotation remains an exact hit, not an employer assertion'});
});
