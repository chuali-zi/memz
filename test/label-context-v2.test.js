const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {readLabelContext}=require('../scripts/label-context');
const {page,sampleFacts,transport}=require('./label-context-fixture');
const {currentLabelsReceipt,exactContextReceipt}=require('../scripts/exact-context-protocol');
const selector={subject:'晨桥服务',predicate:'交付时间'};
const defaults={projectId:7,question:'晨桥服务的交付时间是什么？',protocol:'metadata_exact_v2'};
function metadata({labels=[selector],complete=true}={}){return {...currentLabelsReceipt(),projectId:7,role:'viewer',sourceTextIsUntrusted:true,limit:512,complete,labels}}
function exact({key=selector,empty=false}={}){
  const wire=page({facts:empty?[]:[{...sampleFacts[0],subject:key.subject,predicate:key.predicate}]});
  return {...exactContextReceipt(),projectId:7,selector:{...key},role:'viewer',sourceTextIsUntrusted:true,facts:wire.facts,provenance:wire.provenance,sources:wire.sources};
}
function mock({labels=metadata(),context=exact(),exactStatus=200}={}){
  const calls=[];
  return {calls,fetchImpl:async(url,options)=>{
    const u=new URL(url);calls.push({url:u,options});
    if(u.pathname==='/api/login')return Response.json({csrf:'synthetic-v2-csrf'},{headers:{'set-cookie':'sid=synthetic-v2-session; HttpOnly'}});
    if(u.pathname==='/api/logout')return Response.json({ok:true});
    if(u.pathname==='/api/projects/7/current-labels')return Response.json(labels);
    if(u.pathname==='/api/projects/7/context/exact')return Response.json(context,{status:exactStatus});
    throw new Error('Unexpected fallback request');
  }};
}
const read=(f,extra={})=>readLabelContext({...defaults,fetchImpl:f.fetchImpl,...extra});
test('opt-in v2 uses one authenticated four-request session and preserves the complete exact wire',async()=>{
  const f=mock(),result=await read(f);
  assert.equal(result.schema,'memz-label-context-v2');assert.equal(result.protocol,'metadata_exact_v2');assert.equal(result.status,'matched');assert.equal(result.execution.modelCalls,0);
  assert.deepEqual(result.context,exact());assert.deepEqual(result.plan.selector,selector);assert.equal(Object.hasOwn(result.plan,'query'),false);assert.equal(Object.hasOwn(result.context,'query'),false);
  assert.deepEqual(result.execution.stages.map(row=>row.stage),['metadata_exact_session']);assert.match(result.consistency,/separate/);
  assert.deepEqual(f.calls.map(call=>call.url.pathname),['/api/login','/api/projects/7/current-labels','/api/projects/7/context/exact','/api/logout']);
  assert.equal(f.calls[1].url.search,'');assert.equal(f.calls[2].options.method,'POST');assert.deepEqual(JSON.parse(f.calls[2].options.body),{selector});
  assert.equal(f.calls[2].options.headers.cookie,'sid=synthetic-v2-session');assert.equal(f.calls[2].options.headers['X-CSRF-Token'],'synthetic-v2-csrf');
  assert.ok(f.calls.every(call=>call.options.signal.aborted));assert.equal(result.selection.retainedFacts,1);assert.equal(result.selection.retainedSources,1);
});
test('v2 accepts complete 256/512 vocabularies and exact keys beyond the v1 all_terms word limit',async()=>{
  for(const count of [256,512]){
    const labels=Array.from({length:count},(_,i)=>({subject:'窗口'+i,predicate:'开放时间'})),key=labels.at(-1),f=mock({labels:metadata({labels}),context:exact({key})});
    assert.equal((await read(f,{question:key.subject+'的开放时间是什么？'})).status,'matched');assert.equal(f.calls.length,4);
  }
  const key={subject:'a b c d e f g h',predicate:'i'},f=mock({labels:metadata({labels:[key]}),context:exact({key})});
  assert.deepEqual((await read(f,{question:key.subject+'的i是什么？'})).context.selector,key);
});
test('incomplete metadata and unsupported questions never request exact facts or fall back',async()=>{
  for(const [labels,question,status] of [[metadata({labels:[],complete:false}),defaults.question,'needs_scope'],[metadata(), '它的交付时间是什么？','needs_scope'],[metadata(), '晨桥服务最初的交付时间是什么？','unsupported'],[metadata(), '晨桥服务的地点是什么？','no_match']]){
    const f=mock({labels}),result=await read(f,{question});assert.equal(result.status,status);assert.equal(result.context,undefined);assert.equal(f.calls.length,3);assert.equal(f.calls.at(-1).url.pathname,'/api/logout');
  }
});
test('metadata must be project-bound, complete and label-only before any selector is generated',async()=>{
  for(const mutate of [wire=>{wire.projectId=8},wire=>{wire.labels[0].value='synthetic-private'},wire=>{wire.labels[0].gold='synthetic-private'},wire=>{wire.complete=false},wire=>{wire.labels.push({...selector})},wire=>{wire.limit=25},wire=>{wire.query=''}]){
    const wire=metadata({labels:[{...selector}]});mutate(wire);const f=mock({labels:wire});
    await assert.rejects(()=>read(f),{code:'INVALID_CURRENT_LABELS_RESPONSE'});assert.equal(f.calls.length,3);
  }
});
test('the exact response must bind the same selector and project and retain every proof field',async()=>{
  for(const mutate of [wire=>{wire.projectId=8},wire=>{wire.selector.predicate='另一键'},wire=>{wire.query=''},wire=>{wire.provenance=[]},wire=>{wire.sources=[]},wire=>{wire.provenance[0].revision.value='wrong'},wire=>{wire.provenance[0].candidate.expected_version=9},wire=>{wire.provenance[0].role='owner'}]){
    const wire=exact();mutate(wire);const f=mock({context:wire});await assert.rejects(()=>read(f),{code:'INVALID_EXACT_CONTEXT_RESPONSE'});assert.equal(f.calls.length,4);
  }
  const f=mock({context:exact({empty:true})}),result=await read(f);assert.equal(result.status,'no_match');assert.equal(result.reason,'LABEL_NOT_FOUND_NOW');assert.equal(result.context,undefined);
});
test('a retrieval permission error retains its fixed code and does not expose previously loaded metadata',async()=>{
  const f=mock({exactStatus:403,context:{error:'synthetic-private-body'}});
  await assert.rejects(()=>read(f),error=>error.code==='HTTP_403'&&error.status===403&&error.message==='HTTP_403'&&!Object.hasOwn(error,'context'));
  assert.equal(f.calls.length,4);assert.equal(f.calls.at(-1).url.pathname,'/api/logout');
});
test('protocol choice is controlled and the v1 default output and request sequence remain identical',async t=>{
  t.mock.method(performance,'now',()=>0);
  const a=transport(),b=transport(),implicit=await readLabelContext({projectId:7,question:defaults.question,fetchImpl:a.fetchImpl}),explicit=await readLabelContext({projectId:7,question:defaults.question,protocol:'snapshot_filter_v1',fetchImpl:b.fetchImpl});
  assert.deepEqual(explicit,implicit);assert.equal(implicit.schema,'memz-label-context-v1');assert.equal(Object.hasOwn(implicit,'protocol'),false);assert.equal(a.calls.length,6);assert.equal(b.calls.length,6);
  for(const protocol of ['',null,true,[],{},'exact','metadata_exact_v3']){const f=mock();await assert.rejects(()=>read(f,{protocol}),{code:'INVALID_LABEL_PROTOCOL'});assert.equal(f.calls.length,0)}
  for(const key of ['labels','selector','gold','value','evidence']){const f=mock();await assert.rejects(()=>read(f,{[key]:'synthetic-private'}),{code:'INVALID_LABEL_CONTEXT_INPUT'});assert.equal(f.calls.length,0)}
});
test('v2 whole-envelope stdout budget includes raw provenance and refuses partial success or decline',async t=>{
  t.mock.method(performance,'now',()=>0);const result=await read(mock()),bytes=Buffer.byteLength(JSON.stringify(result,null,2)+'\n');
  assert.deepEqual(await read(mock(),{maxOutputBytes:bytes}),result);
  const f=mock();await assert.rejects(()=>read(f,{maxOutputBytes:bytes-1}),{code:'OUTPUT_BUDGET_TOO_SMALL'});assert.equal(f.calls.length,4);
  const decline=mock({labels:metadata({labels:[],complete:false})});await assert.rejects(()=>read(decline,{maxOutputBytes:1}),{code:'OUTPUT_BUDGET_TOO_SMALL'});assert.equal(decline.calls.length,3);
});

async function local(mode){
  const paths=[];let closed=false;
  const server=http.createServer((req,res)=>{
    req.resume();const path=new URL(req.url,'http://localhost').pathname;paths.push(path);res.setHeader('content-type','application/json');
    const hang=status=>{res.statusCode=status;res.once('close',()=>{closed=true});res.write('{"unfinished":')};
    if(path==='/api/login'){
      if(mode==='login')return hang(200);if(mode==='login503')return hang(503);
      const login=()=>{res.setHeader('set-cookie','sid=synthetic-native-v2; HttpOnly');res.end(JSON.stringify({csrf:'synthetic-native-v2'}))};
      if(mode==='shared'){setTimeout(login,350);return}login();return;
    }
    if(path==='/api/logout'){
      if(mode==='logout'||mode==='primary')return hang(200);if(mode==='logout401')return hang(401);res.end('{}');return;
    }
    if(path.endsWith('/current-labels')){if(mode==='metadata')return hang(200);if(mode==='metadata503')return hang(503);res.end(JSON.stringify(metadata()));return}
    if(mode==='exact'||mode==='shared')return hang(200);if(mode==='primary')return hang(403);
    res.end(JSON.stringify(exact()));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {paths,baseURL:`http://127.0.0.1:${server.address().port}`,closed:()=>closed,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}};
}
for(const mode of ['login','metadata','exact','logout','primary'])test(`real HTTP v2 ${mode} phase obeys the same abort deadline and preserves primary failures`,async()=>{
  const f=await local(mode);
  try{
    await assert.rejects(()=>readLabelContext({...defaults,baseURL:f.baseURL,totalTimeoutMs:150,timeoutMs:1000}),{code:mode==='primary'?'HTTP_403':'TOTAL_TIMEOUT'});
    const until=Date.now()+500;while(!f.closed()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.closed(),true);
    assert.ok(f.paths.length<=4);
  }finally{await f.close()}
});
for(const mode of ['login503','metadata503','logout401'])test(`real HTTP v2 cancels unfinished ${mode} bodies instead of leaving a background response`,async()=>{
  const f=await local(mode);
  try{
    if(mode==='logout401')assert.equal((await readLabelContext({...defaults,baseURL:f.baseURL,totalTimeoutMs:1000})).status,'matched');
    else await assert.rejects(()=>readLabelContext({...defaults,baseURL:f.baseURL,totalTimeoutMs:1000}),{code:'HTTP_503'});
    const until=Date.now()+500;while(!f.closed()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.closed(),true);
    assert.equal(f.paths.length,mode==='login503'?1:mode==='metadata503'?3:4);
  }finally{await f.close()}
});
test('real HTTP v2 does not restart its total allowance for the second read',async()=>{
  const f=await local('shared');
  try{
    const started=Date.now();await assert.rejects(()=>readLabelContext({...defaults,baseURL:f.baseURL,totalTimeoutMs:600,timeoutMs:2000}),{code:'TOTAL_TIMEOUT'});
    assert.ok(Date.now()-started<850);assert.deepEqual(f.paths,['/api/login','/api/projects/7/current-labels','/api/projects/7/context/exact']);
  }finally{await f.close()}
});
