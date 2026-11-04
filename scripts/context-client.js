// Read-only synthetic-demo client. No model calls and no external dependencies.
function failure(code,status){return Object.assign(new Error(code),{code,...(status===undefined?{}:{status})})}
function requireValue(condition,code){if(!condition)throw failure(code)}
const positive=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
async function readContext({baseURL='http://127.0.0.1:3000',username='viewer',password='demo-viewer',projectId=1,query='',limit=25,timeoutMs=5000,totalTimeoutMs=30000,maxResponseBytes=1048576,fetchImpl=fetch}={}){
  let base;try{base=new URL(baseURL)}catch{throw failure('INVALID_BASE_URL')}
  requireValue(['http:','https:'].includes(base.protocol)&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/','INVALID_BASE_URL');
  requireValue(positive(projectId),'INVALID_PROJECT');requireValue(Number.isInteger(limit)&&limit>=1&&limit<=100,'INVALID_LIMIT');
  requireValue(typeof query==='string'&&query.length<=200,'INVALID_QUERY');requireValue(typeof username==='string'&&username&&typeof password==='string'&&password,'INVALID_CREDENTIALS');
  requireValue(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=60000,'INVALID_TIMEOUT');
  requireValue(Number.isInteger(totalTimeoutMs)&&totalTimeoutMs>=1&&totalTimeoutMs<=60000,'INVALID_TOTAL_TIMEOUT');
  requireValue(Number.isInteger(maxResponseBytes)&&maxResponseBytes>=1&&maxResponseBytes<=1048576,'INVALID_RESPONSE_LIMIT');
  const deadline=Date.now()+totalTimeoutMs;
  let cookie='',csrf='',result,problem;
  async function request(path,{body,logout=false}={}){
    const remaining=logout?Math.min(timeoutMs,5000):Math.min(timeoutMs,deadline-Date.now());
    if(remaining<=0)throw failure('TOTAL_TIMEOUT');
    let response;
    try{response=await fetchImpl(new URL(path,base),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(remaining),headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf})},...(body===undefined?{}:{body:JSON.stringify(body)})})}
    catch(error){throw failure(['AbortError','TimeoutError'].includes(error.name)?'REQUEST_TIMEOUT':'REQUEST_FAILED')}
    if(logout&&response.status===401)return null;
    if(!response.ok)throw failure(`HTTP_${response.status}`,response.status);
    let value;
    try{
      const reader=response.body?.getReader();requireValue(reader,'INVALID_JSON_RESPONSE');
      const chunks=[];let bytes=0;
      try{
        while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
          if(bytes>maxResponseBytes){await reader.cancel();throw failure('RESPONSE_TOO_LARGE')}
          chunks.push(Buffer.from(part.value));
        }
      }finally{reader.releaseLock()}
      value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
    }catch(error){
      if(error.code==='RESPONSE_TOO_LARGE')throw error;
      throw failure(['AbortError','TimeoutError'].includes(error.name)?'REQUEST_TIMEOUT':'INVALID_JSON_RESPONSE');
    }
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
      requireValue(positive(fact.id)&&fact.id>previousId&&positive(fact.version)&&['subject','predicate','value'].every(key=>typeof fact[key]==='string'&&fact[key].length<=(key==='value'?1000:100)),'INVALID_FACT_RESPONSE');previousId=fact.id;
      const proof=await request(`/api/projects/${projectId}/facts/${fact.id}/provenance?version=${fact.version}`);
      requireValue(proof?.fact?.id===fact.id&&proof.fact.subject===fact.subject&&proof.fact.predicate===fact.predicate&&proof?.revision?.version===fact.version&&proof.revision.value===fact.value,'PROVENANCE_MISMATCH');
      requireValue(positive(proof.revision.id)&&positive(proof?.source?.id)&&typeof proof.source.title==='string'&&proof.source.title.length<=150&&typeof proof.source.content==='string'&&proof.source.content.length<=4000&&positive(proof?.candidate?.id)&&positive(proof.candidate.proposed_by)&&positive(proof.revision.approved_by),'INVALID_PROVENANCE_RESPONSE');
      facts.push({id:fact.id,subject:fact.subject,predicate:fact.predicate,value:fact.value,version:fact.version,revisionId:proof.revision.id,source:{id:proof.source.id,title:proof.source.title,content:proof.source.content},candidateId:proof.candidate.id,proposedBy:proof.candidate.proposed_by,approvedBy:proof.revision.approved_by});
    }
    result={schemaVersion:1,projectId,query,limit,truncated:page.next_after!==null,nextAfter:page.next_after,sourceTextIsUntrusted:true,consistency:'One current-facts page; immutable provenance pinned to each returned version. Not necessarily current at completion.',facts};
  }catch(error){problem=error}
  if(cookie){try{await request('/api/logout',{body:{},logout:true})}catch(error){problem=problem||error}}
  if(problem)throw problem;return result;
}
async function stdinRequest(){
  const bytes=await new Promise((resolve,reject)=>{
    const chunks=[];let size=0,finished=false;
    const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);process.stdin.removeAllListeners('data');process.stdin.removeAllListeners('end');process.stdin.removeAllListeners('error');if(error){process.stdin.destroy();reject(error)}else resolve(Buffer.concat(chunks,size))};
    const timer=setTimeout(()=>done(failure('INPUT_TIMEOUT')),5000);
    process.stdin.on('data',chunk=>{size+=chunk.length;if(size>16384)return done(failure('INPUT_TOO_LARGE'));chunks.push(chunk)});
    process.stdin.on('end',()=>done());process.stdin.on('error',()=>done(failure('INPUT_FAILED')));
  });
  let request;try{request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw failure('INVALID_STDIN_JSON')}
  requireValue(request&&typeof request==='object'&&!Array.isArray(request)&&Object.keys(request).every(key=>['projectId','query','limit'].includes(key)),'INVALID_STDIN_REQUEST');
  return request;
}
async function main(){
  requireValue(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--stdin'),'INVALID_ARGUMENTS');
  const request=process.argv[2]==='--stdin'?await stdinRequest():{};
  const context=await readContext({baseURL:process.env.MEMZ_BASE_URL||'http://127.0.0.1:3000',username:process.env.MEMZ_USERNAME||'viewer',password:process.env.MEMZ_PASSWORD||'demo-viewer',projectId:process.env.MEMZ_PROJECT_ID===undefined?1:Number(process.env.MEMZ_PROJECT_ID),query:process.env.MEMZ_QUERY||'',limit:process.env.MEMZ_LIMIT===undefined?25:Number(process.env.MEMZ_LIMIT),...request});
  console.log(JSON.stringify(context,null,2));
}
if(require.main===module)main().catch(error=>{console.error(`Context read failed: ${error.code||'UNKNOWN_ERROR'}`);process.exitCode=1});
module.exports={readContext};
