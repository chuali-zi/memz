const {test}=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),http=require('node:http');
const {inspectSetupCatalog}=require('../scripts/setup-catalog');
const {createHealthProbes}=require('../scripts/health-probes');
const {createShutdownGate}=require('../scripts/server-lifecycle');
const good=()=>({safe_role:true,missing:[],owner_access:false,rls:true,can_read:true,migrated:true,function_execute:true,columns_valid:true,read_policies:true,runtime_valid:true});
async function inspect(row){let queries=0;const result=await inspectSetupCatalog({query:async(sql,params)=>{queries++;assert.equal(params[0].length,8);assert.ok(Buffer.byteLength(JSON.stringify(params))<8192);return {rows:[row]}}});assert.equal(queries,1);return result}
test('one bounded catalog result preserves old diagnostic priorities and adds fixed schema prerequisites',async()=>{
  assert.deepEqual(await inspect(good()),{code:'BASIC_CHECKS_PASSED'});
  const cases=[
    [{safe_role:false,missing:['facts'],owner_access:true},'UNSAFE_DATABASE_ROLE'],
    [{missing:['sources','idempotency_requests'],owner_access:true},'SCHEMA_MISSING'],
    [{owner_access:true,missing:['idempotency_requests']},'UNSAFE_DATABASE_ROLE'],
    [{missing:['idempotency_requests'],rls:false},'MIGRATION_REQUIRED'],
    [{rls:false,can_read:false},'RLS_DISABLED'],[{can_read:false,migrated:false},'SCHEMA_PERMISSIONS'],
    [{migrated:false,function_execute:false},'MIGRATION_REQUIRED'],[{function_execute:false,columns_valid:false},'SCHEMA_PERMISSIONS'],
    [{columns_valid:false},'SCHEMA_PREREQUISITES'],[{read_policies:false},'SCHEMA_PREREQUISITES'],[{runtime_valid:false},'SCHEMA_PREREQUISITES']
  ];
  for(const [changes,code] of cases)assert.equal((await inspect({...good(),...changes})).code,code);
  assert.deepEqual(await inspect({...good(),missing:['sources','idempotency_requests']}),{code:'SCHEMA_MISSING',details:{missing:['sources','idempotency_requests']}});
});
test('malformed catalog responses fail closed without echoing input',async()=>{
  for(const rows of [[],[good(),good()],[{...good(),safe_role:'true'}],[{...good(),missing:['synthetic-private']}],[{...good(),missing:['facts','facts']}]])await assert.rejects(()=>inspectSetupCatalog({query:async()=>({rows})}),error=>error.message==='SETUP_CATALOG_INVALID'&&error.cause===undefined);
});
async function withHTTP(tx,run){
  const app=express(),gate=createShutdownGate(),probes=createHealthProbes(tx);
  app.use((req,res,next)=>{res.set('Cache-Control','no-store');next()});app.use(gate.middleware);app.get('/health/live',probes.live);app.get('/health/ready',probes.ready);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{await run(`http://127.0.0.1:${server.address().port}`,gate)}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}
test('real loopback liveness never checks DB; readiness uses empty local identity, one catalog result and read-only snapshot',async()=>{
  let transactions=0,catalogs=0;
  await withHTTP(async(user,callback,options)=>{transactions++;assert.equal(user,'');assert.deepEqual(options,{snapshot:true});return callback({query:async()=>{catalogs++;return {rows:[good()]}}})},async(base)=>{
    const live=await fetch(base+'/health/live');assert.equal(live.status,200);assert.deepEqual(await live.json(),{status:'alive'});assert.equal(transactions,0);
    const ready=await fetch(base+'/health/ready?debug=1&user=1&schema=ignore');assert.equal(ready.status,200);assert.deepEqual(await ready.json(),{status:'ready'});assert.equal(transactions,1);assert.equal(catalogs,1);assert.equal(ready.headers.get('set-cookie'),null);
  });
});
test('HEAD and conditional requests make fresh observations without ETags or 304s; drain gates probes without DB',async()=>{
  let ready=true,calls=0;
  await withHTTP(async()=>{calls++;return {code:ready?'BASIC_CHECKS_PASSED':'SCHEMA_PREREQUISITES'}},async(base,gate)=>{
    for(const route of ['live','ready'])for(const method of ['GET','HEAD']){
      const response=await fetch(base+'/health/'+route,{method,headers:{'if-none-match':'*','if-modified-since':'Wed, 01 Jan 2099 00:00:00 GMT'}});
      assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('etag'),null);
      assert.equal(await response.text(),method==='HEAD'?'':JSON.stringify({status:route==='live'?'alive':'ready'}));
    }
    ready=false;const failed=await fetch(base+'/health/ready',{headers:{'if-none-match':'*'}});assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{status:'not_ready'});
    assert.equal(calls,3);gate.beginDrain();
    for(const route of ['live','ready']){const response=await fetch(base+'/health/'+route);assert.equal(response.status,503);assert.equal(response.headers.get('connection'),'close');assert.equal(response.headers.get('cache-control'),'no-store');await response.json()}
    assert.equal(calls,3);
  });
});
test('DB failures and debug body/query values never escape fixed readiness responses or create sessions',async()=>{
  await withHTTP(async()=>{throw Object.assign(new Error('synthetic-private-error'),{code:'DB_ADMISSION_BUSY',config:'synthetic-private-config'})},async(base)=>{
    for(const method of ['GET','HEAD']){
      const response=await fetch(base+'/health/ready?debug=synthetic-private');assert.equal(response.status,503);assert.deepEqual(await response.json(),{status:'not_ready'});
      const body='{"debug":true,"user":1,"password":"synthetic"}';
      const raw=await new Promise((resolve,reject)=>{const request=http.request(base+'/health/ready?scope=synthetic-private',{method,headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,text,headers:response.headers}))});request.on('error',reject);request.end(body)});
      assert.equal(raw.status,503);assert.equal(raw.text,method==='HEAD'?'':'{"status":"not_ready"}');assert.equal(raw.headers['set-cookie'],undefined);
    }
  });
});
test('actual app mounting keeps Host and drain gates ahead of both probes, including normal route aliases',async()=>{
  const lifecycle=require('../scripts/server-lifecycle'),factory=lifecycle.createShutdownGate;let gate,service,server,calls=0,originalConnect;
  lifecycle.createShutdownGate=()=>{gate=factory();return gate};
  try{
    service=require('../server');lifecycle.createShutdownGate=factory;originalConnect=service.pool.connect;
    service.pool.connect=async()=>{calls++;throw new Error('synthetic-private-unavailable')};
    server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
    const live=await fetch(base+'/health/live');assert.equal(live.status,200);assert.deepEqual(await live.json(),{status:'alive'});assert.equal(calls,0);
    const notReady=await fetch(base+'/health/ready');assert.equal(notReady.status,503);assert.deepEqual(await notReady.json(),{status:'not_ready'});assert.equal(calls,1);
    gate.beginDrain();
    const forbidden=await new Promise((resolve,reject)=>{const request=http.get(base+'/health/live',{headers:{host:'synthetic.invalid'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode))});request.on('error',reject)});assert.equal(forbidden,403,'the original Host boundary must still run before the stopping gate');
    for(const endpoint of ['/health/live','/health/ready','/HEALTH/LIVE/','/HEALTH/READY/'])for(const method of ['GET','HEAD']){
      const response=await fetch(base+endpoint,{method,headers:{'if-none-match':'*'}});assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('connection'),'close');assert.equal(response.headers.get('set-cookie'),null);await response.text();
    }
    assert.equal(calls,1,'the actual stopping gate must not start another checkout');
  }finally{lifecycle.createShutdownGate=factory;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}if(service){service.pool.connect=originalConnect;await service.pool.end()}}
});
