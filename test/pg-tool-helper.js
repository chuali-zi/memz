// Test-only PostgreSQL CLI runner. Reap this direct child before resolving or
// rejecting; a Docker CLI close does not prove its remote exec process exited.
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const PG_TOOL_LIMITS=Object.freeze({timeoutMs:60000,maxOutputBytes:8*1024*1024,terminationGraceMs:250});
const messages={
  PG_TOOL_CONFIG:'Invalid PostgreSQL test tool configuration',
  PG_TOOL_TIMEOUT:'PostgreSQL test tool timed out',
  PG_TOOL_OUTPUT_LIMIT:'Synthetic backup exceeds test limit',
  PG_TOOL_START_FAILED:'PostgreSQL test tool could not start',
  PG_TOOL_INPUT_FAILED:'PostgreSQL test tool input failed',
  PG_TOOL_STREAM_FAILED:'PostgreSQL test tool stream failed'
};
const failure=code=>Object.assign(new Error(messages[code]),{code});

function pgTool(name,url,input,options={}){
  const {timeoutMs=PG_TOOL_LIMITS.timeoutMs,maxOutputBytes=PG_TOOL_LIMITS.maxOutputBytes,
    terminationGraceMs=PG_TOOL_LIMITS.terminationGraceMs,spawnTool=spawn}=options;
  let command,args,env;
  try{
    if(!['pg_dump','pg_restore'].includes(name)||typeof spawnTool!=='function'||
      !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>PG_TOOL_LIMITS.timeoutMs||
      !Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>PG_TOOL_LIMITS.maxOutputBytes||
      !Number.isSafeInteger(terminationGraceMs)||terminationGraceMs<1||terminationGraceMs>1000)throw new Error();
    const u=new URL(url),container=process.env.PG_TOOLS_CONTAINER;
    env={...process.env,PGPASSWORD:decodeURIComponent(u.password)};
    args=['--host',u.hostname,'--port',u.port||'5432','--username',decodeURIComponent(u.username),'--dbname',u.pathname.slice(1),
      ...(name==='pg_dump'?['--format=custom']:['--exit-on-error','--single-transaction','--no-owner'])];
    const binary=fs.existsSync(`/usr/lib/postgresql/16/bin/${name}`)?`/usr/lib/postgresql/16/bin/${name}`:name;
    command=container?'docker':binary;if(container)args=['exec','-i','-e','PGPASSWORD',container,name,...args];
  }catch{return Promise.reject(failure('PG_TOOL_CONFIG'))}
  return new Promise((resolve,reject)=>{
    let child,reason,deadline,escalation,closed=false,stopping=false,inputFailed=false,size=0;
    const chunks=[];
    const clearTimers=()=>{clearTimeout(deadline);clearTimeout(escalation)};
    const stop=code=>{
      reason=reason||code;
      if(closed||stopping)return;
      stopping=true;clearTimeout(deadline);chunks.length=0;
      // A pending stdin write may error as the process closes; its listener is
      // installed before end(), and that secondary error cannot replace reason.
      child.stdin.destroy();
      if(child.pid){
        try{child.kill('SIGTERM')}catch{}
        escalation=setTimeout(()=>{if(!closed)try{child.kill('SIGKILL')}catch{}},terminationGraceMs);
      }
    };
    try{child=spawnTool(command,args,{env,stdio:['pipe','pipe','pipe']})}
    catch{return reject(failure('PG_TOOL_START_FAILED'))}
    child.once('error',()=>stop('PG_TOOL_START_FAILED'));
    child.stdout.on('error',()=>stop('PG_TOOL_STREAM_FAILED'));
    child.stderr.on('error',()=>stop('PG_TOOL_STREAM_FAILED'));
    child.stdin.on('error',()=>{inputFailed=true});
    child.stdout.on('data',chunk=>{
      if(stopping)return;
      size+=chunk.length;
      if(size>maxOutputBytes)stop('PG_TOOL_OUTPUT_LIMIT');else chunks.push(chunk);
    });
    child.stderr.resume(); // Drain; never retain or expose tool diagnostics.
    child.once('close',(code,signal)=>{
      closed=true;clearTimers();
      // Broken stdin is normal for a nonzero tool exit (e.g. corrupt archive).
      // Preserve that receipt; a zero exit with undelivered input is not success.
      if(!reason&&inputFailed&&input?.length&&code===0)reason='PG_TOOL_INPUT_FAILED';
      if(reason)return reject(Object.assign(failure(reason),{childClosed:true,signal}));
      resolve({code,bytes:Buffer.concat(chunks)});
    });
    deadline=setTimeout(()=>stop('PG_TOOL_TIMEOUT'),timeoutMs);
    try{child.stdin.end(input)}catch{stop('PG_TOOL_INPUT_FAILED')}
  });
}
module.exports={pgTool,PG_TOOL_LIMITS};
