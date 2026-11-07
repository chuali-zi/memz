let csrf='',projectId=null,data=null;const $=s=>document.querySelector(s);const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};
// Fixed browser request budget: headers and the complete JSON body share 15 seconds.
const REQUEST_TIMEOUT_MS=15000,MAX_RESPONSE_BYTES=1048576;
async function api(path,opts={}){
  let timedOut=false,reader;
  const controller=new AbortController(),timer=setTimeout(()=>{timedOut=true;controller.abort()},REQUEST_TIMEOUT_MS);
  const timeout=()=>new Error('请求超时（15秒），请稍后重试');
  try{
    let response;
    try{response=await fetch(path,{...opts,signal:controller.signal,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...opts.headers}})}
    catch(error){if(timedOut)throw timeout();throw new Error('网络连接失败，请检查连接后重试')}
    try{reader=response.body?.getReader()}catch{throw new Error('网络连接中断，未能完整读取响应，请稍后重试')}
    if(!reader)throw new Error('服务器响应不是有效 JSON，请稍后重试');
    const chunks=[];let bytes=0;
    while(true){
      let part;
      try{part=await reader.read()}catch{if(timedOut)throw timeout();throw new Error('网络连接中断，未能完整读取响应，请稍后重试')}
      if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>MAX_RESPONSE_BYTES)throw new Error('服务器响应超过 1 MiB，未接纳本次响应');
      chunks.push(part.value);
    }
    const encoded=new Uint8Array(bytes);let offset=0;
    for(const chunk of chunks){encoded.set(chunk,offset);offset+=chunk.byteLength}
    let text,value;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(encoded)}catch{throw new Error('服务器响应不是有效 UTF-8，请稍后重试')}
    try{value=JSON.parse(text)}catch{throw new Error('服务器响应不是有效 JSON，请稍后重试')}
    if(timedOut)throw timeout();
    if(!response.ok){
      if(!value||typeof value.error!=='string')throw new Error('服务器响应格式异常，请稍后重试');
      const error=new Error(`${response.status} ${value.error}`);error.status=response.status;throw error;
    }
    return value;
  }catch(error){
    // Abort the real fetch first; cancellation/lock cleanup cannot replace the
    // primary failure or turn a fully validated HTTP rejection into uncertainty.
    controller.abort();
    if(reader){try{await reader.cancel()}catch{}}
    throw error;
  }finally{
    clearTimeout(timer);
    if(reader){try{reader.releaseLock()}catch{}}
  }
}
const pendingCreations=new Map(),uncertainCreationKeys=new Set(),busyActions=new Set();
function validateCreationReceipt(path,body,result){
  const invalid=()=>{throw new Error('创建回执格式异常，请稍后重试')};
  const match=/^\/api\/projects\/([0-9]+)\/(sources|candidates)$/.exec(path);
  const integer=(value,min)=>{
    if(typeof value!=='number'&&!(typeof value==='string'&&/^[0-9]+$/.test(value)))invalid();
    const number=Number(value);if(!Number.isInteger(number)||number<min||number>2147483647)invalid();return number;
  };
  const text=(value,max)=>{if(!receiptText(value)||!value.trim()||value.length>max)invalid();return value.trim()};
  if(!match||!receiptRecord(body,[])||!receiptRecord(result,['id','project_id'])||!receiptId(result.id)||result.project_id!==integer(match[1],1))invalid();
  const fields=match[2]==='sources'?{title:150,content:4000}:{subject:100,predicate:100,value:1000};
  for(const [field,max] of Object.entries(fields))if(!Object.hasOwn(body,field)||!Object.hasOwn(result,field)||result[field]!==text(body[field],max))invalid();
  if(match[2]==='candidates'&&(!receiptRecord(body,['source_id','expected_version'])||!receiptRecord(result,['source_id','expected_version','status'])||result.source_id!==integer(body.source_id,1)||result.expected_version!==integer(body.expected_version,0)||result.status!=='pending'))invalid();
}
async function createRecord(path,body){
  const encoded=JSON.stringify(body),intent=JSON.stringify([path,encoded]);
  let key=pendingCreations.get(intent);
  if(!key){key=crypto.randomUUID();pendingCreations.set(intent,key)}
  try{
    const result=await api(path,{method:'POST',headers:{'Idempotency-Key':key},body:encoded});
    // Bind acceptance to the bytes sent, even if the caller edits its object
    // while the request is in flight. Unused server metadata is not evidence.
    validateCreationReceipt(path,JSON.parse(encoded),result);
    uncertainCreationKeys.delete(key);
    if(pendingCreations.get(intent)===key)pendingCreations.delete(intent);return result;
  }catch(error){
    const unknown=!error.status||error.status>=500;
    if(unknown&&pendingCreations.get(intent)===key)uncertainCreationKeys.add(key);
    const uncertain=unknown||uncertainCreationKeys.has(key);
    if(!uncertain&&error.status>=400&&error.status<500&&pendingCreations.get(intent)===key)pendingCreations.delete(intent);
    if(uncertain){
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

// These endpoints are not snapshot receipts: check the fields this page consumes,
// without inventing a project-name length or rejecting unused additive metadata.
function validateProjects(projects){
  const ids=new Set(),invalid=()=>{throw new Error('项目列表响应格式异常，请稍后重试')};
  if(!Array.isArray(projects))invalid();
  for(const project of projects){
    if(!project||typeof project!=='object'||Array.isArray(project)||!['id','name','role'].every(key=>Object.hasOwn(project,key))||!Number.isInteger(project.id)||project.id<1||project.id>2147483647||typeof project.name!=='string'||!['owner','member','viewer'].includes(project.role)||ids.has(project.id))invalid();
    ids.add(project.id);
  }
}
function validateWorkspaceBootstrap(result){
  if(!result||typeof result!=='object'||Array.isArray(result)||!Object.hasOwn(result,'role')||!Object.hasOwn(result,'sourceTextIsUntrusted')||!['owner','member','viewer'].includes(result.role)||result.sourceTextIsUntrusted!==true)throw new Error('工作台响应格式异常，请稍后重试');
  return {role:result.role,sourceTextIsUntrusted:true};
}

const receiptRecord=(value,fields)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&fields.every(field=>Object.hasOwn(value,field));
const receiptId=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
const receiptVersion=value=>Number.isInteger(value)&&value>=0&&value<=2147483647;
const receiptText=value=>typeof value==='string'&&value.isWellFormed()&&!value.includes('\u0000');
const receiptRole=value=>['owner','member','viewer'].includes(value);
function validateProvenance(proof,expected){
  const valid=condition=>{if(!condition)throw new Error('依据回执格式异常，请重试')};
  valid(receiptRecord(proof,['sourceTextIsUntrusted','role','fact','revision','source','candidate'])&&proof.sourceTextIsUntrusted===true&&receiptRole(proof.role));
  const {fact,revision,source,candidate}=proof;
  valid(receiptId(expected.id)&&receiptId(expected.version)&&receiptRecord(fact,['id','subject','predicate'])&&fact.id===expected.id&&fact.subject===expected.subject&&fact.predicate===expected.predicate&&receiptText(fact.subject)&&receiptText(fact.predicate));
  valid(receiptRecord(revision,['id','version','value','created_at','approved_by'])&&receiptId(revision.id)&&revision.version===expected.version&&revision.value===expected.value&&receiptText(revision.value)&&receiptId(revision.approved_by)&&typeof revision.created_at==='string'&&Number.isFinite(Date.parse(revision.created_at)));
  if(expected.revisionId!==undefined)valid(revision.id===expected.revisionId);
  valid(receiptRecord(source,['id','title','content'])&&receiptId(source.id)&&receiptText(source.title)&&receiptText(source.content));
  // The individual provenance endpoint does not echo source_id on candidate.
  valid(receiptRecord(candidate,['id','expected_version','proposed_by'])&&receiptId(candidate.id)&&candidate.expected_version===revision.version-1&&receiptId(candidate.proposed_by));
}
function validateCandidateComparison(proof,expected){
  const valid=condition=>{if(!condition)throw new Error('候选核对回执格式异常，请重试')};
  valid(receiptRecord(proof,['sourceTextIsUntrusted','role','candidate','source','current','comparison'])&&proof.sourceTextIsUntrusted===true&&receiptRole(proof.role));
  const {candidate,source,current,comparison}=proof;
  valid(receiptRecord(candidate,['id','subject','predicate','value','expected_version','status','source_id'])&&receiptId(candidate.id)&&candidate.id===expected.id&&['subject','predicate','value'].every(key=>receiptText(candidate[key])&&candidate[key]===expected[key])&&receiptVersion(candidate.expected_version)&&candidate.expected_version===expected.expected_version&&receiptId(candidate.source_id)&&candidate.source_id===expected.source_id&&['pending','approved','rejected'].includes(candidate.status));
  valid(receiptRecord(source,['id','title','content'])&&source.id===candidate.source_id&&receiptText(source.title)&&receiptText(source.content));
  valid(current===null||(receiptRecord(current,['fact_id','version','value','source_id','candidate_id','source_title'])&&receiptId(current.fact_id)&&receiptId(current.version)&&receiptText(current.value)&&receiptId(current.source_id)&&receiptId(current.candidate_id)&&receiptText(current.source_title)));
  const currentVersion=current===null?0:current.version;
  valid(receiptRecord(comparison,['expectedVersion','currentVersion','matches'])&&comparison.expectedVersion===candidate.expected_version&&comparison.currentVersion===currentVersion&&typeof comparison.matches==='boolean'&&comparison.matches===(candidate.expected_version===currentVersion));
  if(current?.source_id===source.id)valid(current.source_title===source.title);
  if(current?.candidate_id===candidate.id)valid(candidate.status==='approved'&&current.version===candidate.expected_version+1&&current.value===candidate.value&&current.source_id===candidate.source_id);
}

function validateLoginReceipt(result){
  // CSRF is opaque. Accept graphic ASCII unchanged as a header value, without
  // coupling the browser to the server's present 48-hex implementation.
  if(!receiptRecord(result,['name','csrf'])||!receiptText(result.name)||!result.name.trim()||typeof result.csrf!=='string'||!(/^[\x21-\x7e]+$/).test(result.csrf))throw new Error('登录回执格式异常，请重试登录');
  return {name:result.name,csrf:result.csrf};
}
function validateLogoutReceipt(result){
  if(!receiptRecord(result,['ok'])||result.ok!==true)throw new Error('退出回执格式异常，尚未确认退出，请重试');
}

async function switchAccount(){
  try{validateLogoutReceipt(await api('/api/logout',{method:'POST'}))}
  catch(error){if(error.status!==401)throw error}
  // An expired session is already logged out; let the user authenticate again.
  location.reload();
}
// Project IDs can repeat after navigation; bind mutations to this workspace visit.
let projectGeneration=0,workspaceGeneration=0,proposalSubmissionGeneration=0;
let projectReadEpoch=0,deniedWorkspace=null,roleWorkspace=null,acceptedRole=null;
async function loadProjects(){
  const generation=++projectGeneration;workspaceGeneration++;
  projectId=null;data=null;selectedSource=null;sourcePage=[];for(const id of ['#sourceFeedback','#proposalFeedback','#candidateFeedback'])message('',id);
  const select=$('#project');select.replaceChildren();
  // Refreshing accessible projects starts a new access boundary, even if the
  // response fails or is empty. Never retain the prior identity's interactions.
  factGeneration++;historyGeneration++;candidateGeneration++;sourceGeneration++;auditGeneration++;
  for(const root of ['facts','history','candidates','sources','audit']){
    $('#'+root).replaceChildren();$('#'+root).setAttribute('aria-busy','false');$('#'+root+'Status').textContent='';
    $('#'+root+'Previous').disabled=true;$('#'+root+'Next').disabled=true;
  }
  sourceOptions();
  for(const button of document.querySelectorAll('#proposal button,#sourceForm button,#stale,#injection'))button.disabled=true;
  message('正在加载项目…');
  try{
    const projects=await api('/api/projects');
    if(generation!==projectGeneration)return;
    validateProjects(projects);
    const options=document.createDocumentFragment();
    projects.forEach(p=>{const o=el('option',`${p.name} · ${p.role}`);o.value=p.id;o.dataset.projectName=p.name;options.append(o)});
    select.replaceChildren(options);
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
let detailFocusGeneration=0;
function appendProvenance(d,f,p){
  const workspace=workspaceGeneration;
  const button=el('button','查看依据','secondary'),panel=el('div',undefined,'provenance-detail');
  panel.hidden=true;panel.setAttribute('aria-live','polite');button.setAttribute('aria-expanded','false');
  let loaded=false,requestGeneration=0;
  button.onclick=async()=>{
    const focusGeneration=++detailFocusGeneration;
    if(loaded){panel.hidden=!panel.hidden;button.textContent=panel.hidden?'查看依据':'收起依据';button.setAttribute('aria-expanded',String(!panel.hidden));return}
    const request=++requestGeneration,access=projectReadEpoch;
    panel.hidden=false;button.disabled=true;button.setAttribute('aria-expanded','true');panel.textContent='正在读取该版本依据…';
    try{
      const proof=await api(`/api/projects/${p}/facts/${f.id}/provenance?version=${f.version}`);
      if(request!==requestGeneration||p!==projectId||workspace!==workspaceGeneration||!d.isConnected)return;
      validateProvenance(proof,f);
      panel.replaceChildren(el('p',`版本 v${proof.revision.version} · 修订 #${proof.revision.id} · 候选 #${proof.candidate.id}`,'meta'),el('strong',`来源 #${proof.source.id}：${proof.source.title}`),el('p',proof.source.content),el('p',`提议用户 ${proof.candidate.proposed_by} · 批准用户 ${proof.revision.approved_by}`,'meta'));
      loaded=true;button.textContent='收起依据';
    }catch(error){if(request===requestGeneration&&p===projectId&&workspace===workspaceGeneration&&d.isConnected){noteProjectRead403(error,p,workspace,access);panel.textContent=`依据读取失败：${error.message}。可点击重试。`;button.textContent='重试依据'}}
    finally{
      if(request===requestGeneration){
        button.disabled=false;
        if(focusGeneration===detailFocusGeneration&&p===projectId&&workspace===workspaceGeneration&&d.isConnected&&button.isConnected&&document.activeElement===document.body)button.focus();
      }
    }
  };
  d.append(button,panel);
}
async function loadFacts({reset=false,index=factState.index,focus=false}={}){
  if(projectId===null)return;
  if(factState.project!==projectId||factState.workspace!==workspaceGeneration){$('#facts').replaceChildren();factState={project:projectId,workspace:workspaceGeneration,query:'',cursors:[0],index:0,next:null};}
  const requested=reset?{project:projectId,workspace:workspaceGeneration,query:$('#searchForm').q.value,cursors:[0],index:0,next:null}:factState;
  if(reset)index=0;
  const generation=++factGeneration,p=projectId,query=requested.query,after=requested.cursors[index],workspace=workspaceGeneration,access=projectReadEpoch;
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
    noteProjectRead403(e,p,workspace,access);
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
  const generation=++historyGeneration,p=projectId,before=requested.cursors[index],workspace=workspaceGeneration,access=projectReadEpoch;
  historyControls(true);$('#historyStatus').textContent='正在加载版本历史…';
  try{
    const page=await api(`/api/projects/${p}/history?limit=25${before===null?'':`&before=${before}`}`);
    if(generation!==historyGeneration||p!==projectId)return;
    validatePage(page,'history','next_before');
    rows('#history',page.history,(d,h)=>{
      d.append(el('strong',`${h.subject} / ${h.predicate}：${h.value}`),el('span',`v${h.version}`,'badge'),el('div',`来源：${h.source} · ${new Date(h.created_at).toLocaleString()}`,'meta'));
      appendProvenance(d,{id:h.fact_id,subject:h.subject,predicate:h.predicate,value:h.value,version:h.version,revisionId:h.id},p);
    });
    historyState=requested;historyState.index=index;historyState.next=page.next_before;
    historyState.cursors=historyState.cursors.slice(0,index+1);
    if(page.next_before!==null)historyState.cursors.push(page.next_before);
    $('#historyStatus').textContent=page.history.length?`历史第 ${index+1} 页 · ${page.history.length} 条${page.next_before===null?' · 已到末页':''}`:'暂无版本历史';
    historyControls();if(focus)$('#historyTitle').focus();
  }catch(e){
    if(generation!==historyGeneration||p!==projectId)return;
    noteProjectRead403(e,p,workspace,access);
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
  const generation=++auditGeneration,p=projectId,before=requested.cursors[index],workspace=workspaceGeneration,access=projectReadEpoch;
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
    noteProjectRead403(e,p,workspace,access);
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
  const workspace=workspaceGeneration;
  d.append(el('strong',`${c.subject} / ${c.predicate} → ${c.value}`),el('span',({pending:'待审批',approved:'已批准',rejected:'已驳回'})[c.status],'badge'),el('div',`#${c.id} · 基于 v${c.expected_version} · 来源：${c.source}`,'meta'));
  const preview=el('button','核对来源原文','secondary'),panel=el('div',undefined,'provenance-detail');
  panel.hidden=true;panel.setAttribute('aria-live','polite');preview.setAttribute('aria-expanded','false');let loaded=false,requestGeneration=0;
  preview.onclick=async event=>{
    const focusGeneration=++detailFocusGeneration,refreshFocus=event?.refreshFocus===true;
    if(loaded){panel.hidden=!panel.hidden;preview.textContent=panel.hidden?'核对来源原文':'收起来源原文';preview.setAttribute('aria-expanded',String(!panel.hidden));return}
    const request=++requestGeneration,access=projectReadEpoch;
    panel.hidden=false;preview.disabled=true;preview.setAttribute('aria-expanded','true');panel.textContent='正在读取候选绑定的来源…';
    try{
      const proof=await api(`/api/projects/${p}/candidates/${c.id}/source`);
      if(request!==requestGeneration||p!==projectId||workspace!==workspaceGeneration||!d.isConnected)return;
      validateCandidateComparison(proof,c);
      const comparison=proof.comparison;
      const sameContent=proof.current?.value===proof.candidate.value&&proof.current?.source_id===proof.candidate.source_id;
      const status=proof.candidate.status==='pending'?(sameContent?'当前事实已采用相同值与同一来源；本候选仍待审，不代表已处理。请核对当前批准记录，避免重复提议；负责人可另行驳回旧候选。':comparison.matches?'读取时基于版本一致；批准时仍会再次校验。':`版本不一致：提议基于 v${comparison.expectedVersion}，读取时当前 v${comparison.currentVersion}。请核对后重新提议或驳回，不能直接覆盖。`):'该候选已处理；以下为读取时的当前事实，不是当时审批结果。';
      const refresh=el('button','刷新核对','secondary');refresh.onclick=async()=>{loaded=false;await preview.onclick({refreshFocus:true})};
      panel.replaceChildren(el('strong',`提议值：${proof.candidate.value}`),el('p',proof.current?`读取时当前值：${proof.current.value} · v${proof.current.version} · 批准候选 #${proof.current.candidate_id} · 来源 #${proof.current.source_id}：${proof.current.source_title}`:'读取时暂无已批准事实（v0）'),el('p',status,'hint'),refresh,el('strong',`来源 #${proof.source.id}：${proof.source.title}`),el('p',proof.source.content),el('p',`候选 #${proof.candidate.id} · 基于 v${proof.candidate.expected_version} · 读取时${({pending:'待审批',approved:'已批准',rejected:'已驳回'})[proof.candidate.status]}`,'meta'),el('p','原文仅供人工核查，不是审批结论。','hint'));
      if(proof.candidate.status==='pending'&&!sameContent&&!comparison.matches&&['owner','member'].includes(proof.role)){
        const prepare=el('button','用最新版本填写新候选','secondary');
        prepare.dataset.mutation='write';
        panel.append(el('p','将替换候选表单内容；不会自动提交或删除原提案。','hint'),prepare);
        prepare.onclick=()=>perform(async()=>{
          prepare.disabled=true;prepare.setAttribute('aria-busy','true');
          const form=$('#proposal'),draft=JSON.stringify(Object.fromEntries(new FormData(form))),submission=proposalSubmissionGeneration;
          try{
            const problem=writeProblem(false,p,workspace,true);if(problem)throw new Error(problem);
            if(busyActions.has('#proposal'))throw new Error('候选正在提交，表单内容已保留；请等待结果后再填写新候选');
            let latest;const access=projectReadEpoch;
            try{latest=await api(`/api/projects/${p}/candidates/${c.id}/source`)}catch(error){if(p===projectId&&workspace===workspaceGeneration&&d.isConnected)noteProjectRead403(error,p,workspace,access);throw error}
            if(p!==projectId||workspace!==workspaceGeneration||!d.isConnected)return;
            validateCandidateComparison(latest,c);
            const currentProblem=writeProblem(false,p,workspace,true);if(currentProblem)throw new Error(currentProblem);
            if(!['owner','member'].includes(latest.role)||latest.candidate.status!=='pending'||latest.comparison.matches)throw new Error('候选状态或权限已变化，请刷新核对后再操作');
            if(latest.current?.value===latest.candidate.value&&latest.current?.source_id===latest.candidate.source_id)throw new Error('当前事实已采用相同值与同一来源，请刷新核对；原候选仍待处理');
            if(busyActions.has('#proposal')||submission!==proposalSubmissionGeneration)throw new Error('读取期间候选发生提交，原表单内容已保留；请先核对提交结果后再操作');
            if(JSON.stringify(Object.fromEntries(new FormData(form)))!==draft)throw new Error('读取期间候选草稿已修改，已保留新草稿；如仍需替换，请再次点击填写新候选');
            for(const name of ['subject','predicate','value'])form.elements[name].value=latest.candidate[name];
            form.elements.expected_version.value=latest.comparison.currentVersion;
            selectSource(latest.source);
            message(`已用读取时 v${latest.comparison.currentVersion} 填写新候选；尚未提交。原候选 #${c.id} 保留，请确认内容和依据后提交。`,'#proposalFeedback');
            form.elements.value.focus();
          }finally{prepare.setAttribute('aria-busy','false');writeControls()}
        },'#candidateFeedback');
      }
      loaded=true;preview.textContent='收起来源原文';writeControls();
    }catch(error){if(request===requestGeneration&&p===projectId&&workspace===workspaceGeneration&&d.isConnected){noteProjectRead403(error,p,workspace,access);panel.textContent=`来源读取失败：${error.message}。可点击重试。`;preview.textContent='重试来源原文'}}
    finally{
      if(request===requestGeneration){
        preview.disabled=false;
        const target=refreshFocus?(panel.querySelector('button')||preview):preview;
        if(focusGeneration===detailFocusGeneration&&p===projectId&&workspace===workspaceGeneration&&d.isConnected&&target.isConnected&&document.activeElement===document.body)target.focus();
      }
    }
  };
  d.append(preview,panel);
  if(c.status!=='pending'||role!=='owner')return;
  const actions=el('div',undefined,'actions');
  for(const [label,action] of [['批准','approve'],['驳回','reject']]){
    const b=el('button',label,action==='reject'?'secondary':'');
    b.dataset.mutation='owner';
    b.onclick=()=>perform(async()=>{
      const problem=writeProblem(true,p,workspace,true);if(problem)throw new Error(problem);
      for(const button of actions.querySelectorAll('button')){button.disabled=true;button.setAttribute('aria-busy','true')}
      try{
        const result=await api(`/api/projects/${p}/candidates/${c.id}/${action}`,{method:'POST'});
        if(p===projectId&&workspace===workspaceGeneration){
          await load();
          if(p===projectId&&workspace===workspaceGeneration){message(action==='approve'?`批准成功：本次生成 v${result.version}，当前事实已更新；旧版本保留在历史中。`:'驳回成功：候选保留为已驳回，本次操作未修改当前事实。','#candidateFeedback');$('#candidateFeedback').focus()}
        }
      }catch(e){
        if(e.status===409&&p===projectId&&workspace===workspaceGeneration)await load();
        throw e;
      }finally{for(const button of actions.querySelectorAll('button'))button.setAttribute('aria-busy','false');writeControls()}
    },'#candidateFeedback');actions.append(b);
  }
  d.append(actions);
}
async function loadCandidates({reset=false,index=candidateState.index,focus=false}={}){
  if(projectId===null)return;
  if(candidateState.project!==projectId||candidateState.workspace!==workspaceGeneration){$('#candidates').replaceChildren();candidateState={project:projectId,workspace:workspaceGeneration,status:'all',cursors:[null],index:0,next:null};}
  const requested=reset?{project:projectId,workspace:workspaceGeneration,status:$('#candidateFilter').value,cursors:[null],index:0,next:null}:candidateState;
  if(reset)index=0;
  const generation=++candidateGeneration,p=projectId,before=requested.cursors[index],status=requested.status,workspace=workspaceGeneration,access=projectReadEpoch;
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
    candidateControls();writeControls();if(focus)$('#candidatesTitle').focus();
  }catch(e){
    if(generation!==candidateGeneration||p!==projectId)return;
    noteProjectRead403(e,p,workspace,access);
    $('#candidatesStatus').textContent=`候选加载失败：${e.message}。本次未更新列表，已加载的页面和翻页范围保留。请刷新候选重试。`;
    $('#candidateFilter').value=candidateState.status;candidateControls();
  }
}
let sourceGeneration=0,sourceState={project:null,workspace:null,query:'',cursors:[0],index:0,next:null},sourcePage=[],selectedSource=null;
function writeProblem(ownerOnly=false,p=projectId,workspace=workspaceGeneration,retained=false){
  if(p===null||p!==projectId||workspace!==workspaceGeneration)return '工作区已变化，请重新核对后操作';
  if(deniedWorkspace===workspace)return '本次项目读取被拒绝，变更操作已暂停，草稿已保留；请刷新工作台重新确认';
  const role=roleWorkspace===workspace?acceptedRole:null;
  if(role==='viewer')return '当前项目为只读，草稿已保留；不能提交或审批';
  if((!data&&!retained)||!(ownerOnly?role==='owner':['owner','member'].includes(role)))return '当前角色或权限尚未确认，请刷新工作台后再操作';
  return '';
}
function noteProjectRead403(error,p,workspace,access){
  if(error.status!==403||p!==projectId||workspace!==workspaceGeneration||access!==projectReadEpoch)return;
  deniedWorkspace=workspace;projectReadEpoch++;data=null;writeControls();
}
function writeControls(){
  const problem=writeProblem();
  $('#sourceForm button').disabled=!!problem||busyActions.has('#sourceForm');
  for(const id of ['#stale','#injection'])$(id).disabled=!!problem||busyActions.has(id);
  $('#proposal button').disabled=!!problem||!selectedSource||selectedSource.project!==projectId||busyActions.has('#proposal');
  for(const button of document.querySelectorAll('#candidates button[data-mutation]'))button.disabled=button.getAttribute('aria-busy')==='true'||!!writeProblem(button.dataset.mutation==='owner',projectId,workspaceGeneration,true);
  let cue=$('#projectAccess');if(!cue){cue=el('span','','hint');cue.id='projectAccess';cue.setAttribute('role','status');$('#project').parentElement.append(cue)}
  const role=roleWorkspace===workspaceGeneration?acceptedRole:null,denied=deniedWorkspace===workspaceGeneration,option=$('#project').selectedOptions[0];
  cue.textContent=projectId===null?'':denied?'本次项目读取被拒绝；旧页面和草稿已保留，变更入口已暂停。请刷新工作台重新确认。':role==='viewer'?'上次确认角色：只读 viewer。草稿已保留，不能提交或审批。':role?`上次确认角色：${role}。权限由服务端逐次核查。`:'正在确认当前项目权限…';
  if(option)option.textContent=`${option.dataset.projectName} · ${denied?'读取被拒绝':role==='viewer'?'只读 viewer':role||'权限待确认'}`;
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
  const generation=++sourceGeneration,p=projectId,query=requested.query,after=requested.cursors[index],workspace=workspaceGeneration,access=projectReadEpoch;
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
    noteProjectRead403(e,p,workspace,access);
    $('#sourcesStatus').textContent=`来源加载失败：${e.message}。本次未更新列表，已加载的页面和翻页范围保留。请刷新来源重试。`;
    sourceControls();
  }
}
async function load({recoverAccess=false}={}){
  if(projectId===null)return loadProjects();
  if(recoverAccess)projectReadEpoch++;
  const generation=++contextGeneration,p=projectId,workspace=workspaceGeneration,access=projectReadEpoch;
  data=null;writeControls();
  const facts=loadFacts({reset:true}),history=loadHistory({reset:true}),candidates=loadCandidates({reset:true}),sources=loadSources({reset:true}),audit=loadAudit({reset:true});
  try{
    const result=await api(`/api/projects/${p}/data?include_facts=false&include_history=false&include_candidates=false&include_sources=false&include_audit=false`);
    if(generation!==contextGeneration||p!==projectId)return;
    if(access===projectReadEpoch){
      data=validateWorkspaceBootstrap(result);acceptedRole=data.role;roleWorkspace=workspace;
      if(recoverAccess)deniedWorkspace=null;
      // An automatic read cannot resolve an access denial or erase its error;
      // a resolved read failure also cannot clear a newer action's message.
      if(deniedWorkspace!==workspace){
        if(workspaceProblem?.workspace===workspaceGeneration&&workspaceProblem.project===p&&workspaceProblem.notice===noticeGeneration)message('');
        workspaceProblem=null;
      }
      writeControls();
    }
  }catch(e){if(generation===contextGeneration&&p===projectId){noteProjectRead403(e,p,workspace,access);workspaceProblem={project:p,workspace:workspaceGeneration,notice:message(`工作台加载失败：${e.message}。请刷新重试。`)}}}
  await Promise.all([facts,history,candidates,sources,audit]);
}
async function perform(fn,feedback=null){
  const p=projectId,workspace=workspaceGeneration;
  if(feedback){message('');message('',feedback)}
  try{await fn()}catch(e){
    if(p===projectId&&workspace===workspaceGeneration){
      message(e.message,feedback||'#notice');
      // A late failure is announced by the live region. Only recover lost
      // focus; the user may already be editing a draft or using another control.
      if(feedback&&document.activeElement===document.body)$(feedback).focus();
    }
  }
}
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
    if(target==='#loginForm')button.disabled=false;
    else if(target==='#switchAccount'){
      button.disabled=false;
      if(p===projectId&&workspace===workspaceGeneration&&document.activeElement===document.body&&button.isConnected)button.focus();
    }else writeControls();
  }
}
$('#loginForm').username.onchange=e=>$('#loginForm').password.value=`demo-${e.target.value}`;
$('#loginForm').onsubmit=e=>{e.preventDefault();submitOnce('#loginForm',async()=>{
  const f=new FormData(e.target),x=validateLoginReceipt(await api('/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))}));
  csrf=x.csrf;message('');if($('#login').contains(document.activeElement))document.activeElement.blur();$('#login').hidden=true;$('#workspace').hidden=false;$('#identity').replaceChildren(document.createTextNode(x.name));
  const b=el('button','切换账号');b.id='switchAccount';b.onclick=()=>submitOnce('#switchAccount',switchAccount,{progress:'正在退出当前账号…'});$('#identity').append(b);
  const projects=loadProjects(),workspace=workspaceGeneration;await projects;
  // Hiding the login form leaves keyboard focus on BODY; respect any later user focus.
  if(workspace===workspaceGeneration&&document.activeElement===document.body)(projectId===null||!data?$('#refreshWorkspace'):$('#project')).focus();
},{progress:'正在登录…'})};
$('#project').onchange=e=>{workspaceGeneration++;for(const id of ['#notice','#sourceFeedback','#proposalFeedback','#candidateFeedback'])message('',id);projectId=Number(e.target.value);selectedSource=null;sourcePage=[];$('#sourceSearchForm').q.value='';perform(load)};$('#searchForm').onsubmit=e=>{e.preventDefault();perform(()=>loadFacts({reset:true}))};
$('#factsPrevious').onclick=()=>perform(()=>loadFacts({index:factState.index-1,focus:true}));
$('#factsNext').onclick=()=>perform(()=>loadFacts({index:factState.index+1,focus:true}));
$('#refreshWorkspace').onclick=()=>perform(()=>load({recoverAccess:true}));
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
$('#proposal').onsubmit=e=>{e.preventDefault();submitOnce('#proposal',async()=>{const p=projectId,workspace=workspaceGeneration,problem=writeProblem();if(problem)throw new Error(problem);proposalSubmissionGeneration++;await createRecord(`/api/projects/${p}/candidates`,Object.fromEntries(new FormData(e.target)));if(p!==projectId||workspace!==workspaceGeneration)return;message('候选已提交，等待负责人审批','#proposalFeedback');await load()},{feedback:'#proposalFeedback',progress:'正在提交候选…'})};
$('#sourceForm').onsubmit=e=>{e.preventDefault();submitOnce('#sourceForm',async()=>{const p=projectId,workspace=workspaceGeneration,problem=writeProblem();if(problem)throw new Error(problem);const body=Object.fromEntries(new FormData(e.target)),source=await createRecord(`/api/projects/${p}/sources`,body);if(p!==projectId||workspace!==workspaceGeneration)return;selectSource(source);if(JSON.stringify(Object.fromEntries(new FormData(e.target)))===JSON.stringify(body))e.target.reset();message(`来源 #${source.id} 已保存并选为依据`,'#sourceFeedback');await load()},{feedback:'#sourceFeedback',progress:'正在保存来源…'})};
async function simulated(value,fragment){
  const p=projectId,workspace=workspaceGeneration,problem=writeProblem();if(problem)throw new Error(problem);
  let page;const access=projectReadEpoch;
  try{page=await api(`/api/projects/${p}/sources?q=${encodeURIComponent(fragment)}&limit=1`)}catch(error){noteProjectRead403(error,p,workspace,access);throw error}
  if(p!==projectId||workspace!==workspaceGeneration)return;
  const currentProblem=writeProblem();if(currentProblem)throw new Error(currentProblem);
  if(!page.sources.length)throw new Error('当前项目缺少此模拟场景的来源');
  await createRecord(`/api/projects/${p}/candidates`,{subject:'项目',predicate:'截止日',value,source_id:page.sources[0].id,expected_version:1});
  if(p===projectId&&workspace===workspaceGeneration){message('模拟客户端已提交候选，尚未改变当前事实');await load()}
}
$('#stale').onclick=()=>submitOnce('#stale',()=>simulated('25号','会议纪要'),{progress:'正在提交模拟候选…'});$('#injection').onclick=()=>submitOnce('#injection',()=>simulated('30号','外部文档'),{progress:'正在提交模拟候选…'});

$('#addSourceShortcut').onclick=e=>{e.preventDefault();$('#sourceForm').closest('details').open=true;$('#sourceForm [name=title]').focus()};
$('#backToProposal').onclick=e=>{e.preventDefault();$('#proposal [name=subject]').focus()};
