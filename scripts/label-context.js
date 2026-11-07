// Explicit bounded current-view template reader. No model calls or fallback.
const {readContext}=require('./context-client');
const {planLabelQuery,PLANNER_MODE,MAX_LABEL_ROWS}=require('./label-query-plan');
const {planExactLabelQuery,EXACT_PLANNER_MODE}=require('./label-query-plan-v2');
const {validateCurrentLabels,validateExactContext}=require('./exact-context-protocol');
const {withReadSession}=require('./read-session');
const failure=code=>Object.assign(new Error(code),{code});
const check=(condition,code)=>{if(!condition)throw failure(code)};
const serialize=value=>JSON.stringify(value,null,2)+'\n';
const positive=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
const within=(value,max)=>Number.isInteger(value)&&value>=1&&value<=max;
const text=(value,max)=>typeof value==='string'&&value.length>=1&&value.length<=max&&value.isWellFormed()&&!value.includes('\u0000');
const moduleKeys=['baseURL','username','password','projectId','question','protocol','timeoutMs','totalTimeoutMs','maxResponseBytes','maxOutputBytes','fetchImpl'];
const stdinKeys=['projectId','question','protocol','timeoutMs','totalTimeoutMs','maxResponseBytes','maxOutputBytes'];
function allowedObject(value,keys){
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>keys.includes(key));
}

async function readLabelContext(options={}){
  check(allowedObject(options,moduleKeys),'INVALID_LABEL_CONTEXT_INPUT');
  const {baseURL='http://127.0.0.1:3000',username='viewer',password='demo-viewer',projectId,question,protocol='snapshot_filter_v1',
    timeoutMs=5000,totalTimeoutMs=30000,maxResponseBytes=1048576,maxOutputBytes=1048576,fetchImpl=fetch}=options;
  check(text(baseURL,2048)&&!/[\u0000-\u0020\u007f]/u.test(baseURL),'INVALID_BASE_URL');
  let base;try{base=new URL(baseURL)}catch{throw failure('INVALID_BASE_URL')}
  check(['http:','https:'].includes(base.protocol)&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/','INVALID_BASE_URL');
  check(positive(projectId),'INVALID_PROJECT');
  // Validate question before login, without supplying evidence or selecting a label.
  planLabelQuery({question,labels:[]});
  check(['snapshot_filter_v1','metadata_exact_v2'].includes(protocol),'INVALID_LABEL_PROTOCOL');
  check(text(username,100)&&text(password,8192),'INVALID_CREDENTIALS');
  check(within(timeoutMs,60000),'INVALID_TIMEOUT');check(within(totalTimeoutMs,60000),'INVALID_TOTAL_TIMEOUT');
  check(within(maxResponseBytes,1048576),'INVALID_RESPONSE_LIMIT');check(within(maxOutputBytes,4194304),'INVALID_OUTPUT_BUDGET');
  check(typeof fetchImpl==='function','INVALID_FETCH');
  const deadline=Date.now()+totalTimeoutMs,controller=new AbortController(),cleanup=[];
  const started=performance.now(),stages=[];
  const elapsed=since=>Number((performance.now()-since).toFixed(3));
  const timer=setTimeout(()=>controller.abort(),totalTimeoutMs);
  async function boundedFetch(url,request){
    if(controller.signal.aborted||Date.now()>=deadline)throw new DOMException('Request deadline exceeded','TimeoutError');
    const transport=new AbortController(),abort=()=>transport.abort();
    // Retain both listeners through body consumption, not merely until headers.
    // At most six requests are made; all listeners are removed in finally.
    for(const signal of [controller.signal,request.signal]){
      if(signal.aborted)abort();
      else{signal.addEventListener('abort',abort,{once:true});cleanup.push(()=>signal.removeEventListener('abort',abort))}
    }
    return fetchImpl(url,{...request,signal:transport.signal});
  }
  async function snapshot(query,searchMode,stage){
    const remaining=deadline-Date.now();check(remaining>0&&!controller.signal.aborted,'TOTAL_TIMEOUT');
    const phaseStarted=performance.now();
    try{
      return await readContext({baseURL:base.href,username,password,projectId,query,searchMode,
        limit:MAX_LABEL_ROWS,provenanceMode:'snapshot',sourceMode:'deduplicated',timeoutMs,
        totalTimeoutMs:Math.min(remaining,60000),maxResponseBytes,fetchImpl:boundedFetch});
    }finally{stages.push({stage,elapsedMs:elapsed(phaseStarted)})}
  }
  function result(status,plan,{reason,context,selection}={}){
    const exact=protocol==='metadata_exact_v2';
    const value={schema:exact?'memz-label-context-v2':'memz-label-context-v1',...(exact?{protocol}:{}),projectId,question,sourceTextIsUntrusted:true,status,
      ...(reason?{reason}:{}),plan,
      consistency:exact?'Planning metadata and exact evidence use separate read-only repeatable-read transactions in one authenticated session; no shared or frozen view across reads. Returned revisions and full sources are pinned to the exact retrieval snapshot, not necessarily current or still authorized at completion.':'Planning labels and selected facts use separate current-page snapshots; no shared view across phases. Returned revisions and full sources are pinned to the retrieval snapshot, not necessarily current at completion.',
      execution:{modelCalls:0,stages,totalElapsedMs:elapsed(started)},
      ...(selection?{selection}:{}),
      ...(context?{context}:{})};
    check(Buffer.byteLength(serialize(value),'utf8')<=maxOutputBytes,'OUTPUT_BUDGET_TOO_SMALL');
    check(Date.now()<deadline&&!controller.signal.aborted,'TOTAL_TIMEOUT');
    return value;
  }
  async function metadataExact(){
    const remaining=deadline-Date.now();check(remaining>0&&!controller.signal.aborted,'TOTAL_TIMEOUT');
    const phaseStarted=performance.now();let draft;
    try{
      draft=await withReadSession({base,username,password,timeoutMs,totalTimeoutMs:remaining,maxResponseBytes,fetchImpl,signal:controller.signal},async request=>{
        const metadata=await request(`/api/projects/${projectId}/current-labels`);
        validateCurrentLabels(metadata,{projectId});
        if(!metadata.complete){
          const plan={schemaVersion:1,mode:EXACT_PLANNER_MODE,view:'current',status:'needs_scope',reason:'SCOPE_TOO_LARGE'};
          return {status:plan.status,reason:plan.reason,plan};
        }
        const plan=planExactLabelQuery({question,labels:metadata.labels.map(({subject,predicate})=>({subject,predicate}))});
        if(plan.status!=='planned')return {status:plan.status,reason:plan.reason,plan};
        const context=await request(`/api/projects/${projectId}/context/exact`,{body:{selector:plan.selector}});
        validateExactContext(context,{projectId,selector:plan.selector});
        const selection={method:'exact_subject_predicate',applied:true,candidateFacts:context.facts.length,retainedFacts:context.facts.length,candidateSources:context.sources.length,retainedSources:context.sources.length};
        if(context.facts.length===0)return {status:'no_match',reason:'LABEL_NOT_FOUND_NOW',plan,selection};
        return {status:'matched',plan,context,selection};
      });
    }finally{stages.push({stage:'metadata_exact_session',elapsedMs:elapsed(phaseStarted)})}
    return result(draft.status,draft.plan,draft);
  }
  try{
    if(protocol==='metadata_exact_v2')return await metadataExact();
    const scope=await snapshot('','substring','scope_snapshot');
    if(scope.truncated||scope.nextAfter!==null){
      const plan={schemaVersion:1,mode:PLANNER_MODE,view:'current',status:'needs_scope',reason:'SCOPE_TOO_LARGE'};
      return result(plan.status,plan,{reason:plan.reason});
    }
    // Deliberately remove IDs, versions, values, sources and all provenance
    // before passing labels to the pure planner. No caller vocabulary is accepted.
    const plan=planLabelQuery({question,labels:scope.facts.map(({subject,predicate})=>({subject,predicate}))});
    if(plan.status!=='planned')return result(plan.status,plan,{reason:plan.reason});
    const page=await snapshot(plan.query,'all_terms','retrieval_snapshot');
    const selection={method:'exact_subject_predicate',applied:false,candidateFacts:page.facts.length,retainedFacts:0,candidateSources:page.sources.length,retainedSources:0};
    if(page.truncated||page.nextAfter!==null)return result('unsupported',plan,{reason:'RETRIEVAL_WINDOW_EXCEEDED',selection});
    const facts=page.facts.filter(fact=>fact.subject===plan.subject&&fact.predicate===plan.predicate);
    selection.applied=true;selection.retainedFacts=facts.length;
    check(facts.length<=1,'AMBIGUOUS_CONTEXT_LABEL');
    if(facts.length===0)return result('no_match',plan,{reason:'LABEL_NOT_FOUND_NOW',selection});
    const used=new Set(facts.map(fact=>fact.sourceId));
    const context={...page,facts,sources:page.sources.filter(source=>used.has(source.id))};
    selection.retainedSources=context.sources.length;
    return result('matched',plan,{context,selection});
  }catch(error){
    const expired=controller.signal.aborted||Date.now()>=deadline;controller.abort();
    // Retain primary HTTP/protocol failures even if best-effort logout reaches
    // the shared deadline. Only an actual timeout becomes TOTAL_TIMEOUT.
    if(expired&&['REQUEST_TIMEOUT','TOTAL_TIMEOUT'].includes(error.code))throw failure('TOTAL_TIMEOUT');
    throw error;
  }finally{
    clearTimeout(timer);
    // All returned data is materialized JSON. Close every owned transport,
    // including an accepted logout 401 whose response body was not consumed.
    controller.abort();
    for(const remove of cleanup)remove();
  }
}

async function stdinRequest(){
  const bytes=await new Promise((resolve,reject)=>{
    const chunks=[];let size=0,finished=false;
    const done=error=>{
      if(finished)return;finished=true;clearTimeout(timer);
      process.stdin.removeAllListeners('data');process.stdin.removeAllListeners('end');process.stdin.removeAllListeners('error');
      if(error){process.stdin.destroy();reject(error)}else resolve(Buffer.concat(chunks,size));
    };
    const timer=setTimeout(()=>done(failure('INPUT_TIMEOUT')),5000);
    process.stdin.on('data',chunk=>{size+=chunk.length;if(size>16384)return done(failure('INPUT_TOO_LARGE'));chunks.push(chunk)});
    process.stdin.on('end',()=>done());process.stdin.on('error',()=>done(failure('INPUT_FAILED')));
  });
  let input;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw failure('INVALID_STDIN_JSON')}
  check(allowedObject(input,stdinKeys),'INVALID_STDIN_REQUEST');return input;
}
async function main(){
  check(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--stdin'),'INVALID_ARGUMENTS');
  const input=process.argv[2]==='--stdin'?await stdinRequest():{};
  const config={baseURL:process.env.MEMZ_BASE_URL||'http://127.0.0.1:3000',username:process.env.MEMZ_USERNAME||'viewer',password:process.env.MEMZ_PASSWORD||'demo-viewer',question:process.env.MEMZ_QUESTION,...(process.env.MEMZ_LABEL_PROTOCOL===undefined?{}:{protocol:process.env.MEMZ_LABEL_PROTOCOL})};
  for(const [env,key] of [['MEMZ_PROJECT_ID','projectId'],['MEMZ_TIMEOUT_MS','timeoutMs'],['MEMZ_TOTAL_TIMEOUT_MS','totalTimeoutMs'],['MEMZ_MAX_RESPONSE_BYTES','maxResponseBytes'],['MEMZ_MAX_OUTPUT_BYTES','maxOutputBytes']])if(process.env[env]!==undefined)config[key]=Number(process.env[env]);
  process.stdout.write(serialize(await readLabelContext({...config,...input})));
}
const publicCodes=new Set(['INVALID_LABEL_CONTEXT_INPUT','INVALID_LABEL_PROTOCOL','INVALID_CURRENT_LABELS_RESPONSE','INVALID_EXACT_CONTEXT_RESPONSE','INVALID_EXACT_SELECTOR','INVALID_BASE_URL','INVALID_PROJECT','INVALID_PLANNER_QUESTION','INVALID_PLANNER_LABEL','INVALID_PLANNER_INPUT','INVALID_CREDENTIALS','INVALID_TIMEOUT','INVALID_TOTAL_TIMEOUT','INVALID_RESPONSE_LIMIT','INVALID_OUTPUT_BUDGET','INVALID_FETCH','INVALID_STDIN_JSON','INVALID_STDIN_REQUEST','INVALID_ARGUMENTS','INPUT_TIMEOUT','INPUT_TOO_LARGE','INPUT_FAILED','OUTPUT_BUDGET_TOO_SMALL','TOTAL_TIMEOUT','REQUEST_TIMEOUT','REQUEST_FAILED','RESPONSE_TOO_LARGE','INVALID_JSON_RESPONSE','INVALID_LOGIN_RESPONSE','INVALID_SNAPSHOT_RESPONSE','INVALID_FACTS_RESPONSE','INVALID_SEARCH_RESPONSE','INVALID_CURSOR_RESPONSE','INVALID_FACT_RESPONSE','PROVENANCE_MISMATCH','INVALID_PROVENANCE_RESPONSE','SOURCE_MISMATCH','AMBIGUOUS_CONTEXT_LABEL']);
if(require.main===module)main().catch(error=>{
  const code=publicCodes.has(error?.code)||/^HTTP_[1-5][0-9]{2}$/.test(error?.code||'')?error.code:'READ_FAILED';
  console.error('Label context failed: '+code);process.exitCode=1;
});
module.exports={readLabelContext};
