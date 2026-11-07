// Real owned CLI/native HTTP children and a few loopback TCP sockets. The CLI
// pool is explicitly forbidden from checking out a client; the second child's
// handlers/pool are synthetic. No PostgreSQL, browser, model or load experiment.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http'),net=require('node:net');
const {once}=require('node:events');
const {SHUTDOWN_TIMEOUT_MS}=require('../scripts/server-lifecycle');
const {startChild}=require('./server-shutdown-helpers');
const entry=require('node:path').resolve(__dirname,'../server.js');
async function bounded(promise,label,milliseconds=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' exceeded its test watchdog')),milliseconds)})])}finally{clearTimeout(timer)}}
async function connect(port,initial=''){
  const socket=net.createConnection({host:'127.0.0.1',port}),chunks=[];
  socket.on('data',chunk=>chunks.push(chunk));socket.on('error',()=>{});
  const closed=new Promise(resolve=>socket.once('close',resolve));
  try{await bounded(once(socket,'connect'),'connecting owned socket');if(initial)socket.write(initial);return {socket,closed,body:()=>Buffer.concat(chunks)}}catch(error){socket.destroy();throw error}
}
const cliFixture=String.raw`
const http=require('node:http'),{Pool}=require('pg'),{SessionStore}=require('./scripts/session-store');
const originalListen=http.Server.prototype.listen,originalEnd=Pool.prototype.end,originalCreate=SessionStore.prototype.create;
let connects=0,sessions=0,ends=0,connections=0,requests=0;
Pool.prototype.connect=function(){connects++;throw new Error('SYNTHETIC_DATABASE_CHECKOUT_FORBIDDEN')};
Pool.prototype.end=function(...args){ends++;process.send({type:'pool-end',connects,sessions,ends});return originalEnd.apply(this,args)};
SessionStore.prototype.create=function(...args){sessions++;return originalCreate.apply(this,args)};
http.Server.prototype.listen=function(...args){this.on('connection',()=>connections++);this.on('request',()=>requests++);return originalListen.apply(this,args)};
process.on('message',message=>{if(message==='stats')process.send({type:'stats',connections,requests,connects,sessions,ends,deadline:require('./scripts/server-lifecycle').SHUTDOWN_TIMEOUT_MS})});
require('node:module').runMain(process.argv[1]);
`;
test('real CLI drain closes bare TCP and incomplete headers without a DB checkout or the shutdown deadline',{timeout:15000},async t=>{
  const app=await startChild(['-e',cliFixture,entry],{PORT:'0',DATABASE_URL:'postgres://synthetic:synthetic@127.0.0.1:1/not_a_database'}),clients=[];
  try{
    assert.equal(SHUTDOWN_TIMEOUT_MS,20000);const port=Number(new URL(app.base).port);
    clients.push(await connect(port),await connect(port,'GET /health/live HTTP/1.1\r\nHost: localhost\r\nX-Synthetic-Partial: '));
    const health=await bounded(new Promise((resolve,reject)=>{const request=http.get(app.base+'/health/live',{agent:false},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);response.once('end',()=>resolve({status:response.statusCode,body}))});request.once('error',reject)}),'live HTTP barrier');assert.equal(health.status,200);assert.deepEqual(JSON.parse(health.body),{status:'alive'});
    app.child.send('stats');await app.waitFor(()=>app.messages.some(message=>message.type==='stats'));const stats=app.messages.find(message=>message.type==='stats');assert.deepEqual(stats,{type:'stats',connections:3,requests:1,connects:0,sessions:0,ends:0,deadline:20000});
    const started=performance.now();assert.equal(app.child.kill('SIGTERM'),true);assert.deepEqual(await bounded(app.exit,'draining only unadmitted sockets'),{code:0,signal:null});
    await bounded(Promise.all(clients.map(client=>client.closed)),'closing both unadmitted clients');for(const client of clients)assert.equal(client.body().length,0,'unadmitted TCP closure does not promise an HTTP response');
    assert.deepEqual(app.messages.filter(message=>message.type==='pool-end'),[{type:'pool-end',connects:0,sessions:0,ends:1}]);assert.equal((app.stdout().match(/Memz stopping;/g)||[]).length,1);assert.equal(app.stderr(),'');
    t.diagnostic(JSON.stringify({node:process.version,simultaneousSocketsAtMost:3,syntheticFixture:true,actualCli:true,httpRequests:1,postgresCheckouts:0,sessionCreates:0,poolEnds:1,afterSignalMs:Math.round(performance.now()-started),productionDeadlineMs:SHUTDOWN_TIMEOUT_MS}));
  }finally{for(const client of clients)client.socket.destroy();await app.stop()}
});

const prefix='SYNTHETIC_LONG_RESPONSE_',longBody=prefix+'x'.repeat(512*1024)+'_COMPLETE';
const activeFixture=String.raw`
const express=require('express');
const {createCliHttpServer}=require('./scripts/http-server');
const {createShutdownGate,installShutdown}=require('./scripts/server-lifecycle');
const app=express(),gate=createShutdownGate(),body='SYNTHETIC_LONG_RESPONSE_'+'x'.repeat(512*1024)+'_COMPLETE';let pending,ends=0;const finished=[];
app.use(gate.middleware);app.get('/hold',(req,res)=>{pending=res;res.status(200).set('Content-Type','text/plain').set('Content-Length',String(Buffer.byteLength(body)));res.write(body.slice(0,1024),()=>process.send({type:'held'}))});
const server=createCliHttpServer(app);
server.on('request',(req,res)=>{res.once('finish',()=>finished.push(req.url));process.send({type:'request',path:req.url})});
process.on('message',message=>{if(message==='release'&&pending)pending.end(body.slice(1024))});
const pool={end:()=>{ends++;return new Promise(resolve=>process.send({type:'pool-end',ends,finished},resolve))}};
server.listen(0,'127.0.0.1',()=>console.log('Memz http://127.0.0.1:'+server.address().port));installShutdown({server,pool,onDrain:gate.beginDrain});
`;
function responses(wire){
  const result=[];let offset=0;
  while(offset<wire.length){
    const end=wire.indexOf('\r\n\r\n',offset);assert.ok(end>=offset,'each response must have complete headers');const lines=wire.subarray(offset,end).toString('utf8').split('\r\n'),status=Number(lines[0].match(/^HTTP\/1\.1 (\d+) /)?.[1]);assert.ok(status);
    const headers=Object.fromEntries(lines.slice(1).map(line=>{const colon=line.indexOf(':');assert.ok(colon>0);return [line.slice(0,colon).toLowerCase(),line.slice(colon+1).trim()]}));assert.match(headers['content-length'],/^[0-9]+$/);
    const length=Number(headers['content-length']),start=end+4;assert.ok(start+length<=wire.length,'no queued response body may be truncated');result.push({status,headers,body:wire.subarray(start,start+length).toString('utf8')});offset=start+length;
  }
  return result;
}
test('drain removes an unadmitted socket while flushing an admitted long response and a queued pipelined rejection',{timeout:15000},async t=>{
  const app=await startChild(['-e',activeFixture]),clients=[];
  try{
    const port=Number(new URL(app.base).port),bare=await connect(port);clients.push(bare);const active=await connect(port,'GET /hold HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');clients.push(active);
    await app.waitFor(()=>app.messages.some(message=>message.type==='held'));assert.equal(app.child.kill('SIGTERM'),true);await app.waitFor(()=>app.stdout().includes('Memz stopping;'));await bounded(bare.closed,'closing the unadmitted peer during active drain');assert.equal(bare.body().length,0);assert.equal(active.socket.destroyed,false);assert.equal(app.result(),undefined);assert.equal(app.messages.some(message=>message.type==='pool-end'),false);
    active.socket.write('GET /after HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');await app.waitFor(()=>app.messages.some(message=>message.type==='request'&&message.path==='/after'));assert.equal(app.messages.some(message=>message.type==='pool-end'),false,'the pool must wait for the admitted primary response');app.child.kill('SIGINT');app.child.kill('SIGTERM');app.child.send('release');
    await bounded(active.closed,'flushing the admitted response and queued 503');const received=responses(active.body());assert.equal(received.length,2);assert.equal(received[0].status,200);assert.equal(received[0].body,longBody);assert.equal(received[1].status,503);assert.equal(received[1].headers.connection,'close');assert.deepEqual(JSON.parse(received[1].body),{error:'服务正在停止，请稍后重试'});
    assert.deepEqual(await bounded(app.exit,'finishing the drained synthetic pool'),{code:0,signal:null});assert.deepEqual(app.messages.filter(message=>message.type==='pool-end'),[{type:'pool-end',ends:1,finished:['/hold','/after']}]);assert.equal((app.stdout().match(/Memz stopping;/g)||[]).length,1);assert.equal(app.stderr(),'');
    t.diagnostic(JSON.stringify({node:process.version,syntheticHandlersAndPool:true,actualNativeServerAndLifecycle:true,simultaneousSocketsAtMost:2,httpRequests:2,responseStatuses:received.map(response=>response.status),primaryBodyBytes:Buffer.byteLength(longBody),poolEnds:1,postgresCheckouts:0,modelCalls:0}));
  }finally{for(const client of clients)client.socket.destroy();await app.stop()}
});
