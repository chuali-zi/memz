// Local synthetic-demo candidate submission. No model calls or automatic retries.
const fail=(code,outcome='not_attempted',status)=>Object.assign(new Error(code),{code,outcome,...(status?{status}:{})});
const check=(condition,code)=>{if(!condition)throw fail(code)};
const integer=(value,min=1)=>Number.isInteger(value)&&value>=min&&value<=2147483647;
async function submitProposal({baseURL='http://127.0.0.1:3000',username='member',password='demo-member',proposal,fetchImpl=fetch}={}){
  let base;try{base=new URL(baseURL)}catch{throw fail('INVALID_BASE_URL')}
  check(base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname)&&base.pathname==='/'&&!base.username&&!base.password&&!base.search&&!base.hash,'LOCAL_DEMO_URL_REQUIRED');
  check(typeof username==='string'&&username&&typeof password==='string'&&password,'INVALID_CREDENTIALS');
  const fields=['projectId','sourceId','subject','predicate','value','expectedVersion','idempotencyKey'];
  check(proposal&&typeof proposal==='object'&&!Array.isArray(proposal)&&Object.keys(proposal).length===fields.length&&Object.keys(proposal).every(k=>fields.includes(k)),'INVALID_PROPOSAL');
  check(integer(proposal.projectId)&&integer(proposal.sourceId)&&integer(proposal.expectedVersion,0),'INVALID_IDENTIFIERS');
  for(const [field,max] of [['subject',100],['predicate',100],['value',1000]])check(typeof proposal[field]==='string'&&proposal[field].trim()&&proposal[field].length<=max&&proposal[field].isWellFormed()&&!proposal[field].includes('\0'),'INVALID_TEXT');
  check(typeof proposal.idempotencyKey==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(proposal.idempotencyKey),'INVALID_IDEMPOTENCY_KEY');
  proposal={...proposal}; // Keep the validated intent stable across asynchronous login.
  let cookie='',csrf='',writeAttempted=false,result,problem;const deadline=Date.now()+15000;
  async function request(path,body,{write=false,logout=false}={}){
    const remaining=logout?5000:Math.min(5000,deadline-Date.now());if(remaining<=0)throw fail('TOTAL_TIMEOUT',writeAttempted?'unknown':'not_attempted');
    if(write)writeAttempted=true;
    let response;
    try{response=await fetchImpl(new URL(path,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(remaining),headers:{'content-type':'application/json',...(cookie?{cookie,'x-csrf-token':csrf}:{}),...(write?{'Idempotency-Key':proposal.idempotencyKey}:{})},body:JSON.stringify(body)})}
    catch{throw fail('REQUEST_FAILED',writeAttempted?'unknown':'not_attempted')}
    if(logout&&response.status===401)return null;
    if(!response.ok){await response.body?.cancel();throw fail(`HTTP_${response.status}`,write?(response.status<500?'rejected':'unknown'):'not_attempted',response.status)}
    let data;
    try{
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536){await reader.cancel();throw new Error('limit')}chunks.push(Buffer.from(part.value))}}finally{reader.releaseLock()}
      data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
    }catch{throw fail('INVALID_RESPONSE',writeAttempted?'unknown':'not_attempted')}
    if(path==='/api/login'){
      cookie=(response.headers.getSetCookie?.()||[response.headers.get('set-cookie')||'']).map(h=>h.split(';')[0]).find(h=>/^sid=[^;]+$/.test(h))||'';
      if(!cookie||typeof data?.csrf!=='string'||!data.csrf)throw fail('INVALID_LOGIN_RESPONSE');csrf=data.csrf;
    }
    return data;
  }
  try{
    await request('/api/login',{username,password});
    const body={subject:proposal.subject.trim(),predicate:proposal.predicate.trim(),value:proposal.value.trim(),source_id:proposal.sourceId,expected_version:proposal.expectedVersion};
    const receipt=await request(`/api/projects/${proposal.projectId}/candidates`,body,{write:true});
    if(!integer(receipt?.id)||receipt.project_id!==proposal.projectId||receipt.status!=='pending'||Object.entries(body).some(([k,v])=>receipt[k]!==v))throw fail('INVALID_CREATION_RECEIPT','unknown');
    result={schemaVersion:1,projectId:proposal.projectId,candidateId:receipt.id,sourceId:receipt.source_id,expectedVersion:receipt.expected_version,statusAtCreation:'pending',currentStatusNotRead:true,autoApproved:false};
  }catch(error){problem=error}
  let loggedOut=false;
  if(cookie)try{await request('/api/logout',{}, {logout:true});loggedOut=true}catch{}
  if(problem)throw problem;
  return {...result,sessionCleanup:loggedOut?'logged_out':'logout_failed'};
}
async function stdinProposal(){
  const bytes=await new Promise((resolve,reject)=>{
    let size=0,done=false;const chunks=[];
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);if(error){process.stdin.destroy();reject(error)}else resolve(Buffer.concat(chunks,size))};
    const timer=setTimeout(()=>finish(fail('INPUT_TIMEOUT')),5000);
    process.stdin.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>16384)return finish(fail('INPUT_TOO_LARGE'));chunks.push(chunk)});
    process.stdin.on('end',()=>finish());process.stdin.on('error',()=>finish(fail('INPUT_FAILED')));
  });
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw fail('INVALID_STDIN_JSON')}
}
if(require.main===module)(async()=>{
  check(process.argv.length===3&&process.argv[2]==='--stdin','STDIN_REQUIRED');
  const result=await submitProposal({baseURL:process.env.MEMZ_BASE_URL||'http://127.0.0.1:3000',username:process.env.MEMZ_USERNAME||'member',password:process.env.MEMZ_PASSWORD||'demo-member',proposal:await stdinProposal()});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
})().catch(error=>{console.error(JSON.stringify({code:error.code||'UNKNOWN_ERROR',outcome:error.outcome||'unknown',...(error.status?{status:error.status}:{})}));process.exitCode=1});
module.exports={submitProposal};
