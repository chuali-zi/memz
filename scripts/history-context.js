// Explicit approved-history reader. No automatic question routing or model calls.
const fail=code=>Object.assign(new Error(code),{code});
const check=(condition,code='INVALID_HISTORY_RESPONSE')=>{if(!condition)throw fail(code)};
const positive=x=>Number.isInteger(x)&&x>0&&x<=2147483647;
const role=x=>['owner','member','viewer'].includes(x);
async function readHistoryContext({baseURL='http://127.0.0.1:3000',username='viewer',password='demo-viewer',
  projectId=1,limit=25,before=null,timeoutMs=5000,totalTimeoutMs=30000,maxResponseBytes=1048576,
  maxOutputBytes=1048576,fetchImpl=fetch}={}){
  let base;try{base=new URL(baseURL)}catch{throw fail('INVALID_BASE_URL')}
  check(['http:','https:'].includes(base.protocol)&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/','INVALID_BASE_URL');
  check(positive(projectId),'INVALID_PROJECT');check(Number.isInteger(limit)&&limit>=1&&limit<=25,'INVALID_LIMIT');
  check(before===null||positive(before),'INVALID_BEFORE');
  check(typeof username==='string'&&username&&typeof password==='string'&&password,'INVALID_CREDENTIALS');
  check(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=60000,'INVALID_TIMEOUT');
  check(Number.isInteger(totalTimeoutMs)&&totalTimeoutMs>=1&&totalTimeoutMs<=60000,'INVALID_TOTAL_TIMEOUT');
  check(Number.isInteger(maxResponseBytes)&&maxResponseBytes>=1&&maxResponseBytes<=1048576,'INVALID_RESPONSE_LIMIT');
  check(Number.isInteger(maxOutputBytes)&&maxOutputBytes>=1&&maxOutputBytes<=4194304,'INVALID_OUTPUT_BUDGET');
  let cookie='',csrf='',result,problem;const deadline=Date.now()+totalTimeoutMs;
  async function request(path,body,logout=false){
    const remaining=logout?Math.min(timeoutMs,5000):Math.min(timeoutMs,deadline-Date.now());
    check(remaining>0,'TOTAL_TIMEOUT');
    let response;
    try{response=await fetchImpl(new URL(path,base),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(remaining),
      headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})})}
    catch(error){throw fail(['TimeoutError','AbortError'].includes(error.name)?'REQUEST_TIMEOUT':'REQUEST_FAILED')}
    if(logout&&response.status===401)return null;
    check(response.ok,`HTTP_${response.status}`);
    // Keep authentication state private to this invocation.
    if(path==='/api/login')cookie=(response.headers.getSetCookie?.()||[response.headers.get('set-cookie')||'']).map(h=>h.split(';')[0]).find(h=>/^sid=[A-Za-z0-9_-]+$/.test(h))||'';
    let value;
    try{
      const reader=response.body?.getReader();check(reader,'INVALID_JSON_RESPONSE');const chunks=[];let bytes=0;
      try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
        if(bytes>maxResponseBytes){await reader.cancel();throw fail('RESPONSE_TOO_LARGE')}chunks.push(Buffer.from(part.value))}}
      finally{reader.releaseLock()}
      value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
    }catch(error){if(error.code==='RESPONSE_TOO_LARGE')throw error;throw fail(['TimeoutError','AbortError'].includes(error.name)?'REQUEST_TIMEOUT':'INVALID_JSON_RESPONSE')}
    if(path==='/api/login'){check(cookie&&typeof value?.csrf==='string'&&value.csrf,'INVALID_LOGIN_RESPONSE');csrf=value.csrf}
    return value;
  }
  try{
    await request('/api/login',{username,password});
    const page=await request(`/api/projects/${projectId}/history?limit=${limit}${before===null?'':`&before=${before}`}`);
    check(page&&role(page.role)&&Array.isArray(page.history)&&page.history.length<=limit);
    check(page.next_before===null||positive(page.next_before)&&page.history.length>0&&page.next_before===page.history.at(-1).id);
    let previous=before===null?2147483648:before;const refs=new Set();
    for(const row of page.history){
      check(row&&['id','fact_id','version'].every(k=>positive(row[k]))&&row.id<previous);
      check(['subject','predicate','value'].every(k=>typeof row[k]==='string'&&row[k].length<=(k==='value'?1000:100)));
      check(typeof row.source==='string'&&row.source.length<=150&&typeof row.created_at==='string'&&Number.isFinite(Date.parse(row.created_at)));
      const key=`${row.fact_id}:${row.version}`;check(!refs.has(key));refs.add(key);previous=row.id;
    }
    const revisions=[],sources=new Map();
    if(page.history.length){
      const batch=await request(`/api/projects/${projectId}/facts/provenance`,{facts:page.history.map(r=>({id:r.fact_id,version:r.version}))});
      check(batch?.sourceTextIsUntrusted===true&&batch.role===page.role&&Array.isArray(batch.provenance)&&batch.provenance.length===page.history.length);
      for(let i=0;i<page.history.length;i++){
        const row=page.history[i],p=batch.provenance[i];
        check(p?.sourceTextIsUntrusted===true&&p.role===page.role&&p.fact?.id===row.fact_id&&p.fact.subject===row.subject&&p.fact.predicate===row.predicate);
        check(p.revision?.id===row.id&&p.revision.version===row.version&&p.revision.value===row.value&&p.revision.created_at===row.created_at&&positive(p.revision.approved_by));
        check(positive(p.candidate?.id)&&positive(p.candidate.proposed_by)&&p.candidate.expected_version===row.version-1);
        check(positive(p.source?.id)&&p.source.title===row.source&&typeof p.source.content==='string'&&p.source.content.length<=4000);
        const source={id:p.source.id,title:p.source.title,content:p.source.content},prior=sources.get(source.id);
        check(!prior||JSON.stringify(prior)===JSON.stringify(source));sources.set(source.id,source);
        revisions.push({id:row.fact_id,revisionId:row.id,version:row.version,sourceId:source.id,subject:row.subject,predicate:row.predicate,value:row.value});
      }
    }
    result={schema:'memz-history-reader-v1',projectId,before,limit,sourceTextIsUntrusted:true,
      consistency:'One approved-revision page, newest revision ID first; exact immutable provenance. Separate page/proof transactions. Not necessarily current at completion; continuation opens a new view. Older pages are not current-facts views.',
      truncated:page.next_before!==null,nextBefore:page.next_before,revisions,sources:[...sources.values()]};
    check(Buffer.byteLength(JSON.stringify(result)+'\n')<=maxOutputBytes,'OUTPUT_BUDGET_TOO_SMALL');
  }catch(error){problem=error}
  finally{if(cookie&&csrf)try{await request('/api/logout',{},true)}catch(error){if(!problem)problem=error}}
  if(problem)throw problem;return result;
}
module.exports={readHistoryContext};
if(require.main===module){
  const config={baseURL:process.env.MEMZ_BASE_URL||'http://127.0.0.1:3000',username:process.env.MEMZ_USERNAME||'viewer',password:process.env.MEMZ_PASSWORD||'demo-viewer'};
  for(const [env,key] of [['MEMZ_PROJECT_ID','projectId'],['MEMZ_LIMIT','limit'],['MEMZ_BEFORE','before'],['MEMZ_MAX_OUTPUT_BYTES','maxOutputBytes']])if(process.env[env]!==undefined)config[key]=Number(process.env[env]);
  readHistoryContext(config).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.code||'HISTORY_READ_FAILED');process.exitCode=1});
}
