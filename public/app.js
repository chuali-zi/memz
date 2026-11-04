let csrf='',projectId=null,data=null;const $=s=>document.querySelector(s);const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...opts.headers}});const v=await r.json();if(!r.ok){const error=new Error(`${r.status} ${v.error}`);error.status=r.status;throw error}return v}
const pendingCreations=new Map();
async function createRecord(path,body){
  const encoded=JSON.stringify(body),intent=JSON.stringify([path,encoded]);
  let key=pendingCreations.get(intent);
  if(!key){key=crypto.randomUUID();pendingCreations.set(intent,key)}
  try{
    const result=await api(path,{method:'POST',headers:{'Idempotency-Key':key},body:encoded});
    pendingCreations.delete(intent);return result;
  }catch(error){
    if(error.status>=400&&error.status<500)pendingCreations.delete(intent);
    throw error;
  }
}
function message(s){$('#notice').textContent=s}function rows(id,items,render){const root=$(id);root.replaceChildren();if(!items.length)root.append(el('p','暂无记录','hint'));for(const item of items){const d=el('div',undefined,'entry');render(d,item);root.append(d)}}
async function loadProjects(){const projects=await api('/api/projects');const select=$('#project');select.replaceChildren();projects.forEach(p=>{const o=el('option',`${p.name} · ${p.role}`);o.value=p.id;select.append(o)});projectId=Number(select.value);await load()}
let contextGeneration=0,factGeneration=0,factState={query:'',cursors:[0],index:0,next:null};
function factControls(busy=false){
  $('#facts').setAttribute('aria-busy',String(busy));
  $('#factsPrevious').disabled=busy||factState.index===0;
  $('#factsNext').disabled=busy||factState.next===null;
}
async function loadFacts({reset=false,index=factState.index,focus=false}={}){
  if(reset){factState={query:$('#searchForm').q.value,cursors:[0],index:0,next:null};index=0}
  const generation=++factGeneration,p=projectId,query=factState.query,after=factState.cursors[index];
  factControls(true);$('#facts').replaceChildren();$('#factsStatus').textContent='正在加载当前事实…';
  try{
    const page=await api(`/api/projects/${p}/facts?q=${encodeURIComponent(query)}&limit=50&after=${after}`);
    if(generation!==factGeneration||p!==projectId)return;
    factState.index=index;factState.next=page.next_after;
    factState.cursors=factState.cursors.slice(0,index+1);
    if(page.next_after!==null)factState.cursors.push(page.next_after);
    rows('#facts',page.facts,(d,f)=>d.append(el('strong',`${f.subject} / ${f.predicate}：${f.value}`),el('span',`v${f.version}`,'badge'),el('div',`依据：${f.source}`,'meta')));
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
        await api(`/api/projects/${p}/candidates/${c.id}/${action}`,{method:'POST'});
        if(p===projectId){message(`${label}成功`);await load()}
      }catch(e){
        if(e.status===409&&p===projectId)await load();
        throw e;
      }finally{for(const button of actions.querySelectorAll('button'))button.disabled=false}
    });actions.append(b);
  }
  d.append(actions);
}
async function loadCandidates({reset=false,index=candidateState.index,focus=false}={}){
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
async function load(){
  const generation=++contextGeneration,p=projectId;
  data=null;
  for(const id of ['#sources','#candidates','#history','#audit','#sourceSelect'])$(id).replaceChildren();
  for(const b of document.querySelectorAll('#proposal button,#sourceForm button,#stale,#injection'))b.disabled=true;
  const facts=loadFacts({reset:true}),history=loadHistory({reset:true}),candidates=loadCandidates({reset:true});
  try{
    const result=await api(`/api/projects/${p}/data?include_facts=false&include_history=false&include_candidates=false`);
    if(generation!==contextGeneration||p!==projectId)return;
    data=result;
    for(const b of document.querySelectorAll('#proposal button,#sourceForm button,#stale,#injection'))b.disabled=false;
    renderContext();
  }catch(e){if(generation===contextGeneration&&p===projectId)message(`工作台加载失败：${e.message}。请刷新重试。`)}
  await Promise.all([facts,history,candidates]);
}
function renderContext(){rows('#sources',data.sources,(d,s)=>{d.append(el('strong',`#${s.id} ${s.title}`),el('div',s.content,'meta'))});const sel=$('#sourceSelect');sel.replaceChildren();data.sources.forEach(s=>{const o=el('option',`#${s.id} ${s.title}`);o.value=s.id;sel.append(o)});rows('#audit',data.audit,(d,a)=>d.append(el('strong',a.action),el('div',`${a.detail} · 用户 ${a.actor_id} · ${new Date(a.created_at).toLocaleString()}`,'meta')))}
async function perform(fn){try{await fn()}catch(e){message(e.message)}}
$('#loginForm').username.onchange=e=>$('#loginForm').password.value=`demo-${e.target.value}`;
$('#loginForm').onsubmit=e=>{e.preventDefault();perform(async()=>{const f=new FormData(e.target);const x=await api('/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});csrf=x.csrf;message('');$('#login').hidden=true;$('#workspace').hidden=false;$('#identity').replaceChildren(document.createTextNode(x.name));const b=el('button','切换账号');b.onclick=()=>perform(async()=>{await api('/api/logout',{method:'POST'});location.reload()});$('#identity').append(b);await loadProjects()})};
$('#project').onchange=e=>{projectId=Number(e.target.value);perform(load)};$('#searchForm').onsubmit=e=>{e.preventDefault();perform(()=>loadFacts({reset:true}))};
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
$('#proposal').onsubmit=e=>{e.preventDefault();perform(async()=>{await createRecord(`/api/projects/${projectId}/candidates`,Object.fromEntries(new FormData(e.target)));message('候选已提交，等待负责人审批');await load()})};
$('#sourceForm').onsubmit=e=>{e.preventDefault();perform(async()=>{await createRecord(`/api/projects/${projectId}/sources`,Object.fromEntries(new FormData(e.target)));e.target.reset();message('来源已保存');await load()})};
async function simulated(value,source){await createRecord(`/api/projects/${projectId}/candidates`,{subject:'项目',predicate:'截止日',value,source_id:source,expected_version:1});message('模拟客户端已提交候选，尚未改变当前事实');await load()}
$('#stale').onclick=()=>perform(()=>simulated('25号',data.sources.find(s=>s.title.includes('会议纪要'))?.id));$('#injection').onclick=()=>perform(()=>simulated('30号',data.sources.find(s=>s.title.includes('外部文档'))?.id));
