// Product HTTP adapter. No LLM, gold loader, extraction or approval operation.
'use strict';
const crypto=require('node:crypto'),fs=require('node:fs');
const {performance}=require('node:perf_hooks');
const {readContext}=require('../../../scripts/context-client');
const {createSource}=require('../../../scripts/source-client');
const fail=code=>Object.assign(new Error(code),{code});
const check=(ok,code)=>{if(!ok)throw fail(code)};
const canonical=x=>JSON.stringify(x&&typeof x==='object'?Array.isArray(x)?x.map(normalize):normalize(x):x);
function normalize(x){return x&&typeof x==='object'?Array.isArray(x)?x.map(normalize):Object.fromEntries(Object.keys(x).sort().map(k=>[k,normalize(x[k])])):x}
const hash=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
const bytesHash=x=>crypto.createHash('sha256').update(x).digest('hex');
const fields=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:/-]{1,100}$/.test(x);
const number=x=>Number.isInteger(x)&&x>0&&x<=2147483647;
const text=(x,max,empty=false)=>typeof x==='string'&&x.length<=max&&x.isWellFormed()&&!x.includes('\0')&&(empty||x.trim().length>0);
function immutable(value){for(const x of Object.values(value))if(x&&typeof x==='object')immutable(x);return Object.freeze(value)}
function seal(body){return immutable({...body,sha256:hash(body)})}
function verify(value,keys,kind){
  check(fields(value,[...keys,'sha256'])&&value.kind===kind,'INVALID_ARTIFACT');
  const {sha256,...body}=value;check(sha256===hash(body),'ARTIFACT_HASH_MISMATCH');return body;
}
function prepareHistory(history){
  check(fields(history,['scope','documents'])&&id(history.scope)&&Array.isArray(history.documents),'INVALID_HISTORY_FIELDS');
  check(history.documents.length>0&&history.documents.length<=100,'HISTORY_SIZE_LIMIT');
  const ids=new Set();
  const documents=history.documents.map(d=>{
    check(fields(d,['id','session_id','date','text'])&&id(d.id)&&id(d.session_id)
      &&(d.date===null||text(d.date,100,true))&&text(d.text,4000),'INVALID_HISTORY_DOCUMENT');
    check(!ids.has(d.id),'DUPLICATE_DOCUMENT');ids.add(d.id);
    return {...d};
  });
  return seal({kind:'memz-history-v1',scope:history.scope,documents});
}
function validatePrepared(value){
  const b=verify(value,['kind','scope','documents'],'memz-history-v1');
  check(prepareHistory({scope:b.scope,documents:b.documents}).sha256===value.sha256,'INVALID_PREPARED');return b;
}
function binding(value){
  check(fields(value,['baseURL','projectId'])&&number(value.projectId),'INVALID_BINDING');
  let u;try{u=new URL(value.baseURL)}catch{throw fail('INVALID_BINDING')}
  check(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)
    &&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash,'LOCAL_PRODUCT_REQUIRED');
  return {baseURL:u.origin,projectId:value.projectId};
}
function expectedSources(prepared){return prepared.documents.map(d=>({documentId:d.id,title:`memz history ${d.id}`,content:d.text.trim()}))}
function validateIngest(value){
  const b=verify(value,['kind','prepared','binding','sources'],'memz-ingested-v1');
  validatePrepared(b.prepared);binding(b.binding);
  check(Array.isArray(b.sources)&&b.sources.length===b.prepared.documents.length,'INVALID_SOURCE_MAP');
  const seen=new Set(),expected=expectedSources(b.prepared);
  b.sources.forEach((s,i)=>{
    check(fields(s,['documentId','sourceId','sourceSha256'])&&number(s.sourceId)&&!seen.has(s.sourceId)
      &&s.documentId===expected[i].documentId&&s.sourceSha256===hash({id:s.sourceId,title:expected[i].title,content:expected[i].content}),'INVALID_SOURCE_MAP');
    seen.add(s.sourceId);
  });return b;
}
function safeError(e){
  const code=typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.code)?e.code:'ADAPTER_FAILED';
  return {code,...(Number.isInteger(e?.status)?{httpStatus:e.status}:{}),
    ...(e?.outcome&&['not_attempted','unknown','rejected'].includes(e.outcome)?{outcome:e.outcome}:{})};
}
async function ingestHistory(prepared,target,writer={}){
  prepared=immutable(JSON.parse(canonical(prepared)));
  validatePrepared(prepared);target=binding(target);
  const start=performance.now(),sources=[];
  try{
    for(const d of expectedSources(prepared)){
      const receipt=await createSource({...writer,...target,source:{projectId:target.projectId,title:d.title,content:d.content,
        idempotencyKey:`memz-bench:${hash([prepared.sha256,target.projectId,d.documentId])}`}});
      check(receipt.sessionCleanup==='logged_out','SESSION_CLEANUP_FAILED');
      sources.push({documentId:d.documentId,sourceId:receipt.sourceId,sourceSha256:hash({id:receipt.sourceId,title:d.title,content:d.content})});
    }
    return {status:'prepared_for_review',artifact:seal({kind:'memz-ingested-v1',prepared,binding:target,sources}),
      elapsedMs:performance.now()-start,autoApproved:false,candidatesCreated:0,transportMode:writer.fetchImpl?'injected_test_transport':'product_http'};
  }catch(e){return {status:'error',error:safeError(e),completedSourceReceipts:sources,
    elapsedMs:performance.now()-start,autoApproved:false,candidatesCreated:0}};
}
function readerOptions(reader){
  check(fields(reader,['username','password'])&&text(reader.username,100)&&text(reader.password,8192),'INVALID_READER');
  return {...reader};
}
async function span(spans,stage,fn){
  const start=performance.now();let ok=false;
  try{const value=await fn();ok=true;return value}finally{spans.push({stage,elapsedMs:performance.now()-start,status:ok?'ok':'error'})}
}
// Bounded, freshly authenticated source page. Never reads/logs response errors.
async function sourceInventory(target,reader,fetchImpl){
  let cookie='',csrf='',problem,result;
  async function request(path,body){
    let response;try{response=await fetchImpl(new URL(path,target.baseURL),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json','x-csrf-token':csrf})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})})}catch{throw fail('REQUEST_FAILED')}
    if(!response.ok){await response.body?.cancel();throw Object.assign(fail(`HTTP_${response.status}`),{status:response.status})}
    const reader=response.body?.getReader();check(reader,'INVALID_RECEIPT');const chunks=[];let size=0;
    try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>1048576){await reader.cancel();throw fail('RESPONSE_TOO_LARGE')}chunks.push(Buffer.from(r.value))}}finally{reader.releaseLock()}
    let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)))}catch{throw fail('INVALID_RECEIPT')}
    if(path==='/api/login'){
      cookie=(response.headers.getSetCookie?.()||[response.headers.get('set-cookie')||'']).map(h=>h.split(';')[0]).find(h=>/^sid=[^;]+$/.test(h))||'';
      check(cookie&&typeof data.csrf==='string'&&data.csrf,'INVALID_LOGIN_RESPONSE');csrf=data.csrf;
    }return data;
  }
  try{
    await request('/api/login',reader);
    const page=await request(`/api/projects/${target.projectId}/sources?limit=100`);
    check(page&&['owner','member','viewer'].includes(page.role)&&Array.isArray(page.sources)&&page.sources.length<=100,'INVALID_SOURCE_RECEIPT');
    check(page.next_after===null,'SOURCE_PAGE_LIMIT');
    let previous=0;
    result=page.sources.map(s=>{check(number(s.id)&&s.id>previous&&text(s.title,150)&&text(s.content,4000),'INVALID_SOURCE_RECEIPT');previous=s.id;return {id:s.id,title:s.title,content:s.content}});
  }catch(e){problem=e}
  if(cookie)try{await request('/api/logout',{})}catch(e){problem=problem||e}
  if(problem)throw problem;return result;
}
async function state(ingested,reader,spans,prefix,fetchImpl){
  const facts=await span(spans,`${prefix}.approved_snapshot_with_auth`,async()=>{
    const c=await readContext({...ingested.binding,...reader,query:'',limit:25,provenanceMode:'snapshot',sourceMode:'inline',fetchImpl});
    check(!c.truncated&&c.nextAfter===null,'FACT_PAGE_LIMIT');return c.facts;
  });
  const sources=await span(spans,`${prefix}.source_inventory_with_auth`,()=>sourceInventory(ingested.binding,reader,fetchImpl));
  const byId=new Map(sources.map(s=>[s.id,s]));
  check(sources.length===ingested.sources.length,'UNREGISTERED_SOURCE');
  for(const s of ingested.sources)check(byId.has(s.sourceId)&&hash(byId.get(s.sourceId))===s.sourceSha256,'SOURCE_DRIFT');
  for(const f of facts)check(byId.has(f.source.id)&&hash(f.source)===hash(byId.get(f.source.id)),'PROVENANCE_SOURCE_DRIFT');
  return {facts,sources};
}
async function freezeApproved(ingested,reader,{fetchImpl=fetch}={}){
  const start=performance.now(),spans=[];
  try{
    ingested=immutable(JSON.parse(canonical(ingested)));validateIngest(ingested);reader=readerOptions(reader);
    const first=await state(ingested,reader,spans,'freeze_first',fetchImpl);
    const second=await state(ingested,reader,spans,'freeze_confirm',fetchImpl);
    check(hash(first)===hash(second),'FREEZE_DRIFT');
    return {status:'frozen',artifact:seal({kind:'memz-frozen-v1',ingested,readerPrincipal:reader.username,snapshot:first}),
      spans,elapsedMs:performance.now()-start,modelCalls:0,transportMode:fetchImpl===fetch?'product_http':'injected_test_transport'};
  }catch(e){return {status:'error',error:safeError(e),spans,elapsedMs:performance.now()-start,modelCalls:0}}
}
function validateFrozen(frozen,reader){
  const b=verify(frozen,['kind','ingested','readerPrincipal','snapshot'],'memz-frozen-v1');validateIngest(b.ingested);
  readerOptions(reader);check(b.readerPrincipal===reader.username,'READER_BINDING_MISMATCH');
  check(fields(b.snapshot,['facts','sources'])&&Array.isArray(b.snapshot.facts)&&Array.isArray(b.snapshot.sources),'INVALID_FROZEN_SNAPSHOT');
  return b;
}
function validateQuery(q,scope){
  check(q&&typeof q==='object'&&!Array.isArray(q)&&Object.keys(q).every(k=>['id','scope','question','date'].includes(k))
    &&['id','scope','question'].every(k=>Object.hasOwn(q,k))&&id(q.id)&&q.scope===scope
    &&text(q.question,200)&&(!Object.hasOwn(q,'date')||q.date===null||text(q.date,100,true)),'INVALID_QUERY_FIELDS');
}
function renderFacts(facts,ingested){
  const bySource=new Map(ingested.sources.map(s=>[s.sourceId,s.documentId]));
  const docs=new Map(ingested.prepared.documents.map(d=>[d.id,d]));
  return canonical({sourceTextIsUntrusted:true,facts:facts.map(f=>{
    const documentId=bySource.get(f.source.id),d=docs.get(documentId);check(d,'UNREGISTERED_SOURCE');
    return {...f,source:{...f.source,documentId,sessionId:d.session_id,date:d.date}};
  })});
}
async function queryFrozen(frozen,query,reader,{method='memz_current',maxContextBytes=262144,fetchImpl=fetch}={}){
  const start=performance.now(),spans=[];
  const row={status:'error',id:id(query?.id)?query.id:null,method:['memz_current','flat_same_facts'].includes(method)?method:null,modelCalls:0,answer:null,answerQuality:null,
    transportMode:fetchImpl===fetch?'product_http':'injected_test_transport',
    inputTokens:null,outputTokens:null,generationMs:null,answerE2EMs:null,context:null,retrievedDocumentIds:[],provenance:[],spans};
  try{
    frozen=immutable(JSON.parse(canonical(frozen)));query=JSON.parse(canonical(query));reader=readerOptions(reader);
    const b=validateFrozen(frozen,reader);validateQuery(query,b.ingested.prepared.scope);
    check(['memz_current','flat_same_facts'].includes(method),'INVALID_METHOD');
    check(Number.isInteger(maxContextBytes)&&maxContextBytes>0&&maxContextBytes<=1048576,'INVALID_CONTEXT_BUDGET');
    row.scope=query.scope;row.frozenSha256=frozen.sha256;row.querySha256=hash(query);
    const before=await state(b.ingested,reader,spans,'before',fetchImpl);
    check(hash(before)===hash(b.snapshot),'FROZEN_STATE_DRIFT');
    let facts;
    if(method==='memz_current')facts=await span(spans,'product_query_with_auth',async()=>{
      const c=await readContext({...b.ingested.binding,...reader,query:query.question,limit:25,
        provenanceMode:'snapshot',sourceMode:'inline',fetchImpl});
      check(!c.truncated&&c.nextAfter===null,'FACT_PAGE_LIMIT');return c.facts;
    });
    else facts=await span(spans,'flat_selection',async()=>before.facts.filter(f=>`${f.subject} ${f.predicate} ${f.value}`.toLowerCase().includes(query.question.toLowerCase())));
    const frozenFacts=new Map(before.facts.map(f=>[f.id,hash(f)]));
    for(const f of facts)check(frozenFacts.get(f.id)===hash(f),'QUERY_PROVENANCE_DRIFT');
    const after=await state(b.ingested,reader,spans,'after',fetchImpl);
    check(hash(after)===hash(b.snapshot),'FROZEN_STATE_DRIFT');
    const context=await span(spans,'assembly',async()=>renderFacts(facts,b.ingested));
    check(Buffer.byteLength(context)<=maxContextBytes,'CONTEXT_BUDGET_EXCEEDED');
    const sourceMap=new Map(b.ingested.sources.map(s=>[s.sourceId,s.documentId]));
    Object.assign(row,{status:'context_ready_no_generation',context,contextBytes:Buffer.byteLength(context),contextSha256:bytesHash(context),
      readerInput:{id:`${query.id}:${method}`,query:query.date?`Question date: ${query.date}\n${query.question}`:query.question,context},
      retrievedDocumentIds:[...new Set(facts.map(f=>sourceMap.get(f.source.id)))],
      provenance:facts.map(({id,version,revisionId,candidateId,source,approvedBy,proposedBy})=>({id,version,revisionId,candidateId,sourceId:source.id,approvedBy,proposedBy}))});
  }catch(e){row.error=safeError(e)}
  row.contextE2EMs=performance.now()-start;
  row.timingBoundary='validation + before state/auth + product query or flat selection + after state/auth + assembly; no generation';
  return row;
}
function readJSON(path){
  const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),buffer=Buffer.alloc(4194305);let size=0;
  try{check(fs.fstatSync(fd).isFile(),'INVALID_INPUT_FILE');while(size<buffer.length){const n=fs.readSync(fd,buffer,size,buffer.length-size,null);if(!n)break;size+=n}}
  finally{fs.closeSync(fd)}
  check(size<=4194304,'FILE_TOO_LARGE');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size)));
}
function writeJSON(path,value){fs.writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600})}
async function main(args){
  const [phase,input,output]=args;check(args.length===3&&['prepare','ingest','freeze','query'].includes(phase),'INVALID_ARGUMENTS');
  check(!fs.existsSync(output),'OUTPUT_EXISTS');const value=readJSON(input);let result;
  const reader={username:process.env.MEMZ_USERNAME||(phase==='ingest'?'member':'viewer'),password:process.env.MEMZ_PASSWORD||(phase==='ingest'?'demo-member':'demo-viewer')};
  if(phase==='prepare')result=prepareHistory(value);
  if(phase==='ingest')result=await ingestHistory(value,{baseURL:process.env.MEMZ_BASE_URL||'http://127.0.0.1:3000',projectId:Number(process.env.MEMZ_PROJECT_ID)},reader);
  if(phase==='freeze')result=await freezeApproved(value,reader);
  if(phase==='query'){
    check(fields(value,['frozen','queries'])&&Array.isArray(value.queries)&&value.queries.length<=20,'INVALID_QUERY_BATCH');
    validateFrozen(value.frozen,reader);const seen=new Set();
    for(const q of value.queries)if(id(q?.id)){check(!seen.has(q.id),'DUPLICATE_QUERY');seen.add(q.id)}
    result=[];for(const q of value.queries){const arms=['memz_current','flat_same_facts'];if(parseInt(hash(['42',id(q?.id)?q.id:null]).slice(0,2),16)%2)arms.reverse();
      for(const method of arms)result.push(await queryFrozen(value.frozen,q,reader,{method}));}
  }
  writeJSON(output,result);return result.status==='error'||Array.isArray(result)&&result.some(r=>r.status==='error')?1:0;
}
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.exitCode=code}).catch(e=>{console.error(JSON.stringify(safeError(e)));process.exitCode=1});
module.exports={prepareHistory,ingestHistory,freezeApproved,queryFrozen,validateQuery,canonical,hash,seal,main};
