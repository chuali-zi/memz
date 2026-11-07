// Real CLI processes and HTTP, using only owned temporary canaries and synthetic
// unreachable DB configuration. Pool guards ensure these routes make no DB calls.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),entry=path.join(repo,'server.js');
const canary='SYNTHETIC_OWNED_CWD_INDEX_CANARY',onlyBody='SYNTHETIC_OWNED_CWD_ONLY_BODY';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
async function bounded(promise,label,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),ms)})])}finally{clearTimeout(timer)}}
async function start(cwd,guard){
  const child=spawn(process.execPath,['--require',guard,entry],{cwd,
    env:{PORT:'0',NODE_ENV:'test',DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic'},
    stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='',result;const messages=[];
  child.on('message',message=>messages.push(message));child.stderr.on('data',data=>{stderr+=data});
  child.once('exit',(code,signal)=>{result={code,signal}});
  const exit=new Promise(resolve=>child.once('close',()=>resolve(result)));
  const watchdog=setTimeout(()=>child.kill('SIGKILL'),30000);watchdog.unref();
  const stop=async()=>{
    if(!result)child.kill('SIGTERM');
    try{await bounded(exit,'graceful static fixture shutdown',3000)}
    catch(error){if(!result)child.kill('SIGKILL');await bounded(exit,'forced static fixture shutdown',2000);throw error}
    finally{clearTimeout(watchdog)}
  };
  try{
    const ready=new Promise((resolve,reject)=>{
      child.once('error',()=>reject(new Error('Static fixture could not start')));
      child.once('exit',()=>reject(new Error('Static fixture exited before startup')));
      child.stdout.on('data',data=>{stdout+=data;const match=stdout.match(/Memz (http:\/\/127\.0\.0\.1:\d+)/);if(match)resolve(match[1])});
    });
    const base=await bounded(ready,'starting static fixture',8000);
    return {base,messages,stop,exit,stderr:()=>stderr};
  }catch(error){await stop();throw error}
}
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memz-static-root-'));
  fs.mkdirSync(path.join(dir,'public'));
  fs.writeFileSync(path.join(dir,'public','index.html'),canary);
  fs.writeFileSync(path.join(dir,'public','__synthetic_cwd_only.txt'),onlyBody);
  const guard=path.join(dir,'pool-guard.cjs');
  fs.writeFileSync(guard,`const {Pool}=require(${JSON.stringify(require.resolve('pg'))});\nfor(const name of ['query','connect'])Pool.prototype[name]=function(){process.send({type:'unexpected-database-call',name});throw new Error('STATIC_FIXTURE_DB_CALL_FORBIDDEN')};\nprocess.send({type:'database-guard-ready'});\n`);
  return {dir,guard};
}
async function get(base,url){const response=await fetch(base+url,{signal:AbortSignal.timeout(2000)});return {status:response.status,type:response.headers.get('content-type'),body:await response.text()}}
for(const location of ['foreign temporary cwd','repository cwd'])test(`CLI serves only repository static assets from ${location}`,{timeout:25000},async()=>{
  const owned=fixture();let app;
  try{
    app=await start(location==='repository cwd'?repo:owned.dir,owned.guard);
    const root=await get(app.base,'/'),script=await get(app.base,'/app.js'),style=await get(app.base,'/style.css'),cwdOnly=await get(app.base,'/__synthetic_cwd_only.txt'),live=await get(app.base,'/health/live');
    console.log(JSON.stringify({case:location,index:root.status,indexIsCwdCanary:root.body===canary,appJS:script.status,css:style.status,cwdOnly:cwdOnly.status,live:live.status}));
    assert.equal(root.body===canary,false,'a foreign cwd/public must never supply the app index');
    for(const [response,file,mime] of [[root,'index.html',/text\/html/],[script,'app.js',/javascript/],[style,'style.css',/text\/css/]]){
      assert.equal(response.status,200,file);assert.match(response.type,mime,file);
      assert.equal(digest(response.body),digest(fs.readFileSync(path.join(repo,'public',file),'utf8')),file+' must match the repository asset');
    }
    assert.equal(cwdOnly.status,404);assert.ok(!cwdOnly.body.includes(onlyBody));
    assert.equal(live.status,200);assert.deepEqual(JSON.parse(live.body),{status:'alive'});
    await app.stop();assert.deepEqual(await app.exit,{code:0,signal:null});
    assert.equal(app.messages.filter(message=>message.type==='database-guard-ready').length,1);
    assert.deepEqual(app.messages.filter(message=>message.type==='unexpected-database-call'),[],'static/liveness requests must not query or connect to the database');
    assert.equal(app.stderr(),'');
  }finally{try{if(app)await app.stop()}finally{fs.rmSync(owned.dir,{recursive:true,force:true})}}
});
