// Synthetic runtime error events on a genuinely listening CLI HTTP server.
// These checks do not reproduce an OS/network fault and never connect to PostgreSQL.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SHUTDOWN_TIMEOUT_MS}=require('../scripts/server-lifecycle');
const {startChild}=require('./server-shutdown-helpers');
const serverPath=require('node:path').resolve(__dirname,'../server.js');

const fixture=String.raw`
const http=require('node:http'),{Pool}=require('pg');
const mode=process.argv[1],entry=process.argv[2];
const originalListen=http.Server.prototype.listen,originalEnd=Pool.prototype.end;
let server,endCalls=0,releasePool;
const poolGate=new Promise(resolve=>{releasePool=resolve});
Pool.prototype.end=function(...args){
  endCalls++;process.send({type:'pool-end',count:endCalls});
  if(mode==='pool-hang')return new Promise(()=>{});
  return poolGate.then(()=>originalEnd.apply(this,args));
};
http.Server.prototype.listen=function(...args){
  server=this;
  this.once('close',()=>process.send({type:'listener-closed'}));
  return originalListen.apply(this,args);
};
process.on('message',message=>{
  if(message==='release-pool'){releasePool();return}
  if(message!=='runtime-error'&&message!=='repeat-runtime-errors')return;
  const count=message==='runtime-error'?1:3;
  for(let i=0;i<count;i++)server.emit('error',Object.assign(new Error('synthetic-private-runtime-canary'),{code:'ECONNRESET'}));
  // Only explicit non-sensitive fixture state crosses IPC; no env or error objects.
  process.send({type:'runtime-state',listening:server.listening,poolEndCalls:endCalls});
});
require('node:module').runMain(entry);
`;
const start=mode=>startChild(['-e',fixture,mode,serverPath],{PORT:'0'});
async function failListeningServer(app){
  app.child.send('runtime-error');
  await app.waitFor(()=>app.messages.some(message=>message.type==='runtime-state'));
  assert.equal(app.messages.find(message=>message.type==='runtime-state').listening,false,'runtime failure must immediately stop listening, rather than end the pool while serving');
  await app.waitFor(()=>app.messages.some(message=>message.type==='pool-end'));
  await app.waitFor(()=>app.messages.some(message=>message.type==='listener-closed'));
  await assert.rejects(()=>fetch(app.base+'/',{signal:AbortSignal.timeout(2000)}),'the failed listener must refuse new HTTP connections');
}
function onceOnly(app,{deadline=false}={}){
  assert.equal(app.messages.filter(message=>message.type==='pool-end').length,1);
  assert.equal(app.messages.find(message=>message.type==='pool-end').count,1);
  assert.equal((app.stdout().match(/Memz stopping; waiting for active requests\./g)||[]).length,1);
  assert.equal(app.stderr(),'HTTP server failed; stopping.\n'+(deadline?'Shutdown deadline exceeded; exiting.\n':''));
  assert.ok(!app.stderr().includes('synthetic-private-runtime-canary'));
}

test('synthetic runtime errors after CLI startup stop the listener and close the pool once despite repeated errors and signals',{timeout:15000},async()=>{
  const app=await start('held-pool');
  try{
    const response=await fetch(app.base+'/',{signal:AbortSignal.timeout(2000)});assert.equal(response.status,200);await response.text();
    await failListeningServer(app);assert.equal(app.result(),undefined,'wait for the existing pool close operation');
    app.child.send('repeat-runtime-errors');app.child.kill('SIGTERM');app.child.kill('SIGINT');
    await app.waitFor(()=>app.messages.filter(message=>message.type==='runtime-state').length===2);
    assert.equal(app.messages.at(-1).listening,false);onceOnly(app);
    app.child.send('release-pool');assert.deepEqual(await app.exit,{code:1,signal:null});onceOnly(app);
  }finally{await app.stop()}
});

test('synthetic runtime failure retains the actual 20 second pool shutdown deadline after later errors and signals',{timeout:30000},async()=>{
  assert.equal(SHUTDOWN_TIMEOUT_MS,20000);
  const app=await start('pool-hang');let replay;
  try{
    const started=Date.now();await failListeningServer(app);
    let replayed=false;
    replay=setTimeout(()=>{replayed=true;app.child.send('repeat-runtime-errors');app.child.kill('SIGTERM');app.child.kill('SIGINT')},10000);
    assert.deepEqual(await app.exit,{code:1,signal:null});
    const elapsed=Date.now()-started;assert.equal(replayed,true);
    assert.ok(elapsed>=SHUTDOWN_TIMEOUT_MS-100,'runtime failure uses the real shutdown budget');
    assert.ok(elapsed<SHUTDOWN_TIMEOUT_MS+5000,'later errors and signals must not restart the budget');
    assert.equal(app.messages.filter(message=>message.type==='runtime-state').length,2);onceOnly(app,{deadline:true});
  }finally{clearTimeout(replay);await app.stop()}
});
