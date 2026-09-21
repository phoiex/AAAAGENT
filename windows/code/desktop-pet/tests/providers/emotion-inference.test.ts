import test from 'node:test';
import assert from 'node:assert/strict';
import type { DialogueRequest } from '../../contracts/index.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';
import { EMOTION_RESPONSE_RULES, parseEmotionAssessment } from '../../providers/emotion-inference.js';

const scope={characterId:'companion' as const,sessionId:'synthetic',turnId:'current',generation:1};
const input:DialogueRequest={scope,text:'今天的考试让我有点不好受',context:{scope,characterPrompt:'用户原有的人格说明',recent:[{id:'current:user',characterId:'companion',role:'user',text:'今天的考试让我有点不好受',createdAt:'2026-09-19T00:00:00Z'}],summary:'',memories:[],perception:null,inputTokenBudget:32768}};
const item=(label:string)=>({label,intensity:null,confidence:null});
function harness(emotion:unknown){
 const bodies:unknown[]=[];
 const provider=new QwenDialogueProvider({endpoint:'https://controlled.invalid/chat/completions',model:'synthetic-only',apiKey:()=> 'synthetic-only',authorizer:{async authorize(){return {async settle(){}};}}},new ProviderTransport(async(_url,init)=>{
  bodies.push(JSON.parse(String(init?.body)));
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'愿意说说发生了什么吗？',expression:{emotion:'neutral',intensity:0.3,delivery:'自然',gesture:null},emotionAssessment:emotion})}}]});
 }));return {provider,bodies};
}

test('text-only dialogue requests independent U/M through exactly one existing request',async()=>{
 const run=harness({user:item('难过'),companion:item('关心')}),before=structuredClone(input);
 const reply=await run.provider.reply(input,new AbortController().signal);
 assert.equal(run.bodies.length,1);assert.equal(reply.emotionAssessment?.user?.label,'sad');assert.equal(reply.emotionAssessment?.companion?.label,'关心');
 assert.equal(reply.emotionAssessment?.user?.intensity,null);assert.equal(reply.emotionAssessment?.user?.confidence,null);
 assert.deepEqual(reply.emotionAssessment?.user?.sources,[{id:'current:user',version:1}]);
 const body=run.bodies[0] as {messages:{role:string;content:string}[]};
 assert.ok(body.messages[0]?.content.startsWith(input.context.characterPrompt+"\n"));
 assert.ok(body.messages.some(m=>m.content.includes(EMOTION_RESPONSE_RULES)));
 assert.deepEqual(input,before);
});

test('missing, partial and malformed optional assessment never suppress spoken reply',async()=>{
 for(const assessment of [undefined,null,{},[],{user:item('sad')},{user:{...item('sad'),confidence:2},companion:null},{user:item('unsupported'),companion:null}]){
  const run=harness(assessment),reply=await run.provider.reply(input,new AbortController().signal);
  assert.equal(reply.text,'愿意说说发生了什么吗？');assert.equal(reply.emotionAssessment,undefined);assert.equal(run.bodies.length,1);
 }
});

test('null and zero remain distinct; model-supplied source identities are ignored',()=>{
 const a=parseEmotionAssessment({user:{...item('sad'),intensity:0,confidence:0,sources:[{id:'future:user',version:90}]},companion:null},input)!;
 assert.equal(a.user?.intensity,0);assert.equal(a.user?.confidence,0);assert.equal(a.companion,null);
 assert.deepEqual(a.user?.sources,[{id:'current:user',version:1}]);
 assert.deepEqual(parseEmotionAssessment({user:null,companion:null},input),{user:null,companion:null});
 assert.equal(parseEmotionAssessment({user:item('sad'),companion:null},{...input,context:{...input.context,recent:[]}}),undefined);
});

test('forget dialogue omits emotion context and ignores returned emotion metadata',async()=>{
 const run=harness({user:item('sad'),companion:item('关心')});
 const reply=await run.provider.reply({...input,memoryOutcome:{scope,request:'forget',status:'applied',results:[],affectedIds:['synthetic-forgotten'],retrievalInvalidated:true,clarification:null}},new AbortController().signal);
 assert.equal(reply.emotionAssessment,undefined);assert.equal(JSON.stringify(run.bodies).includes('emotionAssessment'),false);
 assert.equal(JSON.stringify(run.bodies).includes(input.text),false);
});
