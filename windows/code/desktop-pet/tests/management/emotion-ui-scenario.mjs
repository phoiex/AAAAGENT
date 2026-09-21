import { createEmotionView } from '/emotion-view.mjs';
const at='2026-09-19T06:00:00Z', source={id:'synthetic-user',version:1}, scope={characterId:'companion',sessionId:'synthetic',turnId:'turn-1',generation:1};
const empty=subject=>({subject,revision:0,observation:null,updatedAt:null,sourceMessage:null,logicalOrder:null,sessionId:null});
const observation=(subject,label,intensity=null)=>({subject,label,intensity,confidence:null,provenance:subject==='user'?'user_explicit':'companion_inference',sources:[source]});
const sustained=(subject,label)=>({...empty(subject),revision:1,observation:observation(subject,label),updatedAt:at,sourceMessage:source,logicalOrder:1,sessionId:scope.sessionId});
let state={version:'0.1.1',instanceId:'synthetic',characterId:'companion',revision:0,pending:0,user:empty('user'),companion:empty('companion'),messages:[],analyses:[]},reads=0;
const checks=[],errors=[],host={page:'memory',section:'emotion',connection:'online',character:'companion',instanceId:'synthetic',authEpoch:1,onError:e=>errors.push(e.status)};
const root=document.getElementById('fixture'),text=selector=>document.querySelector(selector)?.textContent??'';
const assert=(value,reason)=>{if(!value)throw Error(reason);};
const client={async request(path,options={}){assert(!options.method||options.method==='GET','Unexpected mutation');const url=new URL(path,location.origin);assert(url.pathname==='/api/emotion','Wrong endpoint');reads++;const offset=Number(url.searchParams.get('offset'));return structuredClone({...state,messages:state.messages.slice(offset,offset+20),analyses:offset?[]:state.analyses,total:state.messages.length,offset,limit:20});}};
const render=()=>root.replaceChildren(view.view()),view=createEmotionView(client,render,()=>host);
const pause=()=>new Promise(r=>setTimeout(r,20));
const check=async(name,fn)=>{await fn();checks.push(name);};
try{
 render();view.sync();for(let i=0;i<100&&!document.querySelector('#emotion-current');i++)await pause();
 await check('empty states and null scores',async()=>{assert(text('#emotion-current').includes('暂无情绪记录')&&!text('#emotion-current').includes('中性'),'Invented initial state');assert(text('#emotion-current').includes('未评估'),'Null score missing');});
 await check('independent states and frozen snapshots',async()=>{
  state={...state,revision:1,user:sustained('user','sad'),companion:sustained('companion','calm')};state.messages=[{role:'user',message:source,scope,logicalOrder:1,recordedAt:at,observations:[observation('user','neutral',0)],background:{user:empty('user'),companion:empty('companion')}}];await view.refresh();
  assert(text('#emotion-current').includes('难过（sad）')&&text('#emotion-current').includes('平静（calm）'),'Subjects mixed');const frozen=text('[data-emotion-frozen]');
  state={...state,revision:2,user:sustained('user','happy'),analyses:[{id:'later',message:source,scope,completedAt:at,origin:'background',assessment:{user:observation('user','happy'),companion:observation('companion','NOT_APPLIED')},appliedSubjects:['user'],status:'applied'}]};await view.refresh();
  assert(text('[data-emotion-frozen]')===frozen,'Snapshot rewritten');assert(text('#emotion-analyses').includes('后台后续推测')&&!text('#emotion-analyses').includes('NOT_APPLIED'),'Unapplied result displayed');
 });
 await check('invalid response keeps verified state',async()=>{const good=structuredClone(state),before=text('#emotion-current');for(const patch of [{instanceId:'other'},{version:'old'},{revision:0},{user:{...state.user,observation:{...state.user.observation,confidence:-1}}}]){state={...good,...patch};await view.refresh();assert(text('#emotion-current')===before&&text('#emotion-panel').includes('当前状态尚待核对'),'Unverified state accepted');}state=good;await view.refresh();});
 await check('labels remain text',async()=>{state={...state,revision:3,companion:sustained('companion','<img src=x onerror=alert(1)>')};await view.refresh();assert(!root.querySelector('img')&&text('#emotion-current').includes('<img src=x'),'Label markup executed');});
 await check('pagination and hidden-section reads',async()=>{state.companion=sustained('companion','calm');state.messages=Array.from({length:21},(_,i)=>({...state.messages[0],message:{id:'synthetic-'+i,version:1},scope:{...scope,turnId:'turn-'+i}}));state.analyses=[];state.revision++;await view.refresh(20);assert(text('#emotion-page-count')==='21–21 / 21','Wrong page');const before=reads;host.section='overview';view.sync();await view.refresh();assert(reads===before,'Hidden fetch');host.section='emotion';view.sync();await pause();await view.refresh(0);});
 await check('no polling or mutations',async()=>{const before=reads;await new Promise(r=>setTimeout(r,200));assert(reads===before&&errors.length===0,'Unexpected requests');});
 document.getElementById('result').textContent=JSON.stringify({passed:checks.length,checks,errors});
}catch(error){document.getElementById('result').textContent=JSON.stringify({passed:checks.length,checks,error:error.message});}
document.getElementById('result').dataset.complete='true';
