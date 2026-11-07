const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const {once}=require('node:events');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createCliHttpServer,HTTP_RECEIVE_OPTIONS,MAX_HTTP_CONNECTIONS}=require('../scripts/http-server');
const {SHUTDOWN_TIMEOUT_MS}=require('../scripts/server-lifecycle');
const {startChild}=require('./server-shutdown-helpers');
const root=require('node:path').resolve(__dirname,'..'),entry=require('node:path').join(root,'server.js');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Real CLI and real production receive options. Only forbidden DB access and
// session creation are counted; no test timeout is injected into the server.
const fixture=String.raw`
const http=require('node:http'),{Pool}=require('pg');
const {SessionStore}=require('./scripts/session-store');
let server,poolConnect=0,sessionCreate=0,poolEnd=0,requests=0;
const originalListen=http.Server.prototype.listen,originalEnd=Pool.prototype.end,originalCreate=SessionStore.prototype.create;
Pool.prototype.connect=function(){poolConnect++;throw new Error('SYNTHETIC_DATABASE_ACCESS_FORBIDDEN')};
Pool.prototype.end=function(...args){poolEnd++;process.send({type:'pool-end',poolEnd,poolConnect,sessionCreate});return originalEnd.apply(this,args)};
SessionStore.prototype.create=function(...args){sessionCreate++;return originalCreate.apply(this,args)};
http.Server.prototype.listen=function(...args){server=this;this.on('request',()=>requests++);return originalListen.apply(this,args)};
process.on('message',message=>{
  if(message.type!=='stats')return;
  process.send({type:'stats',id:message.id,poolConnect,sessionCreate,poolEnd,requests,
    policy:Object.fromEntries(['headersTimeout','requestTimeout','connectionsCheckingInterval','keepAliveTimeout','timeout','maxConnections'].map(key=>[key,server[key]]))});
});
require('node:module').runMain(process.argv[1]);
`;
let statsId=0;
async function stats(app){const id=++statsId;app.child.send({type:'stats',id});await app.waitFor(()=>app.messages.some(message=>message.type==='stats'&&message.id===id));return app.messages.find(message=>message.type==='stats'&&message.id===id)}

async function socketTo(port,initial){
  const socket=net.createConnection({host:'127.0.0.1',port});let output='',closed=false;
  const started=performance.now();socket.on('error',()=>{});socket.on('data',buffer=>output+=buffer);socket.on('close',()=>closed=true);
  await once(socket,'connect');if(initial)socket.write(initial);
  return {socket,output:()=>output,closed:()=>closed,elapsed:()=>performance.now()-started};
}
async function closed(client,timeout=26000){
  const limit=Date.now()+timeout;while(!client.closed()&&Date.now()<limit)await delay(10);
  assert.equal(client.closed(),true,'owned socket must close before the test watchdog');
  return {elapsed:client.elapsed(),status:Number(client.output().match(/^HTTP\/1\.1 (\d+)/)?.[1]||0),output:client.output()};
}
async function complete(port,path,{body}={}){
  const request=body===undefined?`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`:
    `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
  const client=await socketTo(port,request);try{return await closed(client,5000)}finally{client.socket.destroy()}
}
const partialHeader='POST /api/login HTTP/1.1\r\nHost: localhost\r\nX-Synthetic-Slow: ';
const partialBody='POST /api/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1024\r\n\r\n{';

test('production CLI receive limits close dripping headers and JSON bodies without creating a session or touching DB',{timeout:35000},async t=>{
  const app=await startChild(['-e',fixture,entry],{PORT:'0',DATABASE_URL:'postgres://synthetic:synthetic@127.0.0.1:9/not_a_database'});
  const clients=[];let drip;
  try{
    const port=Number(new URL(app.base).port),initial=await stats(app);
    assert.deepEqual(initial.policy,{...HTTP_RECEIVE_OPTIONS,timeout:0,maxConnections:128});
    assert.equal(SHUTDOWN_TIMEOUT_MS,20000);
    const headers=await socketTo(port,partialHeader),body=await socketTo(port,partialBody);clients.push(headers,body);
    drip=setInterval(()=>{for(const client of [headers,body])if(!client.closed())client.socket.write(' ')},250);
    const health=await complete(port,'/health/live');assert.equal(health.status,200);
    const login=await complete(port,'/api/login',{body:JSON.stringify({username:'synthetic-unknown',password:'synthetic'})});assert.equal(login.status,401);
    const [headerResult,bodyResult]=await Promise.all([closed(headers),closed(body)]);
    for(const result of [headerResult,bodyResult]){assert.equal(result.status,408);assert.equal(result.output,'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n')}
    assert.ok(headerResult.elapsed>=9900,'header receive timeout must use the actual 10 second production value');
    assert.ok(bodyResult.elapsed>=14900,'body receive timeout must use the actual 15 second production value');
    // The upper bound is a generous watchdog, not an exact latency/SLO promise.
    assert.ok(headerResult.elapsed<26000);assert.ok(bodyResult.elapsed<26000);
    clearInterval(drip);
    const after=await stats(app);assert.equal(after.poolConnect,0);assert.equal(after.sessionCreate,0);assert.equal(after.requests,3,'incomplete headers never reach HTTP listener; body plus two complete requests do');
    t.diagnostic(JSON.stringify({node:process.version,productionPolicy:initial.policy,headerClosedMs:Math.round(headerResult.elapsed),bodyClosedMs:Math.round(bodyResult.elapsed),statuses:[headerResult.status,bodyResult.status],poolConnect:after.poolConnect,sessionCreate:after.sessionCreate}));
    assert.equal((await complete(port,'/health/live')).status,200);

    // Native close stops the receive checker. Preserve independent CLI drain:
    // finish only after this owned incomplete request is explicitly disconnected.
    const duringDrain=await socketTo(port,partialBody);clients.push(duringDrain);
    // IPC runs after socket input has been delivered; ask until the request is visible.
    const deadline=Date.now()+5000;while((await stats(app)).requests!==5){assert.ok(Date.now()<deadline);await delay(10)}
    app.child.kill('SIGTERM');await app.waitFor(()=>app.stdout().includes('Memz stopping;'));
    app.child.kill('SIGTERM');app.child.kill('SIGINT');await delay(100);
    assert.equal(app.result(),undefined);assert.equal(duringDrain.closed(),false);assert.equal(app.messages.some(message=>message.type==='pool-end'),false);
    duringDrain.socket.destroy();assert.deepEqual(await app.exit,{code:0,signal:null});
    assert.deepEqual(app.messages.filter(message=>message.type==='pool-end'),[{type:'pool-end',poolEnd:1,poolConnect:0,sessionCreate:0}]);
    assert.equal((app.stdout().match(/Memz stopping;/g)||[]).length,1);assert.equal(app.stderr(),'');
  }finally{clearInterval(drip);for(const client of clients)client.socket.destroy();await app.stop()}
});

test('CLI factory fixes limits and native connection overflow closes without claiming an HTTP status',async()=>{
  let requests=0,dropped=0;const server=createCliHttpServer((req,res)=>{requests++;res.end('synthetic')});const clients=[];
  assert.equal(MAX_HTTP_CONNECTIONS,128);assert.equal(server.maxConnections,128);assert.equal(Object.isFrozen(HTTP_RECEIVE_OPTIONS),true);
  // Lower only this owned server's native property to exercise admission with
  // three sockets. There is no CLI/ENV testing mode or production option override.
  server.maxConnections=2;server.on('drop',()=>dropped++);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=server.address().port;clients.push(await socketTo(port,partialHeader),await socketTo(port,partialHeader));
    const overflow=await socketTo(port,'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');clients.push(overflow);
    const result=await closed(overflow,5000);assert.equal(result.output,'');assert.equal(result.status,0);assert.equal(dropped,1);assert.equal(requests,0);
    for(const client of clients)client.socket.destroy();
    const releasedBy=Date.now()+5000;
    while(await new Promise((resolve,reject)=>server.getConnections((error,count)=>error?reject(error):resolve(count)))){
      assert.ok(Date.now()<releasedBy,'server must release all owned sockets before retrying');
      await delay(10);
    }
    assert.equal((await complete(port,'/')).status,200);assert.equal(requests,1);
  }finally{for(const client of clients)client.socket.destroy();await new Promise(resolve=>server.close(resolve))}
});

test('imported app keeps host-owned native servers and signal handlers untouched',async()=>{
  const code=`const assert=require('node:assert/strict');const signals=['SIGTERM','SIGINT'].map(name=>process.listenerCount(name));const {app,pool}=require(${JSON.stringify(entry)});assert.deepEqual(['SIGTERM','SIGINT'].map(name=>process.listenerCount(name)),signals);const server=app.listen(0,'127.0.0.1',()=>{assert.equal(server.requestTimeout,300000);assert.equal(server.headersTimeout,60000);assert.equal(server.connectionsCheckingInterval,30000);assert.equal(server.maxConnections,undefined);server.close(()=>pool.end().then(()=>console.log('host-owned')))});`;
  const result=await promisify(execFile)(process.execPath,['-e',code],{cwd:root,env:{PATH:'/usr/bin:/bin',DATABASE_URL:'postgres://synthetic:synthetic@127.0.0.1:9/not_a_database'},timeout:5000});
  assert.equal(result.stdout,'host-owned\n');assert.equal(result.stderr,'');
});
