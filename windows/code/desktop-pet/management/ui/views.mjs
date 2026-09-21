import {el,button,badge,notice,card,field,select,definition,time,statuses,slots,kinds} from './dom.mjs';
import {changes,providerChoice} from './api.mjs';
const options=map=>Object.entries(map).map(([value,label])=>({value,label}));
const canSave=a=>a.s.connection==='online';
const moduleDetail=m=>m.id==='invitations'?'暂未开放':m.detail;
const tone=status=>['error','unavailable'].includes(status)?'error':status==='ready'?'success':'muted';
const versionStrip=settings=>el('div',{class:'version-strip'},el('div',{},el('span',{},'当前运行配置'),el('strong',{},'版本 '+settings.effectiveRevision)),el('div',{},el('span',{},'最近保存配置'),el('strong',{},'版本 '+settings.revision)),el('div',{},el('span',{},'生效方式'),el('strong',{},settings.pending?'等待重启':'已生效')));
const block=text=>el('div',{class:'text-block'},text||'（空）');
export function overviewView(a) {
  const {s}=a,snap=s.snapshot;
  const runtime=el('details',{class:'instance-details'},el('summary',{},'实例详情 · '+(snap.characters.find(c=>c.id===snap.runtime.characterId)?.label||snap.runtime.characterId)),
    definition([['来源版本',snap.runtime.sourceRevision],['进程',snap.runtime.pid],['启动时间',time(snap.runtime.startedAt)],['实例标识',snap.runtime.instanceId]]));
  const modules=el('div',{class:'grid module-grid'},[...snap.modules].sort((a,b)=>{const rank=m=>m.providerSlot==='dialogue'?0:m.id==='asr'?1:m.providerSlot==='perception'?2:m.providerSlot==='tts'?3:m.id==='retrieval'?4:5;return rank(a)-rank(b)}).map(m=>card(
    el('div',{class:'card-title'},m.label,badge(statuses[m.status]||m.status,m.id==='invitations'?'muted':tone(m.status))),
    m.providerSlot?el('p',{class:'model-name'},snap.settings.effective.providers[m.providerSlot]?.model):el('p',{},moduleDetail(m)),
    m.sharedWith&&el('p',{class:'subtle'},'与 '+(snap.modules.find(x=>x.id===m.sharedWith)?.label||m.sharedWith)+' 共用配置'),
    el('p',{class:'subtle'},`处理中 ${m.activeJobs} · 调用 ${m.calls} 次 · 最近 ${m.lastElapsedMs===null?'未观测':m.lastElapsedMs+' ms'}`),
    el('details',{},el('summary',{},'运行详情'),el('p',{},moduleDetail(m)),el('small',{},'最近观测：'+time(m.lastObservedAt)),m.lastError&&notice(m.lastError,'error')),
    m.providerSlot&&button('配置',()=>{s.providerSlot=m.providerSlot;a.selectPage('models')}))));
  return el('div',{},versionStrip(snap.settings),a.balances.view(),
    snap.modules.filter(m=>m.status==='error'||(m.status==='unavailable'&&m.id!=='invitations')).map(m=>notice(m.label+'：'+(m.lastError||m.detail),'error')),
    runtime,el('h2',{class:'section-gap'},'当前模块'),modules,el('div',{class:'section-gap'},contextSettings(a)));
}
function settingsNotices(a){const {s}=a;const items=[];
 if(s.settingsConflict){const edited=changes(s.settingsBase,s.settingsDraft);items.push(notice('配置版本已变化。本页修改尚未保存；请比较下方差异，再决定是否保留自己的修改。','warning'),el('div',{class:'tablescroll'},el('table',{},el('thead',{},el('tr',{},el('th',{},'修改项'),el('th',{},'本页草稿'),el('th',{},'最新已保存'))),el('tbody',{},edited.map(c=>el('tr',{},el('td',{},c.path.join(' / ')),el('td',{},String(c.after??'未设置')),el('td',{},String(c.path.reduce((v,k)=>v?.[k],s.settingsLatest?.saved)??'未设置'))))))),button('核对后保留我的修改',a.reviewSettings,{id:'settings-review',disabled:!s.settingsLatest||s.pending.has('settings')}));}
 return items;
}
function settingsActions(a){return el('div',{class:'actions'},button(a.s.pending.has('settings')?'正在保存…':'保存配置，重启后生效',a.saveSettings,{id:'settings-save',class:'primary',disabled:!canSave(a)||a.selfSetup?.available()&&!a.selfSetup.validBindings(a.s.settingsDraft)||a.s.settingsConflict||a.s.pending.has('settings')}));}
function contextSettings(a){const {s}=a,c=s.settingsDraft?.context;if(!c)return el('div');const labels={maxRecentMessages:'近期对话条数',maxMemories:'长期记忆条数',summaryLimit:'选入上下文的摘要条数',summaryMinMessages:'开始生成摘要的消息数',summaryMaxMessages:'单次摘要消息数',timeoutMs:'模型请求超时（毫秒）'};
 return card('检索与上下文配置',el('p',{class:'subtle'},'控制各类内容的选取范围；不修改已有记录正文。'),...settingsNotices(a),el('div',{class:'form-grid'},Object.entries(labels).map(([key,label])=>field(label,'context-'+key,c[key],v=>a.editSetting(['context',key],Number(v)),{type:'number',min:0,step:1,disabled:s.pending.has('settings')}))),settingsActions(a));
}
export function memoryView(a) {
  const {s}=a;
  const tabs=[['dynamics','记忆总览'],['emotion','当前情绪'],['import','导入旧聊天'],['fragments','来源与片段'],['traces','实际召回'],['policy','策略微调'],['maintenance','维护与遗忘'],['records','纠正记录'],['prompt','角色设定 Prompt'],['context','上下文试算']];
  return el('div',{},
    el('div',{class:'tab-actions md-tabs'},tabs.map(([key,label])=>button(label,()=>{s.section=key;a.render();const load=({records:a.loadRecords,prompt:a.loadPrompt,context:a.loadContext,import:a.memoryImport.refresh,emotion:()=>a.emotion.refresh()})[key];if(load)load();else a.memoryDynamics.load(key);},{id:'memory-'+key,'aria-pressed':s.section===key}))),
    s.section==='emotion'?a.emotion.view():s.section==='import'?a.memoryImport.view():s.section==='records'?recordsView(a):s.section==='prompt'?promptView(a):s.section==='context'?contextView(a):a.memoryDynamics.view(s.section));
}
function recordsView(a){const {s}=a;
 const queryForm=el('form',{class:'card searchbar',onSubmit:e=>{e.preventDefault();s.offset=0;a.loadRecords()}},el('div',{class:'form-grid'},select('记录类型','record-kind',s.kind,options(kinds),v=>{s.kind=v;s.offset=0;s.pageData=s.selected=null;a.loadRecords()}),field('搜索记录正文','record-query',s.query,v=>s.query=v,{placeholder:'输入关键词'}),select('记录状态','record-state',s.recordState,[{value:'active',label:'仅有效记录'},{value:'all',label:'全部状态'}],v=>{s.recordState=v;s.offset=0;a.loadRecords()})),el('div',{class:'actions'},el('button',{class:'primary',type:'submit',id:'record-search',disabled:s.pending.has('records')},s.pending.has('records')?'查询中…':'查询')));
 const data=s.pageData;
 const list=card(data?`${kinds[s.kind]} · ${data.total} 条`:'记录列表',data?el('div',{class:'record-list'},data.records.length?data.records.map(r=>button(el('div',{},el('div',{class:'record-meta'},badge(statuses[r.state]||r.state),r.role?el('span',{},({user:'用户',assistant:'角色'})[r.role]):'',el('span',{},`版本 ${r.version}`),el('span',{},time(r.createdAt))),el('p',{},r.text)),()=>a.selectRecord(r),{class:'record-row','aria-pressed':s.selected?.id===r.id,'data-record-id':r.id})):el('p',{class:'empty'},'没有符合条件的记录。')):el('p',{class:'empty'},'查询后查看该角色的记录。'),data&&el('div',{class:'actions'},button('上一页',()=>{s.offset=Math.max(0,s.offset-25);a.loadRecords()},{disabled:s.offset===0||s.pending.has('records')}),el('small',{},`${data.total?data.offset+1:0}–${Math.min(data.offset+data.records.length,data.total)} / ${data.total}`),button('下一页',()=>{s.offset+=25;a.loadRecords()},{disabled:data.offset+data.records.length>=data.total||s.pending.has('records')})));
 return el('div',{},queryForm,el('div',{class:'split'},list,recordEditor(a)));
}
function recordEditor(a){const {s}=a,r=s.selected,d=a.currentDraft();if(!r||!d)return card('查看与编辑',el('p',{class:'empty'},'从左侧选择一条记录。'));
 const pending=s.pending.has('edit/'+r.characterId+'/'+r.kind+'/'+r.id);
 const panel=card(kinds[r.kind]+'详情',definition([['记录标识',r.id],['版本',d.version],['状态',statuses[r.state]||r.state],['来源',({manual:'手动更新',automatic:'自动维护',conversation:'对话'})[r.origin]],['关联来源',r.sources.length?r.sources.map(x=>x.id+' · v'+x.version).join('\n'):'无来源引用']]));
 if(d.conflict)panel.append(notice('记录已被更新，你的修改尚未保存。请读取最新记录并核对；本页草稿已保留。','warning'),el('div',{class:'conflict-comparison'},el('div',{},el('h3',{},'本页草稿'),block(d.text)),el('div',{},el('h3',{},'最近读到的记录 · v'+d.latest.version),block(d.latest.text))),button('读取最新列表',a.loadRecords,{id:'record-reload',disabled:s.pending.has('records')}),button('已核对，保留我的草稿',a.reviewRecord,{id:'record-review',disabled:pending||!d.latest?.editable}));
 if(r.editable){panel.append(field('记录正文','record-text',d.text,v=>{d.text=v;d.operationId=crypto.randomUUID()},{type:'textarea',disabled:pending}),field('修改原因','record-reason',d.reason,v=>{d.reason=v;d.operationId=crypto.randomUUID()},{placeholder:'说明需要纠正的内容',disabled:pending}),el('div',{class:'actions'},button(pending?'正在保存…':'保存这条记录',a.saveRecord,{id:'record-save',class:'primary',disabled:!canSave(a)||pending||d.conflict}),el('small',{},'保存后，后续对话会使用纠正后的内容。')))}else panel.append(notice('这类内容暂不能直接编辑，请修改对应的对话或记忆。'),block(r.text));return panel;
}
function promptView(a){const {s}=a,d=s.prompts.get(s.character),pending=s.pending.has('prompt-save/'+s.character);
 const panel=card('角色设定 Prompt',el('p',{class:'subtle'},'这是青梅竹马的虚构角色设定，不代表真实用户事实。修改后后续上下文使用新设定。'),button('读取最新设定',a.loadPrompt,{id:'prompt-refresh',disabled:s.pending.has('prompt')}));
 if(!d)return el('div',{},panel,notice(s.pending.has('prompt')?'正在读取角色设定…':'尚未读取角色设定。'));
 if(d.conflict)panel.append(notice('设定已在其他位置变化，草稿已保留。请先读取最新设定并核对。','warning'),el('div',{class:'conflict-comparison'},el('div',{},el('h3',{},'本页草稿'),block(d.text)),el('div',{},el('h3',{},'最近读到的设定'),block(d.latest?.text))),button('已核对，保留本页设定',a.reviewPrompt,{id:'prompt-review',disabled:!d.latest||pending}));
 panel.append(el('p',{class:'subtle section-gap'},'编辑基于版本 '+d.version),field('角色设定内容','prompt-text',d.text,v=>{d.text=v;d.operationId=crypto.randomUUID()},{type:'textarea',rows:12,disabled:pending}),el('div',{class:'actions'},button(pending?'正在保存…':'保存角色设定',a.savePrompt,{id:'prompt-save',class:'primary',disabled:!canSave(a)||pending||d.conflict})));return panel;
}
function contextView(a){const {s}=a,c=s.context;const form=el('form',{class:'card',onSubmit:e=>{e.preventDefault();a.loadContext()}},el('h2',{},'当前上下文试算 · 非实际历史'),field('试算检索问题','context-query',s.contextQuery,v=>s.contextQuery=v,{placeholder:'例如：下周有什么安排？'}),el('div',{class:'actions'},el('button',{type:'submit',class:'primary',disabled:s.pending.has('context')},s.pending.has('context')?'读取中…':'试算当前上下文')),el('small',{},'按当前数据重新组装，不是历史实际使用记录；不向模型发起对话。历史请查看“实际召回”。'));
 if(!c)return form;
 return el('div',{},form,notice(c.note||'以下为当前角色的上下文查询结果。'),card('角色设定',block(c.prompt)),[['近期对话',c.recent],['会话摘要',c.summaries],['相关长期记忆',c.memories]].map(([title,records])=>card(title+' · '+records.length,records.length?records.map(r=>el('div',{},el('small',{},r.id+' · v'+r.version+' · '+time(r.createdAt)+' · 来源：'+(({manual:'人工编辑',automatic:'自动维护',conversation:'对话'})[r.origin]||'未知')),block(r.text))):el('p',{class:'empty'},'本次没有选入记录。'))));
}
export function modelsView(a) {
  const {s}=a,settings=s.snapshot.settings;
  const primary=[['dialogue','对话大模型'],...(settings.effective.providers.asr?[['asr','语音转写']]:[]),['perception','视频情绪'],['tts','语音合成 TTS']];
  const summaries=el('div',{class:'grid primary-models'},primary.map(([slot,label])=>{
    const active=settings.effective.providers[slot],saved=settings.saved.providers[slot];
    return card(label,badge('当前生效','success'),el('p',{class:'model-name'},active.model),el('small',{},active.provider+' · '+active.adapterId),
      active.voice&&el('p',{},'音色：'+active.voice),

      changes(active,saved).length>0&&el('p',{class:'subtle'},'已保存待重启：'+saved.model+(saved.voice?' · '+saved.voice:'')),
      button('编辑配置',()=>{s.providerSlot=slot;a.render()},{id:'configure-'+slot,'aria-expanded':s.providerSlot===slot}));
  }));
  const background=el('details',{class:'card'},el('summary',{},'后台模块配置 · 记忆维护、摘要、轮次判断'),
    ['memory_turn','summary','admission'].map(slot=>el('div',{class:'label-row section-gap'},el('span',{},slots[slot]+' · '+settings.effective.providers[slot].model),button('编辑配置',()=>{s.providerSlot=slot;a.render()},{id:'configure-'+slot}))));
  const editor=s.providerSlot?el('div',{},el('div',{class:'label-row section-gap'},el('h2',{},'编辑：'+slots[s.providerSlot]),button('收起配置',()=>{s.providerSlot=null;a.render()})),providerForm(a,s.providerSlot,slots[s.providerSlot])):null;
  const history=el('details',{class:'card'},el('summary',{},'配置历史与回滚'),el('p',{class:'subtle section-gap'},'回滚保存为新的配置版本，重启后生效。回滚会替换当前表单草稿，请先核对。'),
    settings.history.length?el('div',{class:'record-list'},settings.history.map(h=>el('div',{class:'label-row'},el('span',{},`版本 ${h.revision} · ${time(h.savedAt)}`),button('回滚到此版本',()=>a.rollbackSettings(h.revision),{'data-target-revision':h.revision,disabled:!canSave(a)||s.settingsConflict||s.pending.has('settings')||h.revision===settings.revision})))):el('p',{class:'empty'},'暂时没有可回滚的保存版本。'));
  return el('div',{},a.wake?.view(),a.selfSetup?.view(),versionStrip(settings),a.selfSetup?.available()&&a.selfSetup.modelHelp(),summaries,
    el('p',{class:'subtle section-gap'},settings.pending?'版本已保存，重启后生效；当前运行仍使用上方有效配置。':'表单修改需保存并重启后才生效。'),
    ...settingsNotices(a),editor,el('div',{class:'savebar'},settingsActions(a)),background,history);
}
export function providerForm(a,slot,label){const {s}=a,current=s.snapshot.settings.effective.providers[slot],draft=s.settingsDraft.providers[slot],available=(a.selfSetup?.getAdapters()||s.snapshot.adapters).filter(x=>x.slots.includes(slot)),adapter=available.find(x=>x.id===draft.adapterId),busy=s.pending.has('settings');
 const update=(key,value)=>a.editSetting(['providers',slot,key],value);
 const choose=(next,model)=>{const configured=providerChoice(draft,next,model);if(configured)a.editSetting(['providers',slot],configured);else{if(next.provider!==draft.provider)update('credentialRef','');update('adapterId',next.id);update('provider',next.provider);update('model',model);update('endpoint',next.endpoints[0]||'');}a.render();};
 const choice=adapter?.choices?.find(c=>c.configuration.model===draft.model);
 const panel=card(label,!s.setupFirstRun&&el('div',{class:'config-summary'},el('small',{},'当前实际生效'),el('p',{},`${current.provider} / ${current.model}${current.voice?' · 音色 '+current.voice:''}`),el('small',{},'适配：'+current.adapterId)),el('p',{class:'subtle'},s.setupFirstRun?'初始化配置尚未运行。请选择模型及对应服务的凭据。':'下面是准备保存的配置；当前运行实例不会随表单变化。'));
 const adapters=available.map(x=>({value:x.id,label:x.label+(x.status==='not_integrated'?'（尚未接入）':''),disabled:x.status!=='available'}));if(!adapters.some(x=>x.value===draft.adapterId))adapters.push({value:draft.adapterId,label:draft.adapterId+'（当前配置）',disabled:true});
 const models=(adapter?.models||[]).map(m=>({value:m,label:adapter?.choices?.find(c=>c.configuration.model===m)?.label||m}));if(!models.some(x=>x.value===draft.model))models.push({value:draft.model,label:draft.model+'（未在当前支持列表）',disabled:true});
 panel.id='provider-'+slot;
 const credentials=a.selfSetup?.available()?a.selfSetup.getCredentials(draft.provider):s.snapshot.credentials;
 const credentialOptions=[{value:'',label:'请选择此服务的凭据引用'},...credentials.map(c=>({value:c.id,label:`${c.label} · ${statuses[c.status]||c.status}`,disabled:c.status!=='configured'}))];
 if(draft.credentialRef&&!credentialOptions.some(c=>c.value===draft.credentialRef))credentialOptions.push({value:draft.credentialRef,label:'当前引用不属于此供应商，请重新选择',disabled:true});
 const grid=el('div',{class:'form-grid'},select('服务商','adapter-'+slot,draft.adapterId,adapters,v=>{const next=available.find(x=>x.id===v);choose(next,next.models[0]||'')},{disabled:busy}),select('型号','model-'+slot,draft.model,models,v=>choose(adapter,v),{disabled:busy}),select('服务地址','endpoint-'+slot,draft.endpoint,(adapter?.endpoints||[draft.endpoint]).map(v=>({value:v,label:v})),v=>update('endpoint',v),{disabled:busy}),select('凭据引用','credential-'+slot,draft.credentialRef,credentialOptions,v=>update('credentialRef',v),{disabled:busy}),slot!=='asr'&&field('上下文输入上界','input-limit-'+slot,draft.inputTokenLimit,v=>update('inputTokenLimit',Number(v)),{type:'number',min:1,step:1,disabled:busy}));
 if(slot==='tts'&&adapter?.capabilities.voice&&(choice?.voices?.length||a.selfSetup?.available()))grid.append(select('已登记音色','voice-'+slot,draft.voice||'',[{value:'',label:'请选择已登记音色'},...(choice?.voices||[]).map(v=>({value:v.id,label:v.label}))],v=>update('voice',v),{disabled:busy}));
 else if(slot==='tts'&&adapter?.capabilities.voice)grid.append(field('音色标识','voice-'+slot,draft.voice,v=>update('voice',v),{disabled:busy,hint:'填写已登记的音色标识。'}));
 if(slot==='tts'&&adapter?.capabilities.language)grid.append(field('语言','language-'+slot,draft.language,v=>update('language',v),{disabled:busy}));
 if(slot==='dialogue'&&adapter?.capabilities.temperature)grid.append(field('温度','temperature-'+slot,draft.temperature,v=>update('temperature',v===''?undefined:Number(v)),{type:'number',min:0,max:2,step:.1,disabled:busy,hint:'控制实际对话请求的随机性。'}));
 panel.append(grid,el('div',{class:'provider-support'},adapter?.status==='not_integrated'&&notice('此服务暂未开放。','warning'),adapter&&el('p',{class:'subtle'},'支持范围：'+([adapter.capabilities.instructions?'表达指令':null,adapter.capabilities.voice?'选择音色':null,adapter.capabilities.cloning?'克隆音色能力':null,adapter.capabilities.language?'语言选择':null,adapter.capabilities.temperature?'温度':null].filter(Boolean).join('、')||'基础功能'))),
 el('details',{},el('summary',{},'用量与费用详情（只读）'),definition([['输出计费范围',current.outputTokenLimit+' token；不代表回复硬截断'],['单次预留',current.reservationMicros+' 微元'],['输入单价',current.inputMicrosPerToken+' 微元 / token'],['输出单价',current.outputMicrosPerToken+' 微元 / token'],['字符单价',current.characterMicros==null?'不适用':current.characterMicros+' 微元 / 字符']]),el('small',{},'可切换型号以已登记的支持列表为准；保存时由服务校验型号与费用范围。')));return panel;
}
export function eventsView(a) {
  const {s}=a;
  const events=s.snapshot.events.filter(e=>(!s.eventModule||e.moduleId===s.eventModule)&&(!s.eventKind||e.kind===s.eventKind));
  const kind={started:'开始',completed:'完成',failed:'失败',cancelled:'取消',state:'状态'};
  const filters=el('div',{class:'form-grid'},
    select('模块','event-module',s.eventModule,[{value:'',label:'全部模块'},...s.snapshot.modules.map(m=>({value:m.id,label:m.label}))],v=>{s.eventModule=v;a.render()}),
    select('事件','event-kind',s.eventKind,[{value:'',label:'全部事件'},...options(kind)],v=>{s.eventKind=v;a.render()}));
  const rows=[...events].reverse().map(e=>el('article',{class:'event'},
    el('small',{},time(e.at)),
    el('div',{},badge(kind[e.kind]||e.kind,e.kind==='failed'?'error':'muted'),el('small',{},s.snapshot.modules.find(m=>m.id===e.moduleId)?.label||e.moduleId)),
    el('div',{},el('p',{},e.message),el('small',{},[
      e.characterId?s.snapshot.characters.find(c=>c.id===e.characterId)?.label||e.characterId:null,
      e.elapsedMs==null?null:e.elapsedMs+' ms'].filter(Boolean).join(' · ')))));
  return card('实际运行记录',filters,
    el('p',{class:'subtle section-gap'},'显示最近的运行记录；点击顶部刷新查看更新。'),
    rows.length?rows:el('p',{class:'empty section-gap'},'当前筛选下没有运行事件。'));
}
