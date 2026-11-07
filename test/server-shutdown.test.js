const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const net=require('node:net');
const {once}=require('node:events');
const {SHUTDOWN_TIMEOUT_MS,createShutdownGate}=require('../scripts/server-lifecycle');
const {startChild}=require('./server-shutdown-helpers');

const fixture=String.raw`
const express=require('express');
const {createShutdownGate,installShutdown}=require('./scripts/server-lifecycle');
const app=express(),gate=createShutdownGate();app.use(gate.middleware);
const mode=process.argv[1];let pending;
app.get('/hold',(req,res)=>{pending=res;process.send({type:'held'});if(mode==='handler-hang')return});
app.get('/quick',(req,res)=>res.json({ok:true}));
process.on('message',message=>{if(message==='release'&&pending)pending.json({ok:true})});
const pool={end:async()=>{
  process.send({type:'pool-end'});
  if(mode==='pool-hang')return new Promise(()=>{});
  if(mode==='pool-fail')throw new Error('synthetic-private-pool-detail');
}};
const server=app.listen(0,'127.0.0.1',()=>console.log('Memz http://127.0.0.1:'+server.address().port));
installShutdown({server,pool,onDrain:gate.beginDrain});
`;
const startFixture=mode=>startChild(['-e',fixture,mode]);
const stopped=app=>app.stdout().includes('Memz stopping; waiting for active requests.');

test('importing the app adds no signal handlers, opens no listener and does not drain its caller',async()=>{
  const terms=process.listenerCount('SIGTERM'),interrupts=process.listenerCount('SIGINT');
  const {app,pool}=require('../server');
  assert.equal(typeof app,'function');assert.equal(pool.ending,false);
  assert.equal(process.listenerCount('SIGTERM'),terms);assert.equal(process.listenerCount('SIGINT'),interrupts);
  await pool.end();
});
test('shutdown gate accepts current work and refuses subsequent work with a fixed retryable response',()=>{
  const gate=createShutdownGate();let next=0,status,body,connection;
  const response={set:(name,value)=>{assert.equal(name,'Connection');connection=value;return response},status:value=>{status=value;return response},json:value=>{body=value;return response}};
  gate.middleware({},response,()=>next++);assert.equal(next,1);
  gate.beginDrain();gate.beginDrain();gate.middleware({},response,()=>next++);
  assert.equal(next,1);assert.equal(status,503);assert.equal(connection,'close');assert.deepEqual(body,{error:'服务正在停止，请稍后重试'});
});
for(const signal of ['SIGTERM','SIGINT'])test(`${signal} drains an existing request, closes idle keepalive sockets and ends the pool once`,async()=>{
  const app=await startFixture('normal'),agent=new http.Agent({keepAlive:true});let pending;
  try{
    await new Promise((resolve,reject)=>http.get(app.base+'/quick',{agent},response=>{response.resume();response.once('end',resolve)}).once('error',reject));
    pending=fetch(app.base+'/hold',{signal:AbortSignal.timeout(10000)});
    pending.catch(()=>{});
    await app.waitFor(()=>app.messages.some(message=>message.type==='held'));
    assert.equal(app.child.kill(signal),true);await app.waitFor(()=>stopped(app));
    assert.equal(app.result(),undefined,'must wait for the request before exiting');
    app.child.kill(signal);app.child.kill(signal==='SIGTERM'?'SIGINT':'SIGTERM');
    await assert.rejects(()=>fetch(app.base+'/quick',{signal:AbortSignal.timeout(2000)}),'must stop accepting new connections');
    app.child.send('release');
    const response=await pending;assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
    assert.deepEqual(await app.exit,{code:0,signal:null});
    assert.equal(app.messages.filter(message=>message.type==='pool-end').length,1);
    assert.equal((app.stdout().match(/Memz stopping;/g)||[]).length,1);assert.equal(app.stderr(),'');
  }finally{agent.destroy();await app.stop();if(pending)await pending.catch(()=>{})}
});
test('an existing active connection cannot start a pipelined request after drain begins',async()=>{
  const app=await startFixture('normal'),socket=net.createConnection({host:'127.0.0.1',port:new URL(app.base).port});
  let output='';socket.on('data',data=>output+=data);socket.on('error',()=>{});
  try{
    await once(socket,'connect');
    socket.write('GET /hold HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    await app.waitFor(()=>app.messages.some(message=>message.type==='held'));
    app.child.kill('SIGTERM');await app.waitFor(()=>stopped(app));
    socket.write('GET /quick HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    // Give the parser a turn to accept the already connected request; its gate
    // response is sent after the first response in HTTP pipeline order.
    await new Promise(resolve=>setTimeout(resolve,50));app.child.send('release');
    await once(socket,'close');
    assert.match(output,/HTTP\/1\.1 200 OK/);assert.match(output,/HTTP\/1\.1 503 Service Unavailable/);
    assert.match(output,/Connection: close/i);assert.ok(output.includes('服务正在停止，请稍后重试'));
    assert.deepEqual(await app.exit,{code:0,signal:null});
  }finally{socket.destroy();await app.stop()}
});
test('pool shutdown failure exits nonzero and logs no private error details',async()=>{
  const app=await startFixture('pool-fail');
  try{
    app.child.kill('SIGTERM');assert.deepEqual(await app.exit,{code:1,signal:null});
    assert.equal(app.stderr().trim(),'Shutdown failed; exiting.');
    assert.ok(!app.stderr().includes('synthetic-private-pool-detail'));
  }finally{await app.stop()}
});
test('the actual 20 second deadline bounds both a stuck HTTP handler and a stuck pool without resetting on repeated signals',async()=>{
  assert.equal(SHUTDOWN_TIMEOUT_MS,20000);
  const apps=await Promise.all([startFixture('handler-hang'),startFixture('pool-hang')]);
  let pending;
  try{
    pending=fetch(apps[0].base+'/hold',{signal:AbortSignal.timeout(30000)}).catch(error=>error);
    await apps[0].waitFor(()=>apps[0].messages.some(message=>message.type==='held'));
    const started=Date.now();for(const app of apps)app.child.kill('SIGTERM');
    await Promise.all(apps.map(app=>app.waitFor(()=>stopped(app))));
    assert.ok(!apps[0].messages.some(message=>message.type==='pool-end'),'pool must stay open until HTTP has drained');
    await apps[1].waitFor(()=>apps[1].messages.some(message=>message.type==='pool-end'));
    for(const app of apps){app.child.kill('SIGTERM');app.child.kill('SIGINT')}
    const results=await Promise.all(apps.map(app=>app.exit));
    for(const result of results)assert.deepEqual(result,{code:1,signal:null});
    const elapsed=Date.now()-started;assert.ok(elapsed>=SHUTDOWN_TIMEOUT_MS-100);assert.ok(elapsed<SHUTDOWN_TIMEOUT_MS+5000);
    for(const app of apps){assert.equal(app.stderr().trim(),'Shutdown deadline exceeded; exiting.');assert.equal((app.stdout().match(/Memz stopping;/g)||[]).length,1)}
    assert.equal(apps[1].messages.filter(message=>message.type==='pool-end').length,1);
    assert.ok(await pending instanceof Error,'forced drain closes the unfinished HTTP connection');
  }finally{await Promise.all(apps.map(app=>app.stop()));if(pending)await pending}
});
