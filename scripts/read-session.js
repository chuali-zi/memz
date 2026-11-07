// Internal transport for validated read-client configurations. Each successful
// request materializes JSON; all owned transports are aborted before returning.
// Optional signal is the whole-flow budget; cancelSignal is caller cancellation
// for login/reads only. Logout keeps its independent bounded cleanup allowance.
const failure=(code,status)=>Object.assign(new Error(code),{code,...(status===undefined?{}:{status})});
const validReadSignal=value=>value===undefined||value instanceof AbortSignal;
async function withReadSession({base,username,password,timeoutMs,totalTimeoutMs,maxResponseBytes,fetchImpl,signal,cancelSignal},read){
  const deadline=Date.now()+totalTimeoutMs;
  let cookie='',csrf='',result,problem;
  async function request(path,{body,logout=false}={}){
    if(!logout&&cancelSignal?.aborted)throw failure('REQUEST_CANCELLED');
    const remaining=logout?Math.min(timeoutMs,5000):Math.min(timeoutMs,deadline-Date.now());
    if(remaining<=0)throw failure('TOTAL_TIMEOUT');
    if(signal?.aborted)throw failure('REQUEST_TIMEOUT');
    const transport=new AbortController(),timeout=AbortSignal.timeout(remaining),abort=()=>transport.abort();
    const signals=[timeout,signal,...(logout?[]:[cancelSignal])].filter(Boolean);
    for(const source of signals){
      if(source.aborted)abort();else source.addEventListener('abort',abort,{once:true});
    }
    try{
      let response;
      try{response=await fetchImpl(new URL(path,base),{method:body===undefined?'GET':'POST',redirect:'error',signal:transport.signal,headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf})},...(body===undefined?{}:{body:JSON.stringify(body)})})}
      catch(error){
        if(!logout&&cancelSignal?.aborted)throw failure('REQUEST_CANCELLED');
        throw failure(['AbortError','TimeoutError'].includes(error.name)?'REQUEST_TIMEOUT':'REQUEST_FAILED');
      }
      if(logout&&response.status===401){
        try{await response.body?.cancel()}
        catch(error){throw failure(['AbortError','TimeoutError'].includes(error.name)?'REQUEST_TIMEOUT':'REQUEST_FAILED')}
        return null;
      }
      if(!response.ok){
        // Keep the primary status even if cancellation itself fails; finally
        // aborts the transport so an unconsumed error body cannot keep running.
        try{await response.body?.cancel()}catch{}
        throw failure(`HTTP_${response.status}`,response.status);
      }
      let value;
      try{
        const reader=response.body?.getReader();if(!reader)throw failure('INVALID_JSON_RESPONSE');
        const chunks=[];let bytes=0;
        try{
          while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
            if(bytes>maxResponseBytes){try{await reader.cancel()}catch{}throw failure('RESPONSE_TOO_LARGE')}
            chunks.push(Buffer.from(part.value));
          }
        }finally{reader.releaseLock()}
        value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
      }catch(error){
        if(error.code==='RESPONSE_TOO_LARGE')throw error;
        if(!logout&&cancelSignal?.aborted)throw failure('REQUEST_CANCELLED');
        throw failure(['AbortError','TimeoutError'].includes(error.name)?'REQUEST_TIMEOUT':'INVALID_JSON_RESPONSE');
      }
      if(path==='/api/login'){
        const headers=response.headers.getSetCookie?.()||[response.headers.get('set-cookie')||''];
        cookie=headers.map(header=>header.split(';')[0]).find(value=>/^sid=[^;]+$/.test(value))||'';
        if(!(cookie&&typeof value?.csrf==='string'&&value.csrf))throw failure('INVALID_LOGIN_RESPONSE');csrf=value.csrf;
      }
      if(!logout&&cancelSignal?.aborted)throw failure('REQUEST_CANCELLED');
      return value;
    }finally{
      transport.abort();
      for(const source of signals)source.removeEventListener('abort',abort);
    }
  }
  try{
    await request('/api/login',{body:{username,password}});result=await read(request);
    if(cancelSignal?.aborted)throw failure('REQUEST_CANCELLED');
  }
  catch(error){problem=error}
  const readProblem=problem;
  if(cookie){try{await request('/api/logout',{body:{},logout:true})}catch(error){problem=problem||error}}
  // A late cancellation cannot turn a completed read into a success while
  // cleanup was running. Preserve an earlier primary read failure, however.
  if(cancelSignal?.aborted&&!readProblem)throw failure('REQUEST_CANCELLED');
  if(problem)throw problem;
  return result;
}
module.exports={withReadSession,validReadSignal};
