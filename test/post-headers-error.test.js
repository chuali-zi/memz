const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),entry=path.join(root,'server.js');
const sentinel='synthetic-private-post-headers-detail';

async function startApp(file,environment){
  const child=spawn(process.execPath,['-r',file,entry],{cwd:root,env:{NODE_ENV:environment,PORT:'0',DATABASE_URL:'postgres://synthetic:synthetic@127.0.0.1:9/not_a_database'},stdio:['ignore','pipe','pipe','ipc']});
  let output='',errors='',result;const messages=[];child.on('message',message=>messages.push(message));child.stderr.on('data',chunk=>errors+=chunk);
  const watchdog=setTimeout(()=>child.kill('SIGKILL'),20000);child.once('exit',(code,signal)=>result={code,signal});
  const exit=new Promise(resolve=>child.once('close',()=>{clearTimeout(watchdog);resolve(result)}));
  try{
    const base=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Synthetic CLI startup timed out')),10000);
      child.once('error',()=>{clearTimeout(timer);reject(new Error('Synthetic CLI startup failed'))});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Synthetic CLI exited before startup'))});
      child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/Memz (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1])}});
    });
    return {child,base,exit,messages,stderr:()=>errors,async waitFor(predicate){const until=Date.now()+5000;while(!predicate()){assert.equal(result,undefined);assert.ok(Date.now()<until,'Synthetic CLI event timed out');await new Promise(resolve=>setTimeout(resolve,5))}},async stop(){if(!result)child.kill('SIGKILL');await exit}};
  }catch(error){if(!result)child.kill('SIGKILL');await exit;throw error}
}

// Preload belongs only to this test's CLI child. No product fault route exists.
const preload=String.raw`
const req=require('node:module').createRequire(process.cwd()+'/package.json');
const express=req('express'),{Pool}=req('pg'),{SessionStore}=req('./scripts/session-store');
let poolConnect=0,sessionCreate=0,poolEnd=0;
Pool.prototype.connect=function(){poolConnect++;throw new Error('SYNTHETIC_DATABASE_FORBIDDEN')};
const originalEnd=Pool.prototype.end,originalCreate=SessionStore.prototype.create;
Pool.prototype.end=function(...args){poolEnd++;process.send({type:'pool-end',poolEnd,poolConnect,sessionCreate});return originalEnd.apply(this,args)};
SessionStore.prototype.create=function(...args){sessionCreate++;return originalCreate.apply(this,args)};
const originalJson=express.response.json;
express.response.json=function(...args){
  const mode=this.req.originalUrl==='/api/synthetic-error/post-headers'?'post':this.req.originalUrl==='/api/synthetic-error/pre-headers'?'pre':null;
  if(!mode)return originalJson.apply(this,args);
  this.locals.syntheticJsonCalls=(this.locals.syntheticJsonCalls||0)+1;
  if(this.locals.syntheticThrown)return originalJson.apply(this,args);
  this.locals.syntheticThrown=true;
  this.once('close',()=>process.send({type:'response-closed',mode,headersSent:this.headersSent,jsonCalls:this.locals.syntheticJsonCalls,poolConnect,sessionCreate}));
  if(mode==='post'){this.writeHead(this.statusCode,{'Content-Type':'application/json'});this.write('{"synthetic":')}
  throw new Error('synthetic-private-post-headers-detail');
};
`;

function response(base,pathname){
  return new Promise(resolve=>{
    const request=http.get(base+pathname,{agent:false,headers:{Connection:'close'}});let settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value)};
    const timer=setTimeout(()=>{request.destroy();finish({watchdog:true})},5000);
    request.on('response',res=>{
      let body='';res.on('data',chunk=>body+=chunk);
      res.once('end',()=>finish({status:res.statusCode,body,complete:res.complete}));
      res.once('aborted',()=>finish({status:res.statusCode,body,complete:false}));
      res.once('error',()=>finish({status:res.statusCode,body,complete:false}));
    });
    request.once('error',()=>finish({closedBeforeResponse:true}));
  });
}

for(const environment of ['development','production'])test(`post-headers failures close only the response without exposing raw errors in ${environment}`,{timeout:25000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memz post headers ')),file=path.join(dir,'preload.js');fs.writeFileSync(file,preload);
  let app;
  try{
    app=await startApp(file,environment);
    const before=await response(app.base,'/api/synthetic-error/pre-headers');
    assert.equal(before.status,500);assert.equal(before.complete,true);assert.deepEqual(JSON.parse(before.body),{error:'请求无法处理'});assert.ok(!before.body.includes(sentinel));
    const partial=await response(app.base,'/api/synthetic-error/post-headers');assert.equal(partial.watchdog,undefined);
    assert.ok(partial.closedBeforeResponse||partial.complete===false,'a partial response must not become a completed JSON success');
    assert.ok(!(partial.body||'').includes(sentinel));assert.ok(!(partial.body||'').includes('请求无法处理'),'never write a second JSON after headers');
    await app.waitFor(()=>app.messages.some(message=>message.type==='response-closed'&&message.mode==='post'));
    const receipt=app.messages.find(message=>message.type==='response-closed'&&message.mode==='post');
    assert.equal(receipt.headersSent,true);assert.equal(receipt.jsonCalls,1);assert.equal(receipt.poolConnect,0);assert.equal(receipt.sessionCreate,0);
    const health=await response(app.base,'/health/live');assert.equal(health.status,200);assert.equal(health.complete,true);assert.deepEqual(JSON.parse(health.body),{status:'alive'});
    app.child.kill('SIGTERM');assert.deepEqual(await app.exit,{code:0,signal:null});
    assert.deepEqual(app.messages.filter(message=>message.type==='pool-end'),[{type:'pool-end',poolEnd:1,poolConnect:0,sessionCreate:0}]);
    t.diagnostic(JSON.stringify({environment,rawSentinelLogged:app.stderr().includes(sentinel),partialSocketClosed:true,secondJsonCalls:receipt.jsonCalls-1,subsequentHealthStatus:health.status,poolConnect:receipt.poolConnect,sessionCreate:receipt.sessionCreate}));
    assert.ok(!app.stderr().includes(sentinel),'Express default logger must not receive the private error');
    assert.equal(app.stderr(),'Request failed: Error\nRequest failed: Error\n');
  }finally{if(app)await app.stop();fs.rmSync(dir,{recursive:true,force:true})}
});
