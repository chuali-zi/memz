let csrf='',projectId=null,data=null;const $=s=>document.querySelector(s);const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...opts.headers}});const v=await r.json();if(!r.ok){const error=new Error(`${r.status} ${v.error}`);error.status=r.status;throw error}return v}
const pendingCreations=new Map();
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
function message(s,target='#notice'){$(target).textContent=s}function rows(id,items,render){const root=$(id);root.replaceChildren();if(!items.length)root.append(el('p','暂无记录','hint'));for(const item of items){const d=el('div',undefined,'entry');render(d,item);root.append(d)}}
async function switchAccount(){
  try{await api('/api/logout',{method:'POST'})}
  catch(error){if(error.status!==401)throw error}
  // An expired session is already logged out; let the user authenticate again.
  location.reload();
}
let projectGeneration=0;
async function loadProjects(){
  const generation=++projectGeneration;
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
let contextGeneration=0,factGeneration=0,factState={query:'',cursors:[0],index:0,next:null};
function factControls(busy=false){
  $('#facts').setAttribute('aria-busy',String(busy));
  $('#factsPrevious').disabled=busy||factState.index===0;
  $('#factsNext').disabled=busy||factState.next===null;
}
function renderFact(d,f,p){
  d.append(el('strong',`${f.subject} / ${f.predicate}：${f.value}`),el('span',`v${f.version}`,'badge'),el('div',`依据：${f.source}`,'meta'));
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
  if(reset){factState={query:$('#searchForm').q.value,cursors:[0],index:0,next:null};index=0}
  const generation=++factGeneration,p=projectId,query=factState.query,after=factState.cursors[index];
  factControls(true);$('#facts').replaceChildren();$('#factsStatus').textContent='正在加载当前事实…';
  try{
    const page=await api(`/api/projects/${p}/facts?q=${encodeURIComponent(query)}&limit=50&after=${after}`);
    if(generation!==factGeneration||p!==projectId)return;
    factState.index=index;factState.next=page.next_after;
    factState.cursors=factState.cursors.slice(0,index+1);
    if(page.next_after!==null)factState.cursors.push(page.next_after);
    rows('#facts',page.facts,(d,f)=>renderFact(d,f,p));
    $('#factsStatus').textContent=page.facts.length?`第 ${index+1} 页 · ${page.facts.length} 条${page.next_after===null?' · 已到末页':''}`:(index===0?'没有匹配的当前事实':'本页已无匹配事实，请返回上一页或刷新');
    factControls();if(focus)$('#factsTitle').focus();
  }catch(e){
    if(generation!==factGeneration||p!==projectId)return;
    $('#factsStatus').textContent=`加载失败：${e.message}。请刷新工作台重试。`;
    $('#facts').setAttribute('aria-busy','false');$('#factsPrevious').disabled=true;$('#factsNext').disabled=true;
  }
}
let historyGeneration=0,historyState={cursors:[null],index:0,next:null};
function historyControls(busy=false){
  $('#history').setAttribute('aria-busy',String(busy));
  $('#historyPrevious').disabled=busy||historyState.index===0;
  $('#historyNext').disabled=busy||historyState.next===null;
}
async function loadHistory({reset=false,index=historyState.index,focus=false}={}){
  if(projectId===null)return;
  if(reset){historyState={cursors:[null],index:0,next:null};index=0}
  const generation=++historyGeneration,p=projectId,before=historyState.cursors[index];
  historyControls(true);$('#history').replaceChildren();$('#historyStatus').textContent='正在加载版本历史…';
  try{
    const page=await api(`/api/projects/${p}/history?limit=25${before===null?'':`&before=${before}`}`);
    if(generation!==historyGeneration||p!==projectId)return;
    historyState.index=index;historyState.next=page.next_before;
    historyState.cursors=historyState.cursors.slice(0,index+1);
    if(page.next_before!==null)historyState.cursors.push(page.next_before);
    rows('#history',page.history,(d,h)=>d.append(el('strong',`${h.subject} / ${h.predicate}：${h.value}`),el('span',`v${h.version}`,'badge'),el('div',`来源：${h.source} · ${new Date(h.created_at).toLocaleString()}`,'meta')));
    $('#historyStatus').textContent=page.history.length?`历史第 ${index+1} 页 · ${page.history.length} 条${page.next_before===null?' · 已到末页':''}`:'暂无版本历史';
    historyControls();if(focus)$('#historyTitle').focus();
  }catch(e){
    if(generation!==historyGeneration||p!==projectId)return;
    $('#historyStatus').textContent=`历史加载失败：${e.message}。请刷新历史重试。`;
    $('#history').setAttribute('aria-busy','false');$('#historyPrevious').disabled=true;$('#historyNext').disabled=true;
  }
}
let candidateGeneration=0,candidateState={status:'all',cursors:[null],index:0,next:null};
function candidateControls(busy=false){
  $('#candidates').setAttribute('aria-busy',String(busy));
  $('#candidatesPrevious').disabled=busy||candidateState.index===0;
  $('#candidatesNext').disabled=busy||candidateState.next===null;
}
function renderCandidate(d,c,role,p){
  d.append(el('strong',`${c.subject} / ${c.predicate} → ${c.value}`),el('span',({pending:'待审批',approved:'已批准',rejected:'已驳回'})[c.status],'badge'),el('div',`#${c.id} · 基于 v${c.expected_version} · 来源：${c.source}`,'meta'));
  if(c.status!=='pending'||role!=='owner')return;
  const actions=el('div',undefined,'actions');
  for(const [label,action] of [['批准','approve'],['驳回','reject']]){
    const b=el('button',label,action==='reject'?'secondary':'');
    b.onclick=()=>perform(async()=>{
      for(const button of actions.querySelectorAll('button'))button.disabled=true;
      try{
        const result=await api(`/api/projects/${p}/candidates/${c.id}/${action}`,{method:'POST'});
        if(p===projectId){
          await load();
          if(p===projectId){message(action==='approve'?`批准成功：本次生成 v${result.version}，当前事实已更新；旧版本保留在历史中。`:'驳回成功：候选保留为已驳回，本次操作未修改当前事实。','#candidateFeedback');$('#candidateFeedback').focus()}
        }
      }catch(e){
        if(e.status===409&&p===projectId)await load();
        throw e;
      }finally{for(const button of actions.querySelectorAll('button'))button.disabled=false}
    },'#candidateFeedback');actions.append(b);
  }
  d.append(actions);
}
async function loadCandidates({reset=false,index=candidateState.index,focus=false}={}){
  if(projectId===null)return;
  if(reset){candidateState={status:$('#candidateFilter').value,cursors:[null],index:0,next:null};index=0}
  const generation=++candidateGeneration,p=projectId,before=candidateState.cursors[index],status=candidateState.status;
  candidateControls(true);$('#candidates').replaceChildren();$('#candidatesStatus').textContent='正在加载候选…';
  try{
    const page=await api(`/api/projects/${p}/candidates?status=${status}&limit=25${before===null?'':`&before=${before}`}`);
    if(generation!==candidateGeneration||p!==projectId)return;
    candidateState.index=index;candidateState.next=page.next_before;
    candidateState.cursors=candidateState.cursors.slice(0,index+1);
    if(page.next_before!==null)candidateState.cursors.push(page.next_before);
    rows('#candidates',page.candidates,(d,c)=>renderCandidate(d,c,page.role,p));
    $('#candidatesStatus').textContent=page.candidates.length?`候选第 ${index+1} 页 · ${page.candidates.length} 条${page.next_before===null?' · 已到末页':''}`:(index===0?'当前筛选没有候选':'本页已无候选，请返回或刷新候选');
    candidateControls();if(focus)$('#candidatesTitle').focus();
  }catch(e){
    if(generation!==candidateGeneration||p!==projectId)return;
    $('#candidatesStatus').textContent=`候选加载失败：${e.message}。请刷新候选重试。`;
    $('#candidates').setAttribute('aria-busy','false');$('#candidatesPrevious').disabled=true;$('#candidatesNext').disabled=true;
  }
}
let sourceGeneration=0,sourceState={query:'',cursors:[0],index:0,next:null},sourcePage=[],selectedSource=null;
function writeControls(){
  for(const b of document.querySelectorAll('#sourceForm button,#stale,#injection'))b.disabled=!data;
  $('#proposal button').disabled=!data||!selectedSource||selectedSource.project!==projectId;
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
  if(reset){sourceState={query:$('#sourceSearchForm').q.value,cursors:[0],index:0,next:null};index=0}
  const generation=++sourceGeneration,p=projectId,query=sourceState.query,after=sourceState.cursors[index];
  sourcePage=[];sourceOptions();sourceControls(true);$('#sources').replaceChildren();$('#sourcesStatus').textContent='正在加载来源…';
  try{
    const page=await api(`/api/projects/${p}/sources?q=${encodeURIComponent(query)}&limit=25&after=${after}`);
    if(generation!==sourceGeneration||p!==projectId)return;
    sourceState.index=index;sourceState.next=page.next_after;
    sourceState.cursors=sourceState.cursors.slice(0,index+1);
    if(page.next_after!==null)sourceState.cursors.push(page.next_after);
    sourcePage=page.sources;
    if(!selectedSource&&sourcePage.length)selectedSource={id:sourcePage[0].id,title:sourcePage[0].title,project:p};
    sourceOptions();
    rows('#sources',sourcePage,(d,source)=>{
      d.append(el('strong',`#${source.id} ${source.title}`));
      if(source.content.length<=160)d.append(el('div',source.content,'meta'));
      else{d.append(el('div',source.content.slice(0,120)+'…','meta'));const details=el('details');details.append(el('summary',`查看完整正文（${source.content.length} 字符）`),el('div',source.content,'meta'));d.append(details)}
      const button=el('button','选作依据','secondary');button.onclick=()=>{selectSource(source);message(`已选择来源 #${source.id}`);$('#sourceSelect').focus()};d.append(button);
    });
    $('#sourcesStatus').textContent=sourcePage.length?`来源第 ${index+1} 页 · ${sourcePage.length} 条${page.next_after===null?' · 已到末页':''}`:'没有匹配的来源标题';
    sourceControls();if(focus)$('#sourcesTitle').focus();
  }catch(e){
    if(generation!==sourceGeneration||p!==projectId)return;
    $('#sourcesStatus').textContent=`来源加载失败：${e.message}。请刷新来源重试。`;
    $('#sources').setAttribute('aria-busy','false');$('#sourcesPrevious').disabled=true;$('#sourcesNext').disabled=true;
  }
}
async function load(){
  if(projectId===null)return loadProjects();
  const generation=++contextGeneration,p=projectId;
  data=null;
  for(const id of ['#sources','#candidates','#history','#audit'])$(id).replaceChildren();
  for(const b of document.querySelectorAll('#proposal button,#sourceForm button,#stale,#injection'))b.disabled=true;
  const facts=loadFacts({reset:true}),history=loadHistory({reset:true}),candidates=loadCandidates({reset:true}),sources=loadSources({reset:true});
  try{
    const result=await api(`/api/projects/${p}/data?include_facts=false&include_history=false&include_candidates=false&include_sources=false`);
    if(generation!==contextGeneration||p!==projectId)return;
    data=result;
    writeControls();
    renderContext();
  }catch(e){if(generation===contextGeneration&&p===projectId)message(`工作台加载失败：${e.message}。请刷新重试。`)}
  await Promise.all([facts,history,candidates,sources]);
}
function renderContext(){rows('#audit',data.audit,(d,a)=>d.append(el('strong',a.action),el('div',`${a.detail} · 用户 ${a.actor_id} · ${new Date(a.created_at).toLocaleString()}`,'meta')))}
async function perform(fn,feedback=null){const p=projectId;if(feedback){message('');message('',feedback)}try{await fn()}catch(e){if(!feedback||p===projectId){message(e.message,feedback||'#notice');if(feedback)$(feedback).focus()}}}
$('#loginForm').username.onchange=e=>$('#loginForm').password.value=`demo-${e.target.value}`;
$('#loginForm').onsubmit=e=>{e.preventDefault();perform(async()=>{const f=new FormData(e.target);const x=await api('/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});csrf=x.csrf;message('');$('#login').hidden=true;$('#workspace').hidden=false;$('#identity').replaceChildren(document.createTextNode(x.name));const b=el('button','切换账号');b.onclick=()=>perform(switchAccount);$('#identity').append(b);await loadProjects()})};
$('#project').onchange=e=>{for(const id of ['#sourceFeedback','#proposalFeedback','#candidateFeedback'])message('',id);projectId=Number(e.target.value);selectedSource=null;sourcePage=[];$('#sourceSearchForm').q.value='';perform(load)};$('#searchForm').onsubmit=e=>{e.preventDefault();perform(()=>loadFacts({reset:true}))};
$('#factsPrevious').onclick=()=>perform(()=>loadFacts({index:factState.index-1,focus:true}));
$('#factsNext').onclick=()=>perform(()=>loadFacts({index:factState.index+1,focus:true}));
$('#refreshWorkspace').onclick=()=>perform(load);
$('#historyPrevious').onclick=()=>perform(()=>loadHistory({index:historyState.index-1,focus:true}));
$('#historyNext').onclick=()=>perform(()=>loadHistory({index:historyState.index+1,focus:true}));
$('#refreshHistory').onclick=()=>perform(()=>loadHistory({reset:true}));
$('#candidateFilter').onchange=()=>perform(()=>loadCandidates({reset:true}));
$('#candidatesPrevious').onclick=()=>perform(()=>loadCandidates({index:candidateState.index-1,focus:true}));
$('#candidatesNext').onclick=()=>perform(()=>loadCandidates({index:candidateState.index+1,focus:true}));
$('#refreshCandidates').onclick=()=>perform(()=>loadCandidates({reset:true}));
$('#sourceSelect').onchange=e=>{const source=sourcePage.find(s=>s.id===Number(e.target.value))||selectedSource;if(source)selectSource(source)};
$('#sourceSearchForm').onsubmit=e=>{e.preventDefault();perform(()=>loadSources({reset:true}))};
$('#sourcesPrevious').onclick=()=>perform(()=>loadSources({index:sourceState.index-1,focus:true}));
$('#sourcesNext').onclick=()=>perform(()=>loadSources({index:sourceState.index+1,focus:true}));
$('#refreshSources').onclick=()=>perform(()=>loadSources({reset:true}));
$('#proposal').onsubmit=e=>{e.preventDefault();perform(async()=>{await createRecord(`/api/projects/${projectId}/candidates`,Object.fromEntries(new FormData(e.target)));message('候选已提交，等待负责人审批','#proposalFeedback');await load()},'#proposalFeedback')};
$('#sourceForm').onsubmit=e=>{e.preventDefault();perform(async()=>{const p=projectId,source=await createRecord(`/api/projects/${p}/sources`,Object.fromEntries(new FormData(e.target)));if(p!==projectId)return;selectSource(source);e.target.reset();message(`来源 #${source.id} 已保存并选为依据`,'#sourceFeedback');await load()},'#sourceFeedback')};
async function simulated(value,fragment){
  const p=projectId,page=await api(`/api/projects/${p}/sources?q=${encodeURIComponent(fragment)}&limit=1`);
  if(!page.sources.length)throw new Error('当前项目缺少此模拟场景的来源');
  await createRecord(`/api/projects/${p}/candidates`,{subject:'项目',predicate:'截止日',value,source_id:page.sources[0].id,expected_version:1});
  if(p===projectId){message('模拟客户端已提交候选，尚未改变当前事实');await load()}
}
$('#stale').onclick=()=>perform(()=>simulated('25号','会议纪要'));$('#injection').onclick=()=>perform(()=>simulated('30号','外部文档'));

$('#addSourceShortcut').onclick=e=>{e.preventDefault();$('#sourceForm').closest('details').open=true;$('#sourceForm [name=title]').focus()};
$('#backToProposal').onclick=e=>{e.preventDefault();$('#proposal [name=subject]').focus()};
