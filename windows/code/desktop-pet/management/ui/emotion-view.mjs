import {el,button,badge,notice,definition,time} from './dom.mjs';
import {query} from './api.mjs';

const provenance={user_explicit:'用户明确说明',text_recent_context:'文字与近期对话推测',audio:'音频观察',video:'视频观察',companion_inference:'桌宠心情推测'};
const analysisStatus={applied:'当时已应用',stale:'未应用：已过期',cancelled:'未应用：已取消',invalid:'未应用：无效'};
const subjects={user:'用户情绪',companion:'桌宠心情'};
const labels={unknown:'未确定',neutral:'中性',happy:'开心',sad:'难过',angry:'生气',calm:'平静',fear:'害怕',surprise:'惊讶',disgust:'厌恶'};
const count=v=>Number.isSafeInteger(v)&&v>=0;
const text=v=>typeof v==='string'&&v.length>0;
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const nullable=(v,test)=>v===null||test(v);
const score=v=>nullable(v,x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1);
const source=v=>v&&text(v.id)&&count(v.version)&&v.version>0;
const scope=v=>v&&v.characterId==='companion'&&text(v.sessionId)&&text(v.turnId)&&count(v.generation);
const observation=(o,subject)=>o&&Object.hasOwn(subjects,o.subject)&&(!subject||o.subject===subject)&&text(o.label)&&score(o.intensity)&&score(o.confidence)&&Object.hasOwn(provenance,o.provenance)&&Array.isArray(o.sources)&&o.sources.every(source);
const sustained=(s,subject)=>s&&s.subject===subject&&count(s.revision)&&nullable(s.observation,o=>observation(o,subject))&&nullable(s.updatedAt,date)&&nullable(s.sourceMessage,source)&&nullable(s.logicalOrder,count)&&nullable(s.sessionId,text);
const background=b=>b&&sustained(b.user,'user')&&sustained(b.companion,'companion');
const message=m=>m&&['user','assistant'].includes(m.role)&&source(m.message)&&scope(m.scope)&&count(m.logicalOrder)&&date(m.recordedAt)&&Array.isArray(m.observations)&&m.observations.every(o=>observation(o))&&background(m.background);
const analysis=a=>a&&text(a.id)&&source(a.message)&&scope(a.scope)&&date(a.completedAt)&&['dialogue','background'].includes(a.origin)&&Object.hasOwn(analysisStatus,a.status)&&Array.isArray(a.appliedSubjects)&&a.appliedSubjects.every(s=>Object.hasOwn(subjects,s))&&new Set(a.appliedSubjects).size===a.appliedSubjects.length&&nullable(a.assessment,v=>v&&nullable(v.user,o=>observation(o,'user'))&&nullable(v.companion,o=>observation(o,'companion')));
const ref=s=>s?`${s.id} · 版本 ${s.version}`:'暂无来源记录';
const value=v=>v===null?'未评估':String(v);
const observationLabel=o=>o?labels[o.label]?`${labels[o.label]}（${o.label}）`:o.label:'暂无情绪记录';
const key=m=>JSON.stringify([m.scope.characterId,m.scope.sessionId,m.scope.turnId,m.scope.generation,m.message.id,m.message.version]);
function observationView(o){return el('div',{class:'emotion-observation'},el('p',{class:'emotion-label'},observationLabel(o)),definition([['强度',o?value(o.intensity):'未评估'],['置信度',o?value(o.confidence):'未评估'],['来源',o?provenance[o.provenance]:'暂无来源记录']]),o&&el('details',{},el('summary',{},'来源引用'),o.sources.length?el('ul',{},o.sources.map(s=>el('li',{},ref(s)))):el('p',{class:'subtle'},'暂无来源引用')));}
function sustainedView(s,title){return el('section',{class:'card emotion-state','data-emotion-subject':s.subject},el('h3',{},title),observationView(s.observation),definition([['更新时间',s.updatedAt?time(s.updatedAt):'尚无更新时间']]),el('details',{},el('summary',{},'查看记录详情'),definition([['状态版本',s.revision],['依据消息',ref(s.sourceMessage)]])));}

export function createEmotionView(client,render,host){
 let data=null,identity=null,active=false,epoch=0,sequence=0,reading=null,offset=0,revision=-1,error='',stale=true;
 const visible=()=>host().page==='memory'&&host().section==='emotion'&&host().connection==='online'&&host().character==='companion'&&!document.hidden;
 function stop(){active=false;epoch++;sequence++;reading?.controller.abort();reading=null;stale=true;}
 function sync(){const h=host(),id=JSON.stringify([h.instanceId,h.authEpoch,h.character]);if(id!==identity){stop();identity=id;data=null;offset=0;revision=-1;error='';}if(!visible()){if(active)stop();return;}if(!active){active=true;queueMicrotask(()=>{if(active&&!reading)refresh();});}}
 function accept(v,requestedOffset){
  if(v?.instanceId!==host().instanceId||v.version!=='0.1.1'||v.characterId!=='companion'||!count(v.revision)||v.revision<revision||!count(v.pending)||!background(v)||!Array.isArray(v.messages)||!v.messages.every(message)||new Set(v.messages.map(key)).size!==v.messages.length||!Array.isArray(v.analyses)||!v.analyses.every(a=>analysis(a)&&v.messages.some(m=>key(m)===key(a)))||new Set(v.analyses.map(a=>a.id)).size!==v.analyses.length||!count(v.total)||v.offset!==requestedOffset||v.limit!==20||v.messages.length>20||v.total<v.messages.length||v.messages.length>0&&v.offset+v.messages.length>v.total)throw Error('Invalid emotion response');
  data=v;revision=v.revision;stale=false;error='';
 }
 async function refresh(next=offset){
  if(!active||!visible()||!count(next))return;offset=next;reading?.controller.abort();const t={epoch,sequence:++sequence,instance:host().instanceId,controller:new AbortController()};reading=t;stale=true;render();
  try{const v=await client.request(query('/api/emotion',{characterId:'companion',offset:next,limit:20}),{signal:t.controller.signal});if(reading!==t||t.epoch!==epoch||t.sequence!==sequence||t.instance!==host().instanceId||!visible())return;accept(v,next);}
  catch(e){if(reading===t&&e.name!=='AbortError'){stale=true;error='暂时无法核对情绪记录，请刷新重试。';if(e.status===401||e.status===403)host().onError({name:'Error',status:e.status});}}
  finally{if(reading===t){reading=null;render();}}
 }
 function history(m){return el('details',{class:'card emotion-message',id:'emotion-message-'+encodeURIComponent(key(m)),'data-emotion-message':m.message.id,'data-message-version':m.message.version},
  el('summary',{},m.role==='user'?'用户消息':'桌宠回复',' · ',time(m.recordedAt)),

  el('section',{class:'emotion-original','data-emotion-frozen':'true'},el('h3',{},'本轮观察'),m.observations.length?el('div',{class:'emotion-grid'},m.observations.map(o=>el('section',{},el('h4',{},subjects[o.subject]),observationView(o)))):el('p',{class:'subtle'},'当时没有可用观察。'),
   el('h3',{},'消息保存时的状态快照'),el('div',{class:'emotion-grid'},sustainedView(m.background.user,'当时的用户情绪'),sustainedView(m.background.companion,'当时的桌宠心情'))),
  el('details',{},el('summary',{},'查看记录详情'),definition([['消息',ref(m.message)],['会话',m.scope.sessionId],['轮次',m.scope.turnId]])));}
 function analysisView(a){return el('article',{class:'emotion-analysis','data-emotion-analysis':a.id},el('div',{class:'section-head'},el('h3',{},a.origin==='background'?'后台后续推测':'对话后续分析'),badge(analysisStatus[a.status],a.status==='applied'?'muted':'warning')),
  el('p',{class:'field-help'},'完成于 '+time(a.completedAt)),el('details',{},el('summary',{},'查看记录详情'),definition([['目标消息',ref(a.message)],['会话',a.scope.sessionId],['轮次',a.scope.turnId]])),
  el('div',{class:'emotion-grid'},['user','companion'].map(subject=>el('section',{},el('h4',{},subjects[subject]),a.status==='applied'&&a.appliedSubjects.includes(subject)?a.assessment?.[subject]?observationView(a.assessment[subject]):el('p',{class:'subtle'},'评估记录当前不可用。'):el('p',{class:'subtle'},'本次未更新此项。')))));
 }
 function view(){return el('div',{class:'emotion-page',id:'emotion-panel'},
  el('div',{class:'section-head'},el('div',{},el('h2',{},'当前情绪'),el('p',{class:'subtle'},'查看用户情绪、桌宠心情及消息记录。')),button(reading?'读取中…':'刷新情绪',()=>refresh(),{id:'emotion-refresh',disabled:!active||!!reading})),
  error&&notice(error,'warning'),data&&stale&&notice('以下为上次读取的记录，当前状态尚待核对。','warning'),
  data?el('div',{},el('div',{class:'emotion-grid',id:'emotion-current'},sustainedView(data.user,'用户当前情绪'),sustainedView(data.companion,'桌宠当前心情')),el('p',{class:'field-help'},'待处理分析：'+data.pending),el('details',{id:'emotion-snapshot-details'},el('summary',{},'查看读取版本'),el('p',{},'记录版本 '+data.revision)),
   el('h2',{},'每条消息的当时记录'),data.messages.length?data.messages.map(history):el('p',{class:'empty'},data.total?'这一页没有消息记录。':'暂无消息情绪记录。'),
   el('div',{class:'actions'},button('上一页',()=>refresh(Math.max(0,data.offset-20)),{id:'emotion-prev',disabled:!active||!!reading||stale||data.offset===0}),el('span',{id:'emotion-page-count'},data.messages.length?`${data.offset+1}–${data.offset+data.messages.length} / ${data.total}`:`0 / ${data.total}`),button('下一页',()=>refresh(data.offset+20),{id:'emotion-next',disabled:!active||!!reading||stale||data.offset+20>=data.total})),
   el('section',{class:'card',id:'emotion-analyses'},el('h2',{},'后续推测与分析'),el('p',{class:'subtle'},'单独记录后续分析的结果；消息当时的观察与状态保留在上方快照中。'),data.analyses.length?data.analyses.map(analysisView):el('p',{class:'empty'},'暂无后续分析记录。'))):notice(reading?'正在读取情绪记录…':'尚未读取情绪记录。'));
 }
 document.addEventListener('visibilitychange',()=>{sync();render();});window.addEventListener('pagehide',stop);window.addEventListener('pageshow',()=>{sync();render();});
 return{sync,refresh,view,dispose:stop};
}
