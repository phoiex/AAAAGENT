import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DialogueRequest, PerceptionResult, TurnScope } from '../../contracts/index.js';
import type { EmotionAssessment, EmotionInferenceInput, EmotionObservation } from '../../contracts/emotion-state.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { lifecycle, signal, forget, none } from '../memory/lifecycle-fixture.js';
import { EmotionTurns } from '../../core/emotion-state.js';
import { DialoguePipeline, type DialoguePorts } from '../../core/dialogue-pipeline.js';
import { TurnController } from '../../core/turn-controller.js';

const NOW='2026-09-19T06:00:00Z';
function fixture(t:TestContext){
 const base=fileURLToPath(new URL('../../../../../.local/emotion-state-51/tmp/',import.meta.url));mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'case-'));
 const options={filename:resolve(directory,'synthetic.sqlite'),retention:CONFIRMED_RETENTION,invitations:confirmedInvitationPolicy('Asia/Shanghai'),clock:()=>NOW};
 const stores:SqliteMemoryStore[]=[];const open=()=>{const store=new SqliteMemoryStore(options);stores.push(store);return store;};
 t.after(()=>{for(const s of stores)s.close();rmSync(directory,{recursive:true,force:true});});return {open};
}
const observation=(subject:'user'|'companion',label:string):EmotionObservation=>({subject,label,intensity:null,confidence:null,provenance:subject==='user'?'text_recent_context':'companion_inference',sources:[]});
const assessment=():EmotionAssessment=>({user:observation('user','sad'),companion:observation('companion','关心')});
function ports(store:SqliteMemoryStore,emotion:EmotionTurns,reply:(input:DialogueRequest)=>Promise<EmotionAssessment|undefined>):DialoguePorts{
 const memory=lifecycle(store);
 return {emotion,outputMode:'text',memory,memoryLifecycle:memory,
  perception:{async perceive(){throw Error('no-device');}},
  dialogue:{async reply(input){const emotionAssessment=await reply(input);return {scope:input.scope,text:'我在听。',expression:{emotion:'neutral',intensity:0.4,delivery:'自然',gesture:null},...(emotionAssessment?{emotionAssessment}:{})};}},
  tts:{async synthesize(){throw Error('no-audio');}},playback:{async play(){throw Error('no-playback');},async stop(){}},mediaStore:{async put(){throw Error('no-media');},async read(){throw Error('no-media');},async releaseScope(){}}};
}

test('text pipeline freezes both transcripts and the next turn reads independent U/M across restart',async t=>{
 const f=fixture(t);let store=f.open();const emotion=new EmotionTurns(store.emotion,store);t.after(()=>emotion.close());
 const controller=new TurnController();let calls=0;const seen:DialogueRequest[]=[];
 const pipeline=new DialoguePipeline(ports(store,emotion,async input=>{seen.push(input);return ++calls===1?assessment():{user:null,companion:null};}),controller,()=>{});
 const first=controller.begin('text','这次考试落榜让我很失落');assert.equal((await pipeline.run(first.input,first.signal)).status,'replied');
 const frozen=store.emotion.message(first.input.scope,`${first.input.scope.turnId}:user`)!;
 assert.equal(frozen.observations.length,0);assert.equal(frozen.background.user.observation,null);
 const savedAssistant=store.emotion.message(first.input.scope,`${first.input.scope.turnId}:assistant`)!;
 assert.equal(savedAssistant.role,'assistant');assert.equal(savedAssistant.observations.length,0);
 assert.equal(savedAssistant.background.user.observation?.label,'sad');assert.equal(savedAssistant.background.companion.observation?.label,'关心');
 const next=controller.begin('text','嗯');assert.equal((await pipeline.run(next.input,next.signal)).status,'replied');
 assert.equal(seen[1]!.context.emotionBackground?.user.observation?.label,'sad');assert.equal(seen[1]!.context.emotionBackground?.companion.observation?.label,'关心');
 assert.equal(seen[1]!.context.emotionBackground?.user.observation?.intensity,null);
 assert.deepEqual(store.emotion.message(first.input.scope,frozen.message.id),frozen);
 await emotion.close();store.close();store=f.open();
 const current=store.emotion.background({...next.input.scope,sessionId:'reopened'});assert.equal(current.user.observation?.label,'sad');assert.equal(current.companion.observation?.label,'关心');
});

test('explicit user denial overrides modality; third person, past and hypothetical are not explicit present observations',t=>{
 const store=fixture(t).open(),emotion=new EmotionTurns(store.emotion,store);t.after(()=>emotion.close());
 const scope:TurnScope={characterId:'companion',sessionId:'s',turnId:'t',generation:1},ref={id:'t:user',version:1};
 const perception:PerceptionResult={scope,status:'complete',transcript:'我并不难过',audioEmotion:'sad',modalities:[{modality:'audio',status:'used',inputIds:['synthetic']}],cues:[]};
 const observations=emotion.observations(scope,ref,'我并不难过',perception);
 store.append(scope,[{id:ref.id,characterId:'companion',role:'user',text:'我并不难过',createdAt:NOW,emotionObservations:observations}]);
 assert.equal(store.emotion.background(scope).user.observation?.label,'unknown');assert.equal(store.emotion.background(scope).user.observation?.provenance,'user_explicit');
 for(const text of ['朋友今天很难过','我以前很难过，现在好多了','如果没通过我会很难过'])assert.deepEqual(emotion.observations(scope,ref,text,null),[]);
});

test('hung optional inference never blocks foreground or close; cancelled late result cannot update state',async t=>{
 const store=fixture(t).open();let release!:(a:EmotionAssessment)=>void;let captured:EmotionInferenceInput|undefined;
 const held=new Promise<EmotionAssessment>(resolve=>{release=resolve;});
 const emotion=new EmotionTurns(store.emotion,store,{infer:async input=>{captured=structuredClone(input);return held;}});
 const controller=new TurnController(),pipeline=new DialoguePipeline(ports(store,emotion,async()=>undefined),controller,()=>{});
 const turn=controller.begin('text','今天有件事想跟你说');
 const outcome=await pipeline.run(turn.input,turn.signal);assert.equal(outcome.status,'replied');await new Promise(r=>setImmediate(r));assert.ok(captured);
 assert.equal(captured.recent.some(m=>m.role==='assistant'),false,'inference only sees original frozen context');
 emotion.cancel(turn.input.scope);await emotion.close();release(assessment());await new Promise(r=>setImmediate(r));
 const current=store.emotion.snapshot('companion',0,20);assert.equal(current.user.observation,null);assert.equal(current.companion.observation,null);assert.equal(current.pending,0);
});

test('ordinary emotion completion preserves issued context; forgetting its source invalidates context and inherited snapshots',async t=>{
 const store=fixture(t).open(),memory=lifecycle(store,async input=>input.currentMessageId==='three:user'?forget(input,['one:user']):none(input)),emotion=new EmotionTurns(store.emotion,store);t.after(()=>emotion.close());
 const scope:TurnScope={characterId:'companion',sessionId:'s',turnId:'one',generation:1};
 await memory.append(scope,[{id:'one:user',characterId:'companion',role:'user',text:'今天有些失落',createdAt:NOW}]);
 await memory.prepareTurn(scope,'one:user','今天有些失落',signal());
 const context=await memory.context(scope,'今天有些失落',null,signal()),input=emotion.prepare(context,{id:'one:user',version:1},'今天有些失落')!;
 assert.ok(input);emotion.complete(input,assessment());assert.doesNotThrow(()=>memory.assertContextCurrent(context));
 const second={...scope,turnId:'two',generation:2};await memory.append(second,[{id:'two:user',characterId:'companion',role:'user',text:'嗯',createdAt:NOW}]);await memory.prepareTurn(second,'two:user','嗯',signal());
 const inherited=await memory.context(second,'嗯',null,signal());assert.equal(inherited.emotionBackground?.user.observation?.label,'sad');
 const third={...scope,turnId:'three',generation:3};await memory.append(third,[{id:'three:user',characterId:'companion',role:'user',text:'忘掉那件事',createdAt:NOW}]);
 const forgotten=await memory.prepareTurn(third,'three:user','忘掉那件事',signal());assert.equal(forgotten.status,'applied');
 assert.throws(()=>memory.assertContextCurrent(inherited));
 const state=store.emotion.snapshot('companion',0,20);assert.equal(state.user.observation,null);assert.equal(state.companion.observation,null);
 assert.equal(JSON.stringify(state).includes('关心'),false);
});

test('optional emotion metadata never displaces an otherwise fitting relevant memory',async t=>{
 const {assembleContext}=await import('../../memory/context.js');
 const store=fixture(t).open(),scope:TurnScope={characterId:'companion',sessionId:'budget',turnId:'budget',generation:1};
 const current={id:'budget:user',characterId:'companion' as const,role:'user' as const,text:'海边呢',createdAt:NOW};
 const memory={id:'trip',characterId:'companion' as const,version:1,text:'去海边的合成计划',sourceIds:['old']};
 const reader={characterId:'companion' as const,contextRecords:()=>({characterId:'companion' as const,revision:0,recent:[current],summaries:[],memories:[memory]}),assertContextCurrent(){}};
 const options={prompts:{companion:'合成角色'},inputTokenBudget:100000,maxRecentMessages:12,maxMemories:6,countTokens:(c:unknown)=>JSON.stringify(c).length,relevance:()=>1};
 const baseline=assembleContext(reader,scope,current.text,null,NOW,options);assert.equal(baseline.context.memories[0]?.id,'trip');
 const limited=assembleContext(reader,scope,current.text,null,NOW,{...options,inputTokenBudget:baseline.countedInputTokens,emotionBackground:store.emotion.background(scope)});
 assert.deepEqual(limited.context.recent,baseline.context.recent);assert.deepEqual(limited.context.memories,baseline.context.memories);
 assert.equal(limited.context.emotionBackground,undefined);assert.ok(limited.countedInputTokens<=baseline.countedInputTokens);
});
