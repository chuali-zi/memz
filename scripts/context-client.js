// Read-only synthetic-demo client. No model calls and no external dependencies.
const {parseSearchQuery,matchesSearchMetadata}=require('./search-query');
const {SNAPSHOT_DESCRIPTION,snapshotReceipt,validateSnapshot}=require('./context-snapshot');
const {withReadSession}=require('./read-session');
function failure(code,status){return Object.assign(new Error(code),{code,...(status===undefined?{}:{status})})}
function requireValue(condition,code){if(!condition)throw failure(code)}
const serializeContext=value=>JSON.stringify(value,null,2)+'\n';
const positive=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
async function readContext({baseURL='http://127.0.0.1:3000',username='viewer',password='demo-viewer',projectId=1,query='',limit=25,after=0,timeoutMs=5000,totalTimeoutMs=30000,maxResponseBytes=1048576,maxOutputBytes,provenanceMode='individual',sourceMode='inline',searchMode='substring',fetchImpl=fetch}={}){
  let base;try{base=new URL(baseURL)}catch{throw failure('INVALID_BASE_URL')}
  requireValue(['http:','https:'].includes(base.protocol)&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/','INVALID_BASE_URL');
  requireValue(after===0||positive(after),'INVALID_AFTER');
  requireValue(positive(projectId),'INVALID_PROJECT');requireValue(Number.isInteger(limit)&&limit>=1&&(provenanceMode==='snapshot'||limit<=100),'INVALID_LIMIT');
  requireValue(typeof query==='string'&&query.length<=200&&query.isWellFormed()&&!query.includes('\u0000'),'INVALID_QUERY');requireValue(typeof username==='string'&&username&&typeof password==='string'&&password,'INVALID_CREDENTIALS');
  requireValue(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=60000,'INVALID_TIMEOUT');
  requireValue(Number.isInteger(totalTimeoutMs)&&totalTimeoutMs>=1&&totalTimeoutMs<=60000,'INVALID_TOTAL_TIMEOUT');
  requireValue(Number.isInteger(maxResponseBytes)&&maxResponseBytes>=1&&maxResponseBytes<=1048576,'INVALID_RESPONSE_LIMIT');
  requireValue(maxOutputBytes===undefined||(Number.isInteger(maxOutputBytes)&&maxOutputBytes>=1&&maxOutputBytes<=4194304),'INVALID_OUTPUT_BUDGET');
  requireValue(['individual','batch','snapshot'].includes(provenanceMode),'INVALID_PROVENANCE_MODE');
  requireValue(provenanceMode!=='snapshot'||limit<=25,'INVALID_SNAPSHOT_LIMIT');
  requireValue(['inline','deduplicated'].includes(sourceMode),'INVALID_SOURCE_MODE');
  const search=parseSearchQuery(query,searchMode);
  return withReadSession({base,username,password,timeoutMs,totalTimeoutMs,maxResponseBytes,fetchImpl},async request=>{
    let result;
    const snapshot=provenanceMode==='snapshot';
    const page=await request(`/api/projects/${projectId}/${snapshot?'context':'facts'}?q=${encodeURIComponent(query)}&limit=${limit}${after?`&after=${after}`:''}${search?'&match=all_terms':''}`);
    const snapshotProofs=snapshot?validateSnapshot(page,{projectId,query,limit,after,search}):null;
    requireValue(page&&['owner','member','viewer'].includes(page.role)&&Array.isArray(page.facts)&&page.facts.length<=limit,'INVALID_FACTS_RESPONSE');
    if(search)requireValue(matchesSearchMetadata(page.search,search),'INVALID_SEARCH_RESPONSE');
    requireValue(page.next_after===null||(positive(page.next_after)&&page.facts.length>0&&page.next_after===page.facts.at(-1).id),'INVALID_CURSOR_RESPONSE');
    let previousId=after;
    for(const fact of page.facts){
      requireValue(positive(fact.id)&&fact.id>previousId&&positive(fact.version)&&['subject','predicate','value'].every(key=>typeof fact[key]==='string'&&fact[key].length<=(key==='value'?1000:100)),'INVALID_FACT_RESPONSE');previousId=fact.id;
    }
    const facts=[],sources=new Map();
    function acceptProof(fact,proof){
      requireValue(proof?.fact?.id===fact.id&&proof.fact.subject===fact.subject&&proof.fact.predicate===fact.predicate&&proof?.revision?.version===fact.version&&proof.revision.value===fact.value,'PROVENANCE_MISMATCH');
      requireValue(positive(proof.revision.id)&&positive(proof?.source?.id)&&typeof proof.source.title==='string'&&proof.source.title.length<=150&&typeof proof.source.content==='string'&&proof.source.content.length<=4000&&positive(proof?.candidate?.id)&&positive(proof.candidate.proposed_by)&&positive(proof.revision.approved_by),'INVALID_PROVENANCE_RESPONSE');
      const source={id:proof.source.id,title:proof.source.title,content:proof.source.content};
      if(sourceMode==='deduplicated'){
        const prior=sources.get(source.id);
        requireValue(!prior||(prior.title===source.title&&prior.content===source.content),'SOURCE_MISMATCH');
        sources.set(source.id,source);
      }
      facts.push({id:fact.id,subject:fact.subject,predicate:fact.predicate,value:fact.value,version:fact.version,revisionId:proof.revision.id,...(sourceMode==='inline'?{source}:{sourceId:source.id}),candidateId:proof.candidate.id,proposedBy:proof.candidate.proposed_by,approvedBy:proof.revision.approved_by});
    }
    if(snapshot){
      for(let i=0;i<page.facts.length;i++)acceptProof(page.facts[i],snapshotProofs[i]);
    }else if(provenanceMode==='batch'){
      // Bounded chunks keep even maximally escaped valid source text below the default HTTP byte cap.
      for(let offset=0;offset<page.facts.length;offset+=25){
        const chunk=page.facts.slice(offset,offset+25);
        const batch=await request(`/api/projects/${projectId}/facts/provenance`,{body:{facts:chunk.map(({id,version})=>({id,version}))}});
        requireValue(batch?.sourceTextIsUntrusted===true&&['owner','member','viewer'].includes(batch.role)&&Array.isArray(batch.provenance)&&batch.provenance.length===chunk.length,'INVALID_PROVENANCE_RESPONSE');
        for(let i=0;i<chunk.length;i++)acceptProof(chunk[i],batch.provenance[i]);
      }
    }else{
      for(const fact of page.facts)acceptProof(fact,await request(`/api/projects/${projectId}/facts/${fact.id}/provenance?version=${fact.version}`));
    }
    const sourcesFor=prefix=>sourceMode==='deduplicated'?{sources:[...new Set(prefix.map(fact=>fact.sourceId))].map(id=>sources.get(id))}:{};
    result={schemaVersion:sourceMode==='inline'?1:2,projectId,query,limit,...(after?{after}:{}),truncated:page.next_after!==null,nextAfter:page.next_after,sourceTextIsUntrusted:true,consistency:snapshot?SNAPSHOT_DESCRIPTION:'One current-facts page; immutable provenance pinned to each returned version. Not necessarily current at completion.',facts,...sourcesFor(facts),...(search?{search:page.search}:{}),...(snapshot?{snapshot:snapshotReceipt()}:{})};
    if(maxOutputBytes!==undefined){
      const minimum=facts.length?1:0;let fitted=false;
      for(let count=facts.length;count>=minimum;count--){
        const omitted=facts.length-count;
        const prefix=facts.slice(0,count);
        const candidate={...result,facts:prefix,...sourcesFor(prefix),truncated:omitted>0||result.truncated,nextAfter:omitted>0?facts[count-1].id:result.nextAfter,outputBudget:{maxBytes:maxOutputBytes,unit:'utf8-json-bytes',omittedFacts:omitted}};
        if(Buffer.byteLength(serializeContext(candidate),'utf8')<=maxOutputBytes){result=candidate;fitted=true;break}
      }
      requireValue(fitted,'OUTPUT_BUDGET_TOO_SMALL');
    }
    return result;
  });
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
  requireValue(request&&typeof request==='object'&&!Array.isArray(request)&&Object.keys(request).every(key=>['projectId','query','limit','maxOutputBytes','after','provenanceMode','sourceMode','searchMode'].includes(key)),'INVALID_STDIN_REQUEST');
  return request;
}
async function main(){
  requireValue(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--stdin'),'INVALID_ARGUMENTS');
  const request=process.argv[2]==='--stdin'?await stdinRequest():{};
  const context=await readContext({baseURL:process.env.MEMZ_BASE_URL||'http://127.0.0.1:3000',username:process.env.MEMZ_USERNAME||'viewer',password:process.env.MEMZ_PASSWORD||'demo-viewer',projectId:process.env.MEMZ_PROJECT_ID===undefined?1:Number(process.env.MEMZ_PROJECT_ID),query:process.env.MEMZ_QUERY||'',limit:process.env.MEMZ_LIMIT===undefined?25:Number(process.env.MEMZ_LIMIT),after:process.env.MEMZ_AFTER===undefined?0:Number(process.env.MEMZ_AFTER),maxOutputBytes:process.env.MEMZ_MAX_OUTPUT_BYTES===undefined?undefined:Number(process.env.MEMZ_MAX_OUTPUT_BYTES),provenanceMode:process.env.MEMZ_PROVENANCE_MODE??'individual',sourceMode:process.env.MEMZ_SOURCE_MODE??'inline',searchMode:process.env.MEMZ_SEARCH_MODE??'substring',...request});
  process.stdout.write(serializeContext(context));
}
if(require.main===module)main().catch(error=>{console.error(`Context read failed: ${error.code||'UNKNOWN_ERROR'}`);process.exitCode=1});
module.exports={readContext};
