const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {readContext}=require('../scripts/context-client');
const {readLabelContext}=require('../scripts/label-context');
const {page,sampleFacts,transport}=require('./label-context-fixture');
const {currentLabelsReceipt,exactContextReceipt}=require('../scripts/exact-context-protocol');
const question='晨桥服务的交付时间是什么？';
const selector={subject:'晨桥服务',predicate:'交付时间'};
function cancelled(error){
  assert.equal(error.code,'REQUEST_CANCELLED');assert.equal(error.message,'REQUEST_CANCELLED');assert.equal(error.cause,undefined);
  assert.ok(!String(error.stack).includes('synthetic-private-reason'));return true;
}
const read=(kind,config={})=>kind==='context'?readContext(config):readLabelContext({projectId:7,question,...(kind==='label-v2'?{protocol:'metadata_exact_v2'}:{}),...config});
test('all public read modes reject pre-cancelled and invalid signals before any HTTP',async()=>{
  for(const kind of ['context','label-v1','label-v2']){
    const controller=new AbortController();controller.abort(new Error('synthetic-private-reason'));let calls=0;
    const fetchImpl=async()=>{calls++;throw new Error('unexpected HTTP')};
    await assert.rejects(()=>read(kind,{signal:controller.signal,fetchImpl}),cancelled);
    for(const signal of [null,true,1,'synthetic-private-reason',{},[],new AbortController()])await assert.rejects(()=>read(kind,{signal,fetchImpl}),{code:'INVALID_SIGNAL'});
    assert.equal(calls,0);
  }
});
test('an uncancelled optional signal does not change default v1 output or HTTP sequence',async t=>{
  t.mock.method(performance,'now',()=>0);
  const a=transport(),b=transport(),controller=new AbortController();
  const one=await readLabelContext({projectId:7,question,fetchImpl:a.fetchImpl}),two=await readLabelContext({projectId:7,question,fetchImpl:b.fetchImpl,signal:controller.signal});
  assert.deepEqual(one,two);assert.deepEqual(a.calls.map(row=>row.url.href),b.calls.map(row=>row.url.href));assert.equal(a.calls.length,6);
});
async function loopback({kind,phase='read',body=false,logout='ok',late=false}){
  const caller=new AbortController(),paths=[];let targetClosed=false,logoutClosed=false,logoutEnded=false,logoutIndependent=false;
  const target=path=>{
    const pathname=path.split('?',1)[0];
    return phase==='login'?pathname==='/api/login':phase==='metadata'?pathname.endsWith('/current-labels'):phase==='exact'?pathname.endsWith('/context/exact'):pathname.endsWith('/context')||pathname.endsWith('/facts');
  };
  const server=http.createServer((req,res)=>{
    req.resume();paths.push(req.url);res.setHeader('content-type','application/json');
    if(req.url==='/api/logout'){
      res.once('close',()=>{logoutClosed=true});
      if(late){caller.abort(new Error('synthetic-private-reason'));setTimeout(()=>{logoutEnded=true;res.end('{}')},25);return}
      if(logout==='hang'||logout==='401'){
        res.statusCode=logout==='401'?401:200;res.write('{"unfinished":');return;
      }
      logoutEnded=true;res.end('{}');return;
    }
    if(!late&&target(req.url)){
      res.once('close',()=>{targetClosed=true});
      if(body)res.write('{"unfinished":');else setImmediate(()=>caller.abort(new Error('synthetic-private-reason')));
      return;
    }
    if(req.url==='/api/login'){res.setHeader('set-cookie','sid=synthetic-cancel-session; HttpOnly');res.end(JSON.stringify({csrf:'synthetic-cancel-csrf'}));return}
    if(req.url.endsWith('/current-labels')){res.end(JSON.stringify({...currentLabelsReceipt(),projectId:7,role:'viewer',sourceTextIsUntrusted:true,limit:512,complete:true,labels:[selector]}));return}
    if(req.url.endsWith('/context/exact')){
      const wire=page({facts:[sampleFacts[0]]});res.end(JSON.stringify({...exactContextReceipt(),projectId:7,selector,role:'viewer',sourceTextIsUntrusted:true,facts:wire.facts,provenance:wire.provenance,sources:wire.sources}));return;
    }
    if(req.url.includes('/context?')){res.end(JSON.stringify(page()));return}
    if(req.url.includes('/facts?')){res.end(JSON.stringify({role:'viewer',facts:[],next_after:null}));return}
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const fetchImpl=async(url,options)=>{
    const path=new URL(url).pathname;
    if(path==='/api/logout')logoutIndependent=caller.signal.aborted&&!options.signal.aborted;
    const response=await fetch(url,options);
    if(!late&&body&&target(new URL(url).pathname+new URL(url).search))setImmediate(()=>caller.abort(new Error('synthetic-private-reason')));
    return response;
  };
  return {caller,paths,fetchImpl,baseURL:`http://127.0.0.1:${server.address().port}`,targetClosed:()=>targetClosed,logoutClosed:()=>logoutClosed,logoutEnded:()=>logoutEnded,logoutIndependent:()=>logoutIndependent,
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}};
}
async function observed(predicate){const until=Date.now()+1000;while(!predicate()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(predicate(),true)}
for(const body of [false,true])test(`caller cancellation stops real login ${body?'body':'headers'} with no subsequent read or unknown session logout`,async()=>{
  for(const kind of ['context','label-v1','label-v2']){
    const f=await loopback({kind,phase:'login',body});
    try{await assert.rejects(()=>read(kind,{baseURL:f.baseURL,fetchImpl:f.fetchImpl,signal:f.caller.signal,timeoutMs:1000,totalTimeoutMs:3000}),cancelled);assert.deepEqual(f.paths,['/api/login']);await observed(f.targetClosed)}finally{await f.close()}
  }
});
for(const body of [false,true])test(`caller cancellation aborts actual read ${body?'body':'headers'} and retains a bounded logout with a valid session`,async()=>{
  for(const kind of ['context','label-v1','label-v2']){
    const f=await loopback({kind,phase:kind==='label-v2'?'metadata':'read',body});
    try{
      await assert.rejects(()=>read(kind,{baseURL:f.baseURL,fetchImpl:f.fetchImpl,signal:f.caller.signal,timeoutMs:1000,totalTimeoutMs:3000}),cancelled);
      assert.equal(f.paths.length,3);assert.equal(f.paths.at(-1),'/api/logout');assert.equal(f.logoutIndependent(),true);assert.equal(f.logoutEnded(),true);await observed(f.targetClosed);
    }finally{await f.close()}
  }
});
test('caller cancellation during the v2 exact body prevents output but still consumes a bounded logout401',async()=>{
  const f=await loopback({kind:'label-v2',phase:'exact',body:true,logout:'401'});
  try{
    await assert.rejects(()=>read('label-v2',{baseURL:f.baseURL,fetchImpl:f.fetchImpl,signal:f.caller.signal,timeoutMs:1000,totalTimeoutMs:3000}),cancelled);
    assert.equal(f.paths.length,4);assert.equal(f.paths.at(-1),'/api/logout');assert.equal(f.logoutIndependent(),true);await observed(f.targetClosed);await observed(f.logoutClosed);
  }finally{await f.close()}
});
test('a cancellation arriving during successful logout cannot turn into returned read data',async()=>{
  for(const kind of ['context','label-v1','label-v2']){
    const f=await loopback({kind,late:true});
    try{
      await assert.rejects(()=>read(kind,{baseURL:f.baseURL,fetchImpl:f.fetchImpl,signal:f.caller.signal,timeoutMs:1000,totalTimeoutMs:3000}),cancelled);
      assert.equal(f.logoutEnded(),true);assert.equal(f.paths.at(-1),'/api/logout');assert.equal(f.paths.length,kind==='label-v2'?4:3);
    }finally{await f.close()}
  }
});
test('caller cancellation does not make logout unbounded or bypass the label whole-flow budget',async()=>{
  for(const kind of ['context','label-v1','label-v2']){
    const f=await loopback({kind,phase:kind==='label-v2'?'metadata':'read',logout:'hang'});
    try{
      const started=Date.now();await assert.rejects(()=>read(kind,{baseURL:f.baseURL,fetchImpl:f.fetchImpl,signal:f.caller.signal,timeoutMs:kind==='context'?150:5000,totalTimeoutMs:kind==='context'?3000:400}),cancelled);
      assert.equal(f.logoutIndependent(),true);assert.equal(f.paths.at(-1),'/api/logout');await observed(f.logoutClosed);assert.ok(Date.now()-started<2000);
    }finally{await f.close()}
  }
});
