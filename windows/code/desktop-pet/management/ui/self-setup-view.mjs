import {el,button,badge,notice,field,select,definition,time,slots} from './dom.mjs';
import {clone,changes,query} from './api.mjs';
import {providerForm} from './views.mjs';

const providers=[{value:'deepseek',label:'DeepSeek · 文本模型'},{value:'dashscope',label:'阿里云百炼 · 转写、多模态与 MiniMax'}];
const voiceModels=[{value:'MiniMax/speech-2.8-turbo',label:'MiniMax Turbo · 阿里云百炼'},{value:'MiniMax/speech-2.8-hd',label:'MiniMax HD · 阿里云百炼'}];
const phases={prepared:'等待确认云端创建',cloning:'正在创建试听',clone_ready:'试听已生成，尚未正式启用',activating:'正在正式启用',registered:'已登记，可选择',failed:'未完成',unknown:'结果待核实',cancelled:'已取消'};
const money=v=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:6}).format(v/1e6)+' 元';
const whole=v=>Number.isSafeInteger(v)&&v>=0;
const text=v=>typeof v==='string'&&v.length>0;
const safeErrors={version_conflict:'配置或任务已变化，请刷新核对后再操作。',invalid_request:'填写的信息不符合要求，请检查后再操作。',unavailable:'设置服务暂不可用，请稍后刷新。',source_changed:'参考音频已变化，请重新选择。',config_changed:'模型或凭据配置已变化，请重新准备音色。',configuration_changed:'模型或凭据配置已变化，请重新准备音色。',provider_not_enabled:'请先在百炼开通所选模型及声音复刻权限。',credential_unavailable:'对应服务的凭据不可用，请先保存 API Key。',provider_rejected:'云端未完成请求，请检查模型开通与配置。',transport_unknown:'云端结果待核实，请刷新；不会自动重复收费。',operation_unavailable:'当前音色操作不可用，请刷新核对。',invalid_reference:'参考音频不可用，请重新上传。',probe_unavailable:'本机音频校验暂不可用。',credential_missing:'请先保存对应服务的 API Key。',invalid_audio:'无法使用这份参考音频，请检查格式、时长和大小。'};
const validReference=r=>r&&text(r.id)&&['wav','mp3','m4a'].includes(r.format)&&whole(r.bytes)&&r.bytes<=20*1024*1024&&Number.isFinite(r.durationMs)&&r.durationMs>=10000&&r.durationMs<=300000&&text(r.sha256);
const validOperation=o=>o&&text(o.operationId)&&whole(o.revision)&&Object.hasOwn(phases,o.phase)&&text(o.referenceId)&&text(o.label)&&voiceModels.some(m=>m.value===o.targetModel)&&text(o.credentialRef)&&whole(o.configRevision)&&typeof o.text==='string'&&Number.isFinite(o.cloneUpperBoundMicros)&&o.cloneUpperBoundMicros>=0&&Number.isFinite(o.activationUpperBoundMicros)&&o.activationUpperBoundMicros>=0&&typeof o.demoAvailable==='boolean'&&typeof o.activationAvailable==='boolean';
const validSettings=s=>s&&whole(s.revision)&&whole(s.effectiveRevision)&&s.applyOn==='restart'&&s.saved?.providers&&s.effective?.providers&&s.saved.context&&Array.isArray(s.history);
function link(label,url){try{if(new URL(url).protocol==='https:')return el('a',{href:url,target:'_blank',rel:'noopener noreferrer'},label);}catch{}return el('span',{},label);}

// Offline decoding only: no microphone, AudioContext output or cloud connection.
export async function encodeSetupReference(file){
 if(!file||!file.size||file.size>20*1024*1024||! /\.(wav|mp3|m4a)$/i.test(file.name))throw Error('请选择不超过 20 MiB 的 WAV、MP3 或 M4A 文件。');
 const Offline=globalThis.OfflineAudioContext||globalThis.webkitOfflineAudioContext;
 if(!Offline)throw Error('此浏览器不支持本地音频处理，请换用支持的浏览器。');
 let decoded;try{decoded=await new Offline(1,1,24000).decodeAudioData(await file.arrayBuffer());}catch{throw Error('无法解码这份音频，请换用 WAV、MP3 或 M4A 文件。');}
 if(decoded.duration<10||decoded.duration>300)throw Error('参考音频须为 10 秒至 5 分钟。');
 const length=decoded.length,bytes=44+length*2;if(bytes>20*1024*1024)throw Error('转换后的音频超过 20 MiB，请缩短后再上传。');
 const buffer=new ArrayBuffer(bytes),v=new DataView(buffer),put=(offset,s)=>{for(let i=0;i<s.length;i++)v.setUint8(offset+i,s.charCodeAt(i));};
 put(0,'RIFF');v.setUint32(4,bytes-8,true);put(8,'WAVE');put(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,decoded.sampleRate,true);v.setUint32(28,decoded.sampleRate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);put(36,'data');v.setUint32(40,length*2,true);
 const channels=Array.from({length:decoded.numberOfChannels},(_,i)=>decoded.getChannelData(i));
 for(let i=0;i<length;i++){let sample=0;for(const channel of channels)sample+=channel[i]/channels.length;sample=Math.max(-1,Math.min(1,sample));v.setInt16(44+i*2,Math.round(sample*(sample<0?32768:32767)),true);}
 const array=new Uint8Array(buffer);let binary='';for(let i=0;i<array.length;i+=32768)binary+=String.fromCharCode(...array.subarray(i,i+32768));
 return{filename:file.name.replace(/\.(wav|mp3|m4a)$/i,'.wav'),audioBase64:btoa(binary)};
}

export function createSelfSetupView(client,render,host){
 let data=null,auth=null,epoch=0,active=false,reading=null,writing=null,timer=null,stale=true,error='',readError='',message='',composing=false,unavailable=false;
 let secret='',credentialProvider='deepseek',file=null,uploadId=null,form={referenceId:'',label:'',targetModel:voiceModels[0].value,credentialRef:'',text:''};
 let settingsDraft=null,settingsBase=null,settingsRevision=null,settingsConflict=false,sample=null,activationReady=false;
 const keyTests=new Map(),keyJobs=new Map();
 function clearKeyTests(){for(const job of keyJobs.values())job.controller.abort();keyJobs.clear();keyTests.clear();}
 const consent=new Set(),uncertain=new Set();
 const visible=()=>!!client.token&&host().connection!=='locked'&&data&&(data.mode==='first-run'||host().page==='models')&&!document.hidden;
 const redraw=()=>{if(!composing)render();};
 function clearSample(){if(sample){sample.node.pause();sample.node.removeAttribute('src');sample.node.load();URL.revokeObjectURL(sample.url);sample=null;}}
 function stop(){clearKeyTests();active=false;epoch++;clearTimeout(timer);reading?.controller.abort();reading=null;stale=true;secret='';file=null;uploadId=null;activationReady=false;consent.clear();composing=false;clearSample();}
 function sync(){const next=host().authEpoch;if(auth!==next){stop();auth=next;data=null;unavailable=false;settingsDraft=settingsBase=null;settingsConflict=false;uncertain.clear();error='';message='';}if(!visible()){if(active)stop();return;}if(!active){active=true;queueMicrotask(()=>active&&refresh());}}
 function accept(value){
  if(value?.apiVersion!==1||!text(value.instanceId)||!['first-run','runtime'].includes(value.mode)||!whole(value.credentialRevision)||!Array.isArray(value.credentials)||!value.credentials.every(c=>text(c.id)&&providers.some(p=>p.value===c.provider)&&['configured','missing','unavailable'].includes(c.status))||!validSettings(value.settings)||!Array.isArray(value.adapters)||!value.adapters.every(a=>text(a.id)&&providers.some(p=>p.value===a.provider)&&Array.isArray(a.models)&&Array.isArray(a.slots)&&Array.isArray(a.endpoints))||!Array.isArray(value.references)||!value.references.every(validReference)||!Array.isArray(value.operations)||!value.operations.every(validOperation)||!value.initialization||!Array.isArray(value.initialization.blockers)||!value.links)throw Error('Invalid setup snapshot');
  const changed=data&&data.instanceId!==value.instanceId;
  if(!changed&&data&&(value.credentialRevision<data.credentialRevision||value.settings.revision<data.settings.revision||value.operations.some(o=>{const old=data.operations.find(p=>p.operationId===o.operationId);return old&&o.revision<old.revision;})))throw Error('Stale setup snapshot');
  if(changed){clearKeyTests();epoch++;activationReady=false;secret='';file=null;uploadId=null;consent.clear();uncertain.clear();clearSample();if(settingsDraft)settingsConflict=true;message='设置服务已更新，请核对当前配置后继续。';}
  if(data&&(changed||value.settings.revision!==data.settings.revision||value.credentialRevision!==data.credentialRevision))consent.clear();
  if(!settingsDraft||!changes(settingsBase,settingsDraft).length){settingsDraft=clone(value.settings.saved);settingsBase=clone(value.settings.saved);settingsRevision=value.settings.revision;}else if(settingsRevision!==value.settings.revision)settingsConflict=true;
  data=value;stale=false;unavailable=false;host().onMode(value.mode);
 }
 async function refresh(){if(!client.token||reading||writing)return data;clearTimeout(timer);const t={epoch,auth:host().authEpoch,controller:new AbortController()};reading=t;
  try{const value=await client.request('/api/self-setup',{signal:t.controller.signal});if(reading===t&&t.auth===host().authEpoch&&t.epoch===epoch){accept(value);readError='';}return data;}
  catch(e){if(reading===t&&e.name!=='AbortError'){stale=true;if(e.status===404&&!data)unavailable=true;else readError='暂时无法核对自助设置状态，操作已停用，请刷新。';if(e.status===401||e.status===403)host().onError({name:'Error',status:e.status});}return null;}
  finally{if(reading===t){reading=null;redraw();if(active)timer=setTimeout(refresh,3000);}}
 }
 const ready=()=>data&&!stale&&!writing&&client.token&&visible();
 const getCredentials=provider=>(data?.credentials||[]).filter(c=>c.provider===provider);
 const validBindings=settings=>!data||Object.values(settings.providers).every(p=>data.credentials.some(c=>c.id===p.credentialRef&&c.provider===p.provider&&c.status==='configured'));
 function fail(e){stale=true;error=safeErrors[e.code]||'操作结果尚未确认，请刷新核对。不会自动重发收费请求。';if(e.status===401||e.status===403)host().onError({name:'Error',status:e.status});}
 async function mutate(path,body,acceptResult,{method='POST',cloudKey=null}={}){
  if(!ready())return;const t={epoch,instance:data.instanceId,auth:host().authEpoch};writing=t;reading?.controller.abort();reading=null;clearTimeout(timer);error='';message='';if(cloudKey)uncertain.add(cloudKey);render();
  try{const result=await client.request('/api/self-setup/'+path,{method,body:{...body,instanceId:t.instance}});if(t.epoch!==epoch||t.auth!==host().authEpoch||data?.instanceId!==t.instance)return;await acceptResult(result);if(cloudKey)uncertain.delete(cloudKey);}
  catch(e){if(t.epoch===epoch&&t.auth===host().authEpoch){fail(e);if(cloudKey&&e.status>=400&&e.status<500&&e.status!==408)uncertain.delete(cloudKey);}}
  finally{if(writing===t){writing=null;redraw();if(visible())await refresh();}}
 }
 async function testKey(c,operationId=crypto.randomUUID(),afterSave=false){
  if((!afterSave&&!ready())||!data||keyJobs.has(c.id))return;
  const t={epoch,instance:data.instanceId,auth:host().authEpoch,controller:new AbortController()};
  const current=()=>keyJobs.get(c.id)===t&&t.epoch===epoch&&t.auth===host().authEpoch&&t.instance===data?.instanceId;
  keyJobs.set(c.id,t);keyTests.delete(c.id);redraw();
  try{const r=await client.request('/api/self-setup/credentials/test',{method:'POST',signal:t.controller.signal,body:{instanceId:t.instance,provider:c.provider,credentialRef:c.id,operationId}});
   if(!current())return;
   if(r?.provider!==c.provider||r.credentialRef!==c.id||typeof r.ok!=='boolean'||r.scope!=='model-list-authentication'||(r.ok?r.error!==null:!text(r.error)))throw Error('Invalid test receipt');
   keyTests.set(c.id,{ok:r.ok,error:r.error});
  }catch(e){if(current()&&e.name!=='AbortError'){keyTests.set(c.id,{ok:false,error:'连接测试未完成。'});if(e.status===401||e.status===403)host().onError({name:'Error',status:e.status});}}
  finally{if(keyJobs.get(c.id)===t){keyJobs.delete(c.id);redraw();}}
 }
 function saveKey(){if(!ready())return;if(!secret.trim()){error='请填写 API Key 后保存。';render();return;}const key=secret.trim(),provider=credentialProvider,operationId=crypto.randomUUID();secret='';document.getElementById('setup-key').value='';return mutate('credentials',{provider,key,expectedRevision:data.credentialRevision,operationId},async r=>{if(r?.provider!==provider||!text(r.credentialRef)||!whole(r.revision))throw Error('Invalid credential receipt');message='API Key 已保存到本机，正在测试连接…';const savedEpoch=epoch;await testKey({id:r.credentialRef,provider},operationId,true);if(savedEpoch===epoch)message='API Key 已保存到本机。请在模型配置中手动选择；当前使用的凭据未改变。';});}
 async function upload(){if(!ready()||!file)return;const selected=file,t={epoch,instance:data.instanceId};writing=t;clearTimeout(timer);reading?.controller.abort();reading=null;error='';message='正在本机转换音频…';render();
  try{const audio=await encodeSetupReference(selected);if(t.epoch!==epoch||t.instance!==data?.instanceId)return;const operationId=uploadId||crypto.randomUUID();uploadId=operationId;
   const r=await client.request('/api/self-setup/reference',{method:'POST',body:{instanceId:t.instance,operationId,...audio}});if(t.epoch!==epoch||t.instance!==data?.instanceId)return;if(!validReference(r))throw Error('音频保存回执无法核对，请刷新。');form.referenceId=r.id;file=null;uploadId=null;message='参考音频已保存到本机，尚未发送到云端。';
  }catch(e){if(t.epoch===epoch){error=e.status?'音频保存结果尚未确认，请刷新核对。':e.message;}}
  finally{if(writing===t){writing=null;redraw();if(visible())await refresh();}}
 }
 function modelEdit(path,value){let target=settingsDraft;for(const key of path.slice(0,-1))target=target[key];target[path.at(-1)]=value;render();}
 function saveModels(){if(settingsConflict||!validBindings(settingsDraft))return;const revision=settingsRevision,saved=clone(settingsDraft);return mutate('settings',{expectedRevision:revision,settings:saved},r=>{if(!validSettings(r))throw Error('Invalid settings receipt');settingsDraft=clone(r.saved);settingsBase=clone(r.saved);settingsRevision=r.revision;settingsConflict=false;message='配置已保存，完成设置并重启后生效。';},{method:'PUT'});}
 function prepare(){if(!ready()||!form.label.trim()||!form.text.trim()||!data.references.some(r=>r.id===form.referenceId)||!getCredentials('dashscope').some(c=>c.id===form.credentialRef&&c.status==='configured'))return;
  return mutate('voice/prepare',{...form,label:form.label.trim(),configRevision:data.settings.revision},r=>{if(!validOperation(r)||r.phase!=='prepared')throw Error('Invalid preparation receipt');message='音色方案已准备，尚未调用云端。请查看费用后确认创建。';});
 }
 const opKey=o=>o.operationId+'/'+o.revision;
 function canConfirm(o){return ready()&&['prepared','clone_ready'].includes(o.phase)&&o.configRevision===data.settings.revision&&getCredentials('dashscope').some(c=>c.id===o.credentialRef&&c.status==='configured')&&!uncertain.has(opKey(o));}
 function confirm(o){const current=data?.operations.find(x=>x.operationId===o.operationId);if(!current||current.revision!==o.revision||!canConfirm(current)||!consent.has(opKey(o)))return;consent.delete(opKey(o));return mutate('voice/confirm',{operationId:o.operationId,expectedRevision:o.revision,costConsent:true},r=>{if(!validOperation(r)||r.operationId!==o.operationId||r.revision<=o.revision||!(o.phase==='prepared'?['cloning','clone_ready','failed','unknown']:['activating','registered','failed','unknown']).includes(r.phase))throw Error('Invalid voice receipt');message='云端操作已返回，请以最新音色状态为准。';},{cloudKey:opKey(o)});}
 function retry(o){const current=data?.operations.find(x=>x.operationId===o.operationId);if(!ready()||!current||current.revision!==o.revision||current.phase!=='failed'||current.retryAvailable!==true||uncertain.has(opKey(current)))return;
  return mutate('voice/retry',{operationId:o.operationId,expectedRevision:o.revision},r=>{if(!validOperation(r)||r.phase!=='prepared'||r.operationId===o.operationId)throw Error('Invalid retry receipt');message='新的音色方案已准备，未调用云端。请再次核对费用后确认。';});
 }
 async function loadSample(o,kind){if(!ready()||!(kind==='demo'?o.demoAvailable:o.activationAvailable))return;clearSample();const t={epoch,instance:data.instanceId};writing=t;clearTimeout(timer);render();
  try{const blob=await client.requestAudio(query('/api/self-setup/voice/sample',{instanceId:t.instance,operationId:o.operationId,kind}));if(t.epoch!==epoch||t.instance!==data?.instanceId)return;const url=URL.createObjectURL(blob),node=el('audio',{controls:true,preload:'none',src:url,'aria-label':o.label+'试听音频'});sample={url,node,label:o.label,operationId:o.operationId};message='音频已就绪，点击播放器后才会播放。';}
  catch(e){if(t.epoch===epoch)error='无法读取试听音频，请刷新核对。';}
  finally{if(writing===t){writing=null;redraw();if(active)timer=setTimeout(refresh,3000);}}
 }
 function finish(){if(!ready()||data.mode!=='first-run'||data.initialization.blockers.length||settingsConflict||changes(settingsBase,settingsDraft).length)return;return mutate('finish',{expectedRevision:data.settings.revision},r=>{if(r?.status!=='prepared'||r.requiresRestart!==true)throw Error('Invalid finish receipt');activationReady=true;message='初始化配置已准备好，尚未运行。本页不会自动启动，请按下方说明显式启用。';});}
 function modelHelp(){return el('p',{class:'field-help'},'请先在阿里云百炼开通所选模型及调用权限。连接测试仅验证模型目录接口；具体模型仍需开通。 ',link('百炼控制台',data?.links.dashscopeConsole),' · ',link('API Key 管理',data?.links.dashscopeKeys));}
 function keyView(){return el('section',{class:'card'},el('h2',{},'保存 API Key'),el('p',{class:'field-help'},'文本模型使用 DeepSeek；语音转写、多模态与 MiniMax 使用阿里云百炼。Key 只保存在本机，不在页面回显。保存后自动测试一次连接；测试不生成内容。'),modelHelp(),
  el('form',{onSubmit:e=>{e.preventDefault();saveKey();}},el('div',{class:'form-grid'},select('供应商','setup-provider',credentialProvider,providers,v=>{credentialProvider=v;secret='';render();},{disabled:!!writing}),field('API Key','setup-key',secret,v=>{secret=v;},{type:'password',maxLength:4096,autocomplete:'new-password',spellcheck:false,disabled:!!writing})),el('div',{class:'actions'},el('button',{id:'setup-key-save',type:'submit',disabled:!ready()},'保存到本机'))),
  el('p',{class:'field-help'},link('DeepSeek Key 管理',data?.links.deepseekKeys)),data?.credentials.map(c=>el('div',{'data-credential':c.id},el('p',{class:'subtle'},providers.find(p=>p.value===c.provider)?.label,' · ',c.label,' · ',c.status==='configured'?'已保存':'尚未配置'),
   button(keyJobs.has(c.id)?'正在测试…':'测试连接',()=>testKey(c),{'data-key-test':c.id,disabled:!ready()||c.status!=='configured'||keyJobs.has(c.id)}),
   keyTests.has(c.id)&&el('p',{'data-key-result':c.id,role:'status',class:keyTests.get(c.id).ok?'subtle':'notice warning'},keyTests.get(c.id).ok?'连接测试通过':keyTests.get(c.id).error))));
 }
 function firstModels(){const a={s:{snapshot:{settings:data.settings,adapters:data.adapters,credentials:data.credentials},settingsDraft,connection:ready()?'online':'offline',pending:new Set(writing?['settings']:[]),setupFirstRun:true},selfSetup:api,editSetting:modelEdit,render};
  return el('section',{class:'card'},el('h2',{},'选择模型与音色'),modelHelp(),el('p',{class:'field-help'},'先保存对应服务的 Key，再选择已适配模型。保存不会发起模型调用，完成初始化并重启后生效。'),
   Object.keys(settingsDraft.providers).map(slot=>el('details',{id:'setup-slot-'+slot},el('summary',{},slots[slot]||slot,' · ',settingsDraft.providers[slot].model),providerForm(a,slot,slots[slot]||slot))),
   settingsConflict&&notice('配置版本已变化。草稿已保留，请核对最新配置后再保存。','warning'),settingsConflict&&button('读取最新配置，放弃本页模型修改',()=>{settingsDraft=clone(data.settings.saved);settingsBase=clone(data.settings.saved);settingsRevision=data.settings.revision;settingsConflict=false;render();},{id:'setup-model-review',disabled:!ready()}),
   button('保存模型配置，重启后生效',saveModels,{id:'setup-model-save',disabled:!ready()||settingsConflict||!validBindings(settingsDraft)}));
 }
 function voiceView(){return el('section',{class:'card'},el('h2',{},'创建自己的音色 · 阿里云百炼'),modelHelp(),
  el('p',{class:'field-help'},'参考音频为 WAV、MP3 或 M4A，10 秒至 5 分钟，不超过 20 MiB。上传前仅在本机转换为单声道 WAV，原文件不改动。'),
  el('label',{class:'field'},el('span',{},'选择自己的参考音频'),el('input',{type:'file',id:'setup-audio',accept:'.wav,.mp3,.m4a',disabled:!!writing,onChange:e=>{file=e.target.files?.[0]||null;uploadId=null;error='';render();}})),file&&el('p',{class:'subtle'},'已选择：'+file.name),
  button('仅上传到本机',upload,{id:'setup-upload',disabled:!ready()||!file}),el('p',{class:'field-help'},link('支持的音频与音色复刻说明',data?.links.voiceClone)),
  el('div',{class:'form-grid'},select('已保存的参考音频','setup-reference',form.referenceId,[{value:'',label:'请选择'},...(data?.references||[]).map((r,i)=>({value:r.id,label:`参考 ${i+1} · ${(r.durationMs/1000).toFixed(1)} 秒 · ${(r.bytes/1024/1024).toFixed(2)} MiB`}))],v=>{form.referenceId=v;render();},{disabled:!!writing}),
   field('音色名称','setup-voice-label',form.label,v=>{form.label=v;redraw();},{maxLength:80,disabled:!!writing,onCompositionStart:()=>{composing=true;},onCompositionEnd:()=>{composing=false;render();}}),select('音色模型','setup-voice-model',form.targetModel,voiceModels,v=>{form.targetModel=v;render();},{disabled:!!writing}),
   select('百炼凭据','setup-voice-credential',form.credentialRef,[{value:'',label:'请选择百炼凭据'},...getCredentials('dashscope').map(c=>({value:c.id,label:c.label,disabled:c.status!=='configured'}))],v=>{form.credentialRef=v;render();},{disabled:!!writing}),
   field('试听文本','setup-voice-text',form.text,v=>{form.text=v;redraw();},{type:'textarea',maxLength:300,disabled:!!writing,onCompositionStart:()=>{composing=true;},onCompositionEnd:()=>{composing=false;render();}})),
  el('p',{class:'field-help'},'云端创建会生成收费试听：Turbo 2 元 / 万字符，HD 3.5 元 / 万字符。首次正式启用克隆音色另收 9.9 元及合成字符费。 ',link('查看官方费用',data?.links.voicePricing)),
  button('准备音色方案（不调用云端）',prepare,{id:'setup-voice-prepare',disabled:!ready()||!form.referenceId||!form.label.trim()||!form.text.trim()||!form.credentialRef}),
  ...(data?.operations||[]).map(operationView),sample&&el('div',{class:'setup-sample',id:'setup-sample'},el('p',{},sample.label+' · 手动试听'),sample.node));
 }
 function operationView(o){const key=opKey(o),next=o.phase==='prepared'?'创建收费试听':'正式启用并登记音色';return el('article',{class:'setup-operation','data-setup-operation':o.operationId},el('div',{class:'section-head'},el('h3',{},o.label),badge(phases[o.phase],o.phase==='registered'?'success':['failed','unknown'].includes(o.phase)?'warning':'muted')),
  el('p',{class:'subtle'},o.targetModel+' · 阿里云百炼'),el('p',{class:'field-help'},'试听文本：'+o.text),
  definition([['创建试听上限',money(o.cloneUpperBoundMicros)],['正式启用上限',money(o.activationUpperBoundMicros)]]),
  (o.phase==='unknown'||uncertain.has(key))&&notice('结果尚未确认，已停用重复收费操作。请刷新核对，勿重复创建。','warning'),o.phase==='failed'&&notice((safeErrors[o.errorCode]||'本次未完成，请核对模型开通、凭据和参考音频。')+' 页面不会自动重试。','warning'),
  o.configRevision!==data.settings.revision&&['prepared','clone_ready'].includes(o.phase)&&notice('模型配置已变化，此方案不可继续提交，请重新准备。','warning'),
  ['prepared','clone_ready'].includes(o.phase)&&el('div',{},el('p',{class:'field-help'},o.phase==='prepared'?'确认后参考音频将发往阿里云百炼，生成试听也会计费。':'确认后执行首次正式合成，收取 9.9 元及字符费；登记成功后仍需手动选择音色并保存配置。'),
   el('label',{class:'setup-consent'},el('input',{type:'checkbox',id:'setup-consent-'+o.operationId,checked:consent.has(key),disabled:!canConfirm(o),onChange:e=>{if(e.target.checked)consent.add(key);else consent.delete(key);render();}}),el('span',{},'我同意本次操作及所示费用上限')),button(next,()=>confirm(o),{'data-setup-confirm':o.operationId,disabled:!canConfirm(o)||!consent.has(key)})),
  o.phase==='registered'&&notice('音色已登记。请在模型配置中选择对应模型与音色，保存并重启后使用。'),
  el('div',{class:'actions'},o.phase==='failed'&&o.retryAvailable===true&&button('已处理开通问题，准备重试',()=>retry(o),{'data-setup-retry':o.operationId,disabled:!ready()||uncertain.has(key)}),o.demoAvailable&&button('加载试听音频',()=>loadSample(o,'demo'),{'data-setup-sample':o.operationId,disabled:!ready()}),o.activationAvailable&&button('加载正式样音',()=>loadSample(o,'activation'),{disabled:!ready()}),['prepared','clone_ready'].includes(o.phase)&&button('取消此方案',()=>mutate('voice/cancel',{operationId:o.operationId},r=>{if(!validOperation(r))throw Error('Invalid cancel receipt');message='方案状态已更新。';}),{'data-setup-cancel':o.operationId,disabled:!ready()})),el('p',{class:'field-help'},'更新于 '+time(o.updatedAt)));
 }
 function view(){if(unavailable)return el('div');return el('div',{class:'self-setup',id:'self-setup'},
  el('div',{class:'section-head'},el('h2',{},data?.mode==='first-run'?'首次设置':'API Key 与自定义音色'),button('刷新设置状态',refresh,{id:'setup-refresh',disabled:!!reading||!!writing||!client.token})),readError&&notice(readError,'warning'),error&&notice(error,'warning'),message&&notice(message),
  !data?notice('正在读取本机设置入口…'):el('div',{},keyView(),data.mode==='first-run'&&firstModels(),voiceView(),data.mode==='first-run'&&el('section',{class:'card'},el('h2',{},'完成初始化'),
   data.initialization.blockers.length?el('div',{},notice('以下项目完成后才能准备启动：'),el('ul',{},data.initialization.blockers.map(b=>el('li',{},b)))):el('p',{},'初始化条件已满足。准备配置后，请重新启动桌宠。'),
   button('完成设置，准备重启',finish,{id:'setup-finish',disabled:!ready()||!!data.initialization.blockers.length||settingsConflict||!!changes(settingsBase,settingsDraft).length}),(activationReady||data.initialization.completed)&&el('div',{class:'notice'},el('p',{},'在安装目录的终端中执行以下命令，随后使用原启动入口：'),el('code',{},'npm run configure-local -- --activate-existing')),el('p',{class:'field-help'},'工程任务需要另外安装并登录执行器：',link('DeepSeek Harness',data.links.harness),' · ',link('Codex',data.links.codex),'。未安装时，对应任务转发不可用。'))));
 }
 const api={sync,refresh,view,modelHelp,getCredentials,validBindings,getAdapters:()=>data?.adapters,available:()=>!!data,mode:()=>data?.mode,isComposing:()=>composing&&visible(),dispose:stop};
 document.addEventListener('visibilitychange',()=>{sync();redraw();});window.addEventListener('pagehide',stop);window.addEventListener('pageshow',()=>{sync();redraw();});
 return api;
}
