let csrf='',projectId=null,data=null;const $=s=>document.querySelector(s);const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};
// Fixed browser request budget: headers and the complete JSON body share 15 seconds.
const REQUEST_TIMEOUT_MS=15000;
async function api(path,opts={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  const timeout=()=>new Error('请求超时（15秒），请稍后重试');
  try{
    let response;
    try{response=await fetch(path,{...opts,signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...opts.headers}})}
    catch(error){if(controller.signal.aborted)throw timeout();throw new Error('网络连接失败，请检查连接后重试')}
    let value;
    try{value=await response.json()}
    catch(error){
      if(controller.signal.aborted)throw timeout();
      if(error.name==='SyntaxError')throw new Error('服务器响应不是有效 JSON，请稍后重试');
      throw new Error('网络连接中断，未能完整读取响应，请稍后重试');
    }
    if(controller.signal.aborted)throw timeout();
    if(!response.ok){
      if(!value||typeof value.error!=='string')throw new Error('服务器响应格式异常，请稍后重试');
      const error=new Error(`${response.status} ${value.error}`);error.status=response.status;throw error;
    }
    return value;
  }finally{clearTimeout(timer)}
}
const pendingCreations=new Map(),busyActions=new Set();
async function createRecord(path,body){
  const encoded=JSON.stringify(body),intent=JSON.stringify([path,encoded]);
  let key=pendingCreations.get(intent);
  if(!key){key=crypto.randomUUID();pendingCreations.set(intent,key)}
  try{
    const result=await api(path,{method:'POST',headers:{'Idempotency-Key':key},body:encoded});
    if(pendingCreations.get(intent)===key)pendingCreations.delete(intent);return result;
  }catch(error){
    if(error.status>=400&&error.status<500&&pendingCreations.get(intent)===key)pendingCreations.delete(intent);
    if(!error.status||error.status>=500){
      if(!error.message.includes('写入结果可能不确定'))error.message+='。写入结果可能不确定';
      error.message+='。请保持本页和内容不变，恢复后再次提交；系统会复用本次请求。不要刷新页面或修改内容后重试。';
    }
    throw error;
  }
}
let noticeGeneration=0,workspaceProblem=null;
function message(s,target='#notice'){$(target).textContent=s;if(target==='#notice')return ++noticeGeneration}
function rows(id,items,render){
  const fragment=document.createDocumentFragment();
  if(!items.length)fragment.append(el('p','暂无记录','hint'));
  for(const item of items){const d=el('div',undefined,'entry');render(d,item);fragment.append(d)}
  $(id).replaceChildren(fragment);
}
// Validate only the pagination envelope and fields needed to render/select a source safely.
function validatePage(page,list,cursor){
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const invalid=()=>{throw new Error('分页响应格式异常，请稍后重试')};
  if(!object(page)||!Array.isArray(page[list])||!page[list].every(object))invalid();
  const next=page[cursor];
  if(next!==null&&(!Number.isSafeInteger(next)||next<=0))invalid();
  if(next!==null&&(!page[list].length||page[list].at(-1).id!==next))invalid();
  if(list==='candidates'&&!['owner','member','viewer'].includes(page.role))invalid();
  if(list==='sources'&&!page.sources.every(source=>Number.isSafeInteger(source.id)&&source.id>0&&typeof source.title==='string'&&typeof source.content==='string'))invalid();
}

async function switchAccount(){
  try{await api('/api/logout',{method:'POST'})}
  catch(error){if(error.status!==401)throw error}
  // An expired session is already logged out; let the user authenticate again.
  location.reload();
}
// Project IDs can repeat after navigation; bind mutations to this workspace visit.
let projectGeneration=0,workspaceGeneration=0,proposalSubmissionGeneration=0;
async function loadProjects(){
  const generation=++projectGeneration;workspaceGeneration++;
  projectId=null;data=null;selectedSource=null;sourcePage=[];for(const id of ['#sourceFeedback','#proposalFeedback','#candidateFeedback'])message('',id);
  const select=$('#project');select.replaceChildren();
  for(const button of document.querySelectorAll('#proposal button,#sourceForm button,#stale,#injection'))button.disabled=true;
  message('正在加载项目…');
  try{
    const projects=await api('/api/projects');
    if(generation!==projectGeneration)return;
    projects.forEach(p=>{const o=el('option',`${p.name} · ${p.role}`);o.value=p.id;select.append(o)});
    if(!projects.length){message('当前账号没有可访问的项目。请切换账号或刷新工作台重试。');return}
    projectId=Number(select.value);message('');await load();
  }catch(error){if(generation===projectGeneration)message(`项目列表加载失败：${error.message}。请刷新工作台重试。`)}
}
let contextGeneration=0,factGeneration=0,factState={project:null,workspace:null,query:'',cursors:[0],index:0,next:null};
function factControls(busy=false){
  $('#facts').setAttribute('aria-busy',String(busy));
  $('#factsPrevious').disabled=busy||factState.index===0;
  $('#factsNext').disabled=busy||factState.next===null;
}
function renderFact(d,f,p){
  d.append(el('strong',`${f.subject} / ${f.predicate}：${f.value}`),el('span',`v${f.version}`,'badge'),el('div',`依据：${f.source}`,'meta'));
  appendProvenance(d,f,p);
}
function appendProvenance(d,f,p){
  const button=el('button','查看依据','secondary'),panel=el('div',undefined,'provenance-detail');
  panel.hidden=true;panel.setAttribute('aria-live','polite');button.setAttribute('aria-expanded','false');
  let loaded=false;
  button.onclick=async()=>{
    if(loaded){panel.hidden=!panel.hidden;button.textContent=panel.hidden?'查看依据':'收起依据';button.setAttribute('aria-expanded',String(!panel.hidden));return}
    panel.hidden=false;button.disabled=true;button.setAttribute('aria-expanded','true');panel.textContent='正在读取该版本依据…';
    try{
      const proof=await api(`/api/projects/${p}/facts/${f.id}/provenance?version=${f.version}`);
      if(p!==projectId||!d.isConnected)return;
      panel.replaceChildren(el('p',`版本 v${proof.revision.version} · 修订 #${proof.revision.id} · 候选 #${proof.candidate.id}`,'meta'),el('strong',`来源 #${proof.source.id}：${proof.source.title}`),el('p',proof.source.content),el('p',`提议用户 ${proof.candidate.proposed_by} · 批准用户 ${proof.revision.approved_by}`,'meta'));
      loaded=true;button.textContent='收起依据';
    }catch(error){if(p===projectId&&d.isConnected){panel.textContent=`依据读取失败：${error.message}。可点击重试。`;button.textContent='重试依据'}}
    finally{button.disabled=false}
  };
  d.append(button,panel);
}
async function loadFacts({reset=false,index=factState.index,focus=false}={}){
  if(projectId===null)return;
  if(factState.project!==projectId||factState.workspace!==workspaceGeneration){$('#facts').replaceChildren();factState={project:projectId,workspace:workspaceGeneration,query:'',cursors:[0],index:0,next:null};}
  const requested=reset?{project:projectId,workspace:workspaceGeneration,query:$('#searchForm').q.value,cursors:[0],index:0,next:null}:factState;
  if(reset)index=0;
  const generation=++factGeneration,p=projectId,query=requested.query,after=requested.cursors[index];
  factControls(true);$('#factsStatus').textContent='正在加载当前事实…';
  try{
    const page=await api(`/api/projects/${p}/facts?q=${encodeURIComponent(query)}&limit=50&after=${after}`);
    if(generation!==factGeneration||p!==projectId)return;
    validatePage(page,'facts','next_after');
    rows('#facts',page.facts,(d,f)=>renderFact(d,f,p));
    factState=requested;factState.index=index;factState.next=page.next_after;
    factState.cursors=factState.cursors.slice(0,index+1);
    if(page.next_after!==null)factState.cursors.push(page.next_after);
    $('#factsStatus').textContent=page.facts.length?`第 ${index+1} 页 · ${page.facts.length} 条${page.next_after===null?' · 已到末页':''}`:(index===0?'没有匹配的当前事实':'本页已无匹配事实，请返回上一页或刷新');
    factControls();if(focus)$('#factsTitle').focus();
  }catch(e){
    if(generation!==factGeneration||p!==projectId)return;
    $('#factsStatus').textContent=`加载失败：${e.message}。本次未更新列表，已加载的页面和翻页范围保留。请刷新工作台重试。`;
    factControls();
  }
}
let historyGeneration=0,historyState={project:null,workspace:null,cursors:[null],index:0,next:null};
function historyControls(busy=false){
  $('#history').setAttribute('aria-busy',String(busy));
  $('#historyPrevious').disabled=busy||historyState.index===0;
  $('#historyNext').disabled=busy||historyState.next===null;
}
async function loadHistory({reset=false,index=historyState.index,focus=false}={}){
  if(projectId===null)return;
  if(historyState.project!==projectId||historyState.workspace!==workspaceGeneration){$('#history').replaceChildren();historyState={project:projectId,workspace:workspaceGeneration,cursors:[null],index:0,next:null};}
  const requested=reset?{project:projectId,workspace:workspaceGeneration,cursors:[null],index:0,next:null}:historyState;
  if(reset)index=0;
  const generation=++historyGeneration,p=projectId,before=requested.cursors[index];
  historyControls(true);$('#historyStatus').textContent='正在加载版本历史…';
  try{
    const page=await api(`/api/projects/${p}/history?limit=25${before===null?'':`&before=${before}`}`);
    if(generation!==historyGeneration||p!==projectId)return;
    validatePage(page,'history','next_before');
    rows('#history',page.history,(d,h)=>{
      d.append(el('strong',`${h.subject} / ${h.predicate}：${h.value}`),el('span',`v${h.version}`,'badge'),el('div',`来源：${h.source} · ${new Date(h.created_at).toLocaleString()}`,'meta'));
      appendProvenance(d,{id:h.fact_id,version:h.version},p);
    });
    historyState=requested;historyState.index=index;historyState.next=page.next_before;
    historyState.cursors=historyState.cursors.slice(0,index+1);
    if(page.next_before!==null)historyState.cursors.push(page.next_before);
    $('#historyStatus').textContent=page.history.length?`历史第 ${index+1} 页 · ${page.history.length} 条${page.next_before===null?' · 已到末页':''}`:'暂无版本历史';
    historyControls();if(focus)$('#historyTitle').focus();
  }catch(e){
    if(generation!==historyGeneration||p!==projectId)return;
    $('#historyStatus').textContent=`历史加载失败：${e.message}。本次未更新列表，已加载的页面和翻页范围保留。请刷新历史重试。`;
    historyControls();
  }
}
let auditGeneration=0,auditState={project:null,workspace:null,cursors:[null],index:0,next:null};
function auditControls(busy=false){
  $('#audit').setAttribute('aria-busy',String(busy));
  $('#auditPrevious').disabled=busy||auditState.index===0;
  $('#auditNext').disabled=busy||auditState.next===null;
}
async function loadAudit({reset=false,index=auditState.index,focus=false}={}){
  if(projectId===null)return;
  if(auditState.project!==projectId||auditState.workspace!==workspaceGeneration){$('#audit').replaceChildren();auditState={project:projectId,workspace:workspaceGeneration,cursors:[null],index:0,next:null};}
  const requested=reset?{project:projectId,workspace:workspaceGeneration,cursors:[null],index:0,next:null}:auditState;
  if(reset)index=0;
  const generation=++auditGeneration,p=projectId,before=requested.cursors[index];
  auditControls(true);$('#auditStatus').textContent='正在加载操作审计…';
  try{
    const page=await api(`/api/projects/${p}/audit?limit=25${before===null?'':`&before=${before}`}`);
    if(generation!==auditGeneration||p!==projectId)return;
    validatePage(page,'audit','next_before');
    rows('#audit',page.audit,(d,a)=>d.append(el('strong',a.action),el('span',`#${a.id}`,'badge'),el('div',`${a.detail} · 用户 ${a.actor_id} · ${new Date(a.created_at).toLocaleString()}`,'meta')));
    auditState=requested;auditState.index=index;auditState.next=page.next_before;
    auditState.cursors=auditState.cursors.slice(0,index+1);
    if(page.next_before!==null)auditState.cursors.push(page.next_before);
    $('#auditStatus').textContent=page.audit.length?`审计第 ${index+1} 页 · ${page.audit.length} 条${page.next_before===null?' · 已到末页':''}`:'暂无操作审计';
    auditControls();if(focus)$('#auditTitle').focus();
  }catch(e){
    if(generation!==auditGeneration||p!==projectId)return;
    $('#auditStatus').textContent=`审计加载失败：${e.message}。本次未更新列表，已加载的页面和翻页范围保留。请刷新审计重试。`;
    auditControls();
  }
}
let candidateGeneration=0,candidateState={project:null,workspace:null,status:'all',cursors:[null],index:0,next:null};
function candidateControls(busy=false){
  $('#candidates').setAttribute('aria-busy',String(busy));
  $('#candidatesPrevious').disabled=busy||candidateState.index===0;
  $('#candidatesNext').disabled=busy||candidateState.next===null;
}
function renderCandidate(d,c,role,p){
  d.append(el('strong',`${c.subject} / ${c.predicate} → ${c.value}`),el('span',({pending:'待审批',approved:'已批准',rejected:'已驳回'})[c.status],'badge'),el('div',`#${c.id} · 基于 v${c.expected_version} · 来源：${c.source}`,'meta'));
  const preview=el('button','核对来源原文','secondary'),panel=el('div',undefined,'provenance-detail');
  panel.hidden=true;panel.setAttribute('aria-live','polite');preview.setAttribute('aria-expanded','false');let loaded=false;
  preview.onclick=async()=>{
    if(loaded){panel.hidden=!panel.hidden;preview.textContent=panel.hidden?'核对来源原文':'收起来源原文';preview.setAttribute('aria-expanded',String(!panel.hidden));return}
    panel.hidden=false;preview.disabled=true;preview.setAttribute('aria-expanded','true');panel.textContent='正在读取候选绑定的来源…';
    try{
      const proof=await api(`/api/projects/${p}/candidates/${c.id}/source`);
      if(p!==projectId||!d.isConnected)return;
      const comparison=proof.comparison;
      const sameContent=proof.current?.value===proof.candidate.value&&proof.current?.source_id===proof.candidate.source_id;
      const status=proof.candidate.status==='pending'?(sameContent?'当前事实已采用相同值与同一来源；本候选仍待审，不代表已处理。请核对当前批准记录，避免重复提议；负责人可另行驳回旧候选。':comparison.matches?'读取时基于版本一致；批准时仍会再次校验。':`版本不一致：提议基于 v${comparison.expectedVersion}，读取时当前 v${comparison.currentVersion}。请核对后重新提议或驳回，不能直接覆盖。`):'该候选已处理；以下为读取时的当前事实，不是当时审批结果。';
      const refresh=el('button','刷新核对','secondary');refresh.onclick=async()=>{loaded=false;await preview.onclick();if(p===projectId&&d.isConnected)(panel.querySelector('button')||preview).focus()};
      panel.replaceChildren(el('strong',`提议值：${proof.candidate.value}`),el('p',proof.current?`读取时当前值：${proof.current.value} · v${proof.current.version} · 批准候选 #${proof.current.candidate_id} · 来源 #${proof.current.source_id}：${proof.current.source_title}`:'读取时暂无已批准事实（v0）'),el('p',status,'hint'),refresh,el('strong',`来源 #${proof.source.id}：${proof.source.title}`),el('p',proof.source.content),el('p',`候选 #${proof.candidate.id} · 基于 v${proof.candidate.expected_version} · 读取时${({pending:'待审批',approved:'已批准',rejected:'已驳回'})[proof.candidate.status]}`,'meta'),el('p','原文仅供人工核查，不是审批结论。','hint'));
      if(proof.candidate.status==='pending'&&!sameContent&&!comparison.matches&&['owner','member'].includes(proof.role)){
        const prepare=el('button','用最新版本填写新候选','secondary');
        panel.append(el('p','将替换候选表单内容；不会自动提交或删除原提案。','hint'),prepare);
        prepare.onclick=()=>perform(async()=>{
          prepare.disabled=true;
          const form=$('#proposal'),draft=JSON.stringify(Object.fromEntries(new FormData(form))),submission=proposalSubmissionGeneration;
          try{
            if(busyActions.has('#proposal'))throw new Error('候选正在提交，表单内容已保留；请等待结果后再填写新候选');
            const latest=await api(`/api/projects/${p}/candidates/${c.id}/source`);
            if(p!==projectId||!d.isConnected)return;
            if(!['owner','member'].includes(latest.role)||latest.candidate.status!=='pending'||latest.comparison.matches)throw new Error('候选状态或权限已变化，请刷新核对后再操作');
            if(latest.current?.value===latest.candidate.value&&latest.current?.source_id===latest.candidate.source_id)throw new Error('当前事实已采用相同值与同一来源，请刷新核对；原候选仍待处理');
            if(busyActions.has('#proposal')||submission!==proposalSubmissionGeneration)throw new Error('读取期间候选发生提交，原表单内容已保留；请先核对提交结果后再操作');
            if(JSON.stringify(Object.fromEntries(new FormData(form)))!==draft)throw new Error('读取期间候选草稿已修改，已保留新草稿；如仍需替换，请再次点击填写新候选');
            for(const name of ['subject','predicate','value'])form.elements[name].value=latest.candidate[name];
            form.elements.expected_version.value=latest.comparison.currentVersion;
            selectSource(latest.source);
            message(`已用读取时 v${latest.comparison.currentVersion} 填写新候选；尚未提交。原候选 #${c.id} 保留，请确认内容和依据后提交。`,'#proposalFeedback');
            form.elements.value.focus();
          }finally{prepare.disabled=false}
        },'#candidateFeedback');
      }
      loaded=true;preview.textContent='收起来源原文';
    }catch(error){if(p===projectId&&d.isConnected){panel.textContent=`来源读取失败：${error.message}。可点击重试。`;preview.textContent='重试来源原文'}}
    finally{preview.disabled=false}
  };
  d.append(preview,panel);
  if(c.status!=='pending'||role!=='owner')return;
  const actions=el('div',undefined,'actions');
  for(const [label,action] of [['批准','approve'],['驳回','reject']]){
    const b=el('button',label,action==='reject'?'secondary':'');
    b.onclick=()=>perform(async()=>{
      const workspace=workspaceGeneration;
      for(const button of actions.querySelectorAll('button'))button.disabled=true;
      try{
        const result=await api(`/api/projects/${p}/candidates/${c.id}/${action}`,{method:'POST'});
        if(p===projectId&&workspace===workspaceGeneration){
          await load();
          if(p===projectId&&workspace===workspaceGeneration){message(action==='approve'?`批准成功：本次生成 v${result.version}，当前事实已更新；旧版本保留在历史中。`:'驳回成功：候选保留为已驳回，本次操作未修改当前事实。','#candidateFeedback');$('#candidateFeedback').focus()}
        }
      }catch(e){
        if(e.status===409&&p===projectId&&workspace===workspaceGeneration)await load();
        throw e;
      }finally{for(const button of actions.querySelectorAll('button'))button.disabled=false}
    },'#candidateFeedback');actions.append(b);
  }
  d.append(actions);
}
async function loadCandidates({reset=false,index=candidateState.index,focus=false}={}){
  if(projectId===null)return;
  if(candidateState.project!==projectId||candidateState.workspace!==workspaceGeneration){$('#candidates').replaceChildren();candidateState={project:projectId,workspace:workspaceGeneration,status:'all',cursors:[null],index:0,next:null};}
  const requested=reset?{project:projectId,workspace:workspaceGeneration,status:$('#candidateFilter').value,cursors:[null],index:0,next:null}:candidateState;
  if(reset)index=0;
  const generation=++candidateGeneration,p=projectId,before=requested.cursors[index],status=requested.status;
  candidateControls(true);$('#candidatesStatus').textContent='正在加载候选…';
  try{
    const page=await api(`/api/projects/${p}/candidates?status=${status}&limit=25${before===null?'':`&before=${before}`}`);
    if(generation!==candidateGeneration||p!==projectId)return;
    validatePage(page,'candidates','next_before');
    rows('#candidates',page.candidates,(d,c)=>renderCandidate(d,c,page.role,p));
    candidateState=requested;candidateState.index=index;candidateState.next=page.next_before;
    candidateState.cursors=candidateState.cursors.slice(0,index+1);
    if(page.next_before!==null)candidateState.cursors.push(page.next_before);
    $('#candidatesStatus').textContent=page.candidates.length?`候选第 ${index+1} 页 · ${page.candidates.length} 条${page.next_before===null?' · 已到末页':''}`:(index===0?'当前筛选没有候选':'本页已无候选，请返回或刷新候选');
    candidateControls();if(focus)$('#candidatesTitle').focus();
  }catch(e){
    if(generation!==candidateGeneration||p!==projectId)return;
    $('#candidatesStatus').textContent=`候选加载失败：${e.message}。本次未更新列表，已加载的页面和翻页范围保留。请刷新候选重试。`;
    $('#candidateFilter').value=candidateState.status;candidateControls();
  }
}
let sourceGeneration=0,sourceState={project:null,workspace:null,query:'',cursors:[0],index:0,next:null},sourcePage=[],selectedSource=null;
function writeControls(){
  $('#sourceForm button').disabled=!data||busyActions.has('#sourceForm');
  for(const id of ['#stale','#injection'])$(id).disabled=!data||busyActions.has(id);
  $('#proposal button').disabled=!data||!selectedSource||selectedSource.project!==projectId||busyActions.has('#proposal');
}
function sourceOptions(){
  const select=$('#sourceSelect');select.replaceChildren();
  const options=[...sourcePage];
  if(selectedSource&&!options.some(s=>s.id===selectedSource.id))options.unshift(selectedSource);
  for(const source of options){const option=el('option',`#${source.id} ${source.title}`);option.value=source.id;select.append(option)}
  if(selectedSource)select.value=selectedSource.id;
  $('#sourceSelection').textContent=selectedSource?`已选 #${selectedSource.id} ${selectedSource.title}；翻页与检索会保留此依据。`:'请先在来源列表选择依据。';
  writeControls();
}
function selectSource(source){selectedSource={id:source.id,title:source.title,project:projectId};sourceOptions()}
function sourceControls(busy=false){
  $('#sources').setAttribute('aria-busy',String(busy));
  $('#sourcesPrevious').disabled=busy||sourceState.index===0;
  $('#sourcesNext').disabled=busy||sourceState.next===null;
}
async function loadSources({reset=false,index=sourceState.index,focus=false}={}){
  if(projectId===null)return;
  if(sourceState.project!==projectId||sourceState.workspace!==workspaceGeneration){$('#sources').replaceChildren();sourceState={project:projectId,workspace:workspaceGeneration,query:'',cursors:[0],index:0,next:null};sourcePage=[];sourceOptions();}
  const requested=reset?{project:projectId,workspace:workspaceGeneration,query:$('#sourceSearchForm').q.value,cursors:[0],index:0,next:null}:sourceState;
  if(reset)index=0;
  const generation=++sourceGeneration,p=projectId,query=requested.query,after=requested.cursors[index];
  sourceControls(true);$('#sourcesStatus').textContent='正在加载来源…';
  try{
    const page=await api(`/api/projects/${p}/sources?q=${encodeURIComponent(query)}&limit=25&after=${after}`);
    if(generation!==sourceGeneration||p!==projectId)return;
    validatePage(page,'sources','next_after');
    rows('#sources',page.sources,(d,source)=>{
      d.append(el('strong',`#${source.id} ${source.title}`));
      if(source.content.length<=160)d.append(el('div',source.content,'meta'));
      else{d.append(el('div',source.content.slice(0,120)+'…','meta'));const details=el('details');details.append(el('summary',`查看完整正文（${source.content.length} 字符）`),el('div',source.content,'meta'));d.append(details)}
      const button=el('button','选作依据','secondary');button.onclick=()=>{selectSource(source);message(`已选择来源 #${source.id}`);$('#sourceSelect').focus()};d.append(button);
    });
    sourceState=requested;sourceState.index=index;sourceState.next=page.next_after;
    sourceState.cursors=sourceState.cursors.slice(0,index+1);
    if(page.next_after!==null)sourceState.cursors.push(page.next_after);
    sourcePage=page.sources;
    if(!selectedSource&&sourcePage.length)selectedSource={id:sourcePage[0].id,title:sourcePage[0].title,project:p};
    sourceOptions();
    $('#sourcesStatus').textContent=sourcePage.length?`来源第 ${index+1} 页 · ${sourcePage.length} 条${page.next_after===null?' · 已到末页':''}`:'没有匹配的来源标题';
    sourceControls();if(focus)$('#sourcesTitle').focus();
  }catch(e){
    if(generation!==sourceGeneration||p!==projectId)return;
    $('#sourcesStatus').textContent=`来源加载失败：${e.message}。本次未更新列表，已加载的页面和翻页范围保留。请刷新来源重试。`;
    sourceControls();
  }
}
async function load(){
  if(projectId===null)return loadProjects();
  const generation=++contextGeneration,p=projectId;
  data=null;
  for(const b of document.querySelectorAll('#proposal button,#sourceForm button,#stale,#injection'))b.disabled=true;
  const facts=loadFacts({reset:true}),history=loadHistory({reset:true}),candidates=loadCandidates({reset:true}),sources=loadSources({reset:true}),audit=loadAudit({reset:true});
  try{
    const result=await api(`/api/projects/${p}/data?include_facts=false&include_history=false&include_candidates=false&include_sources=false&include_audit=false`);
    if(generation!==contextGeneration||p!==projectId)return;
    data=result;
    // A resolved read failure cannot clear a newer message from another action.
    if(workspaceProblem?.workspace===workspaceGeneration&&workspaceProblem.project===p&&workspaceProblem.notice===noticeGeneration)message('');
    workspaceProblem=null;
    writeControls();
  }catch(e){if(generation===contextGeneration&&p===projectId)workspaceProblem={project:p,workspace:workspaceGeneration,notice:message(`工作台加载失败：${e.message}。请刷新重试。`)}}
  await Promise.all([facts,history,candidates,sources,audit]);
}
async function perform(fn,feedback=null){const p=projectId,workspace=workspaceGeneration;if(feedback){message('');message('',feedback)}try{await fn()}catch(e){if(p===projectId&&workspace===workspaceGeneration){message(e.message,feedback||'#notice');if(feedback)$(feedback).focus()}}}
// Lock before awaiting so rapid clicks and keyboard submission share one in-flight action.
async function submitOnce(target,fn,{feedback=null,progress='正在提交…'}={}){
  if(busyActions.has(target))return;
  busyActions.add(target);
  const root=$(target),button=root.tagName==='BUTTON'?root:root.querySelector('button'),label=button.textContent,p=projectId,workspace=workspaceGeneration;
  root.setAttribute('aria-busy','true');button.disabled=true;button.textContent=progress;
  try{
    await perform(async()=>{message(progress,feedback||'#notice');await fn()},feedback);
  }finally{
    busyActions.delete(target);root.setAttribute('aria-busy','false');button.textContent=label;
    if(p===projectId&&workspace===workspaceGeneration&&$(feedback||'#notice').textContent===progress)message('',feedback||'#notice');
    if(target==='#loginForm')button.disabled=false;else writeControls();
  }
}
$('#loginForm').username.onchange=e=>$('#loginForm').password.value=`demo-${e.target.value}`;
$('#loginForm').onsubmit=e=>{e.preventDefault();submitOnce('#loginForm',async()=>{
  const f=new FormData(e.target),x=await api('/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});
  csrf=x.csrf;message('');if($('#login').contains(document.activeElement))document.activeElement.blur();$('#login').hidden=true;$('#workspace').hidden=false;$('#identity').replaceChildren(document.createTextNode(x.name));
  const b=el('button','切换账号');b.onclick=()=>perform(switchAccount);$('#identity').append(b);
  const projects=loadProjects(),workspace=workspaceGeneration;await projects;
  // Hiding the login form leaves keyboard focus on BODY; respect any later user focus.
  if(workspace===workspaceGeneration&&document.activeElement===document.body)(projectId===null||!data?$('#refreshWorkspace'):$('#project')).focus();
},{progress:'正在登录…'})};
$('#project').onchange=e=>{workspaceGeneration++;for(const id of ['#notice','#sourceFeedback','#proposalFeedback','#candidateFeedback'])message('',id);projectId=Number(e.target.value);selectedSource=null;sourcePage=[];$('#sourceSearchForm').q.value='';perform(load)};$('#searchForm').onsubmit=e=>{e.preventDefault();perform(()=>loadFacts({reset:true}))};
$('#factsPrevious').onclick=()=>perform(()=>loadFacts({index:factState.index-1,focus:true}));
$('#factsNext').onclick=()=>perform(()=>loadFacts({index:factState.index+1,focus:true}));
$('#refreshWorkspace').onclick=()=>perform(load);
$('#historyPrevious').onclick=()=>perform(()=>loadHistory({index:historyState.index-1,focus:true}));
$('#historyNext').onclick=()=>perform(()=>loadHistory({index:historyState.index+1,focus:true}));
$('#refreshHistory').onclick=()=>perform(()=>loadHistory({reset:true}));
$('#auditPrevious').onclick=()=>perform(()=>loadAudit({index:auditState.index-1,focus:true}));
$('#auditNext').onclick=()=>perform(()=>loadAudit({index:auditState.index+1,focus:true}));
$('#refreshAudit').onclick=()=>perform(()=>loadAudit({reset:true}));
$('#candidateFilter').onchange=()=>perform(()=>loadCandidates({reset:true}));
$('#candidatesPrevious').onclick=()=>perform(()=>loadCandidates({index:candidateState.index-1,focus:true}));
$('#candidatesNext').onclick=()=>perform(()=>loadCandidates({index:candidateState.index+1,focus:true}));
$('#refreshCandidates').onclick=()=>perform(()=>loadCandidates({reset:true}));
$('#sourceSelect').onchange=e=>{const source=sourcePage.find(s=>s.id===Number(e.target.value))||selectedSource;if(source)selectSource(source)};
$('#sourceSearchForm').onsubmit=e=>{e.preventDefault();perform(()=>loadSources({reset:true}))};
$('#sourcesPrevious').onclick=()=>perform(()=>loadSources({index:sourceState.index-1,focus:true}));
$('#sourcesNext').onclick=()=>perform(()=>loadSources({index:sourceState.index+1,focus:true}));
$('#refreshSources').onclick=()=>perform(()=>loadSources({reset:true}));
$('#proposal').onsubmit=e=>{e.preventDefault();submitOnce('#proposal',async()=>{const p=projectId,workspace=workspaceGeneration;proposalSubmissionGeneration++;await createRecord(`/api/projects/${p}/candidates`,Object.fromEntries(new FormData(e.target)));if(p!==projectId||workspace!==workspaceGeneration)return;message('候选已提交，等待负责人审批','#proposalFeedback');await load()},{feedback:'#proposalFeedback',progress:'正在提交候选…'})};
$('#sourceForm').onsubmit=e=>{e.preventDefault();submitOnce('#sourceForm',async()=>{const p=projectId,workspace=workspaceGeneration,body=Object.fromEntries(new FormData(e.target)),source=await createRecord(`/api/projects/${p}/sources`,body);if(p!==projectId||workspace!==workspaceGeneration)return;selectSource(source);if(JSON.stringify(Object.fromEntries(new FormData(e.target)))===JSON.stringify(body))e.target.reset();message(`来源 #${source.id} 已保存并选为依据`,'#sourceFeedback');await load()},{feedback:'#sourceFeedback',progress:'正在保存来源…'})};
async function simulated(value,fragment){
  const p=projectId,workspace=workspaceGeneration,page=await api(`/api/projects/${p}/sources?q=${encodeURIComponent(fragment)}&limit=1`);
  if(p!==projectId||workspace!==workspaceGeneration)return;
  if(!page.sources.length)throw new Error('当前项目缺少此模拟场景的来源');
  await createRecord(`/api/projects/${p}/candidates`,{subject:'项目',predicate:'截止日',value,source_id:page.sources[0].id,expected_version:1});
  if(p===projectId&&workspace===workspaceGeneration){message('模拟客户端已提交候选，尚未改变当前事实');await load()}
}
$('#stale').onclick=()=>submitOnce('#stale',()=>simulated('25号','会议纪要'),{progress:'正在提交模拟候选…'});$('#injection').onclick=()=>submitOnce('#injection',()=>simulated('30号','外部文档'),{progress:'正在提交模拟候选…'});

$('#addSourceShortcut').onclick=e=>{e.preventDefault();$('#sourceForm').closest('details').open=true;$('#sourceForm [name=title]').focus()};
$('#backToProposal').onclick=e=>{e.preventDefault();$('#proposal [name=subject]').focus()};
