// Read-only synthetic-demo client. No model calls and no external dependencies.
function failure(code,status){return Object.assign(new Error(code),{code,...(status===undefined?{}:{status})})}
function requireValue(condition,code){if(!condition)throw failure(code)}
const positive=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
async function readContext({baseURL='http://127.0.0.1:3000',username='viewer',password='demo-viewer',projectId=1,query='',limit=25,timeoutMs=5000,fetchImpl=fetch}={}){
  let base;try{base=new URL(baseURL)}catch{throw failure('INVALID_BASE_URL')}
  requireValue(['http:','https:'].includes(base.protocol)&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/','INVALID_BASE_URL');
  requireValue(positive(projectId),'INVALID_PROJECT');requireValue(Number.isInteger(limit)&&limit>=1&&limit<=100,'INVALID_LIMIT');
  requireValue(typeof query==='string'&&query.length<=200,'INVALID_QUERY');requireValue(typeof username==='string'&&username&&typeof password==='string'&&password,'INVALID_CREDENTIALS');
  requireValue(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=60000,'INVALID_TIMEOUT');
  let cookie='',csrf='',result,problem;
  async function request(path,{body,logout=false}={}){
    let response;
    try{response=await fetchImpl(new URL(path,base),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf})},...(body===undefined?{}:{body:JSON.stringify(body)})})}
    catch(error){throw failure(['AbortError','TimeoutError'].includes(error.name)?'REQUEST_TIMEOUT':'REQUEST_FAILED')}
    if(logout&&response.status===401)return null;
    if(!response.ok)throw failure(`HTTP_${response.status}`,response.status);
    let value;try{value=await response.json()}catch{throw failure('INVALID_JSON_RESPONSE')}
    if(path==='/api/login'){
      const headers=response.headers.getSetCookie?.()||[response.headers.get('set-cookie')||''];
      cookie=headers.map(header=>header.split(';')[0]).find(value=>/^sid=[^;]+$/.test(value))||'';
      requireValue(cookie&&typeof value?.csrf==='string'&&value.csrf,'INVALID_LOGIN_RESPONSE');csrf=value.csrf;
    }
    return value;
  }
  try{
    await request('/api/login',{body:{username,password}});
    const page=await request(`/api/projects/${projectId}/facts?q=${encodeURIComponent(query)}&limit=${limit}`);
    requireValue(page&&['owner','member','viewer'].includes(page.role)&&Array.isArray(page.facts)&&page.facts.length<=limit,'INVALID_FACTS_RESPONSE');
    requireValue(page.next_after===null||(positive(page.next_after)&&page.facts.length>0&&page.next_after===page.facts.at(-1).id),'INVALID_CURSOR_RESPONSE');
    const facts=[];let previousId=0;
    for(const fact of page.facts){
      requireValue(positive(fact.id)&&fact.id>previousId&&positive(fact.version)&&['subject','predicate','value'].every(key=>typeof fact[key]==='string'),'INVALID_FACT_RESPONSE');previousId=fact.id;
      const proof=await request(`/api/projects/${projectId}/facts/${fact.id}/provenance?version=${fact.version}`);
      requireValue(proof?.fact?.id===fact.id&&proof.fact.subject===fact.subject&&proof.fact.predicate===fact.predicate&&proof?.revision?.version===fact.version&&proof.revision.value===fact.value,'PROVENANCE_MISMATCH');
      requireValue(positive(proof.revision.id)&&positive(proof?.source?.id)&&typeof proof.source.title==='string'&&typeof proof.source.content==='string'&&positive(proof?.candidate?.id)&&positive(proof.candidate.proposed_by)&&positive(proof.revision.approved_by),'INVALID_PROVENANCE_RESPONSE');
      facts.push({id:fact.id,subject:fact.subject,predicate:fact.predicate,value:fact.value,version:fact.version,revisionId:proof.revision.id,source:{id:proof.source.id,title:proof.source.title,content:proof.source.content},candidateId:proof.candidate.id,proposedBy:proof.candidate.proposed_by,approvedBy:proof.revision.approved_by});
    }
    result={schemaVersion:1,projectId,query,limit,truncated:page.next_after!==null,nextAfter:page.next_after,sourceTextIsUntrusted:true,consistency:'One current-facts page; immutable provenance pinned to each returned version. Not necessarily current at completion.',facts};
  }catch(error){problem=error}
  if(cookie){try{await request('/api/logout',{body:{},logout:true})}catch(error){problem=problem||error}}
  if(problem)throw problem;return result;
}
if(require.main===module){
  readContext({baseURL:process.env.MEMZ_BASE_URL||'http://127.0.0.1:3000',username:process.env.MEMZ_USERNAME||'viewer',password:process.env.MEMZ_PASSWORD||'demo-viewer',projectId:process.env.MEMZ_PROJECT_ID===undefined?1:Number(process.env.MEMZ_PROJECT_ID),query:process.env.MEMZ_QUERY||'',limit:process.env.MEMZ_LIMIT===undefined?25:Number(process.env.MEMZ_LIMIT)})
    .then(context=>console.log(JSON.stringify(context,null,2))).catch(error=>{console.error(`Context read failed: ${error.code||'UNKNOWN_ERROR'}`);process.exitCode=1});
}
module.exports={readContext};
