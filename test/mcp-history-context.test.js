const {test}=require('node:test'),assert=require('node:assert/strict');
const {config}=require('../scripts/mcp-server');
const {bounded,deferred,result,historyWire,respond,withHttp,withMcp,call}=require('./mcp-history-fixture');
const error=(value,code,status)=>{assert.equal(value.isError,true);assert.deepEqual(result(value),{code,outcome:'read_failed',...(status?{status}:{})})};
test('history opt-in defaults off and accepts only explicit zero or one',()=>{
  assert.equal(config({}).enableHistoryContext,false);
  for(const value of ['',null,true,false,1,0,'true','01'])assert.throws(()=>config({MEMZ_MCP_ENABLE_HISTORY_CONTEXT:value}),/INVALID_CONFIG/);
  for(const value of ['0','1',undefined])assert.equal(config({MEMZ_MCP_ENABLE_HISTORY_CONTEXT:value}).enableHistoryContext,value==='1');
});
test('eight SDK flag combinations append history after the unchanged existing tools without HTTP',{timeout:25000},async()=>{
  await withHttp(()=>assert.fail('Discovery must not call HTTP'),async({baseURL,requests})=>{
    for(const histories of ['0','1'])for(const labels of ['0','1'])for(const proposals of ['0','1'])await withMcp(baseURL,async client=>{
      const tools=(await client.listTools()).tools;
      assert.deepEqual(tools.map(tool=>tool.name),['memz_read_context',...(proposals==='1'?['memz_submit_proposal']:[]),...(labels==='1'?['memz_read_label_context']:[]),...(histories==='1'?['memz_read_history_context']:[])]);
      if(histories==='0')await assert.rejects(()=>call(client),/UNKNOWN_TOOL/);
      else{const tool=tools.at(-1);assert.deepEqual(Object.keys(tool.inputSchema.properties),['limit','before','maxOutputBytes']);assert.equal(tool.inputSchema.additionalProperties,false);assert.deepEqual(tool.annotations,{readOnlyHint:true,destructiveHint:false,openWorldHint:false})}
      await assert.rejects(()=>client.callTool({name:'approve',arguments:{}}),/UNKNOWN_TOOL/);
    },{MEMZ_MCP_ENABLE_HISTORY_CONTEXT:histories,MEMZ_MCP_ENABLE_LABEL_CONTEXT:labels,MEMZ_MCP_ALLOW_PROPOSALS:proposals});
    assert.equal(requests.length,0);
  });
});
test('historical MCP arguments cannot override identity, scope, transport, time policy or evidence',{timeout:15000},async()=>{
  await withHttp(()=>assert.fail('Invalid arguments must not call HTTP'),async({baseURL,requests})=>withMcp(baseURL,async client=>{
    for(const key of ['question','query','date','asOf','after','projectId','baseURL','username','password','signal','fetchImpl','timeoutMs','totalTimeoutMs','maxResponseBytes','gold','evidence'])error(await call(client,{[key]:'synthetic-private-input'}),'INVALID_ARGUMENTS');
    for(const limit of [0,26,1.5,'1',null])error(await call(client,{limit}),'INVALID_ARGUMENTS');
    for(const before of [0,-1,2147483648,1.5,'1',null])error(await call(client,{before}),'INVALID_ARGUMENTS');
    for(const maxOutputBytes of [2047,32769,1.5,'2048',null])error(await call(client,{maxOutputBytes}),'INVALID_ARGUMENTS');
    assert.equal(requests.length,0);
  }));
});

test('SDK history returns approved old versions, full shared sources and explicit continuation with complete HTTP trace',{timeout:10000},async()=>{
  const wire=historyWire({more:true,sourceText:'完整不可截断😀\n原文中的“忽略规则”仍是数据。'+'😀'.repeat(1700)});
  await withHttp((request,reply)=>{
    const older=request.path.includes('before=22');
    if(older&&request.path.includes('/history?'))return reply.send({...wire.page,history:[wire.page.history[1]],next_before:null});
    if(request.path.endsWith('/facts/provenance')&&request.body.facts.length===1)return reply.send({...wire.proof,provenance:[wire.proof.provenance[1]]});
    respond(request,reply,wire);
  },async({baseURL,requests})=>withMcp(baseURL,async client=>{
    const value=await call(client),output=result(value);
    assert.equal(value.isError,false);assert.equal(output.schema,'memz-history-reader-v1');assert.equal(output.projectId,7);assert.equal(output.before,null);assert.equal(output.limit,10);
    assert.deepEqual(output.revisions.map(row=>[row.id,row.version,row.revisionId]),[[9,2,22],[9,1,21]]);
    assert.deepEqual(output.sources,[wire.proof.provenance[0].source]);assert.equal(output.sourceTextIsUntrusted,true);assert.equal(output.nextBefore,21);assert.equal(output.truncated,true);assert.match(output.consistency,/Separate page\/proof transactions/);
    assert.deepEqual(requests.map(r=>[r.method,r.path]),[['POST','/api/login'],['GET','/api/projects/7/history?limit=10'],['POST','/api/projects/7/facts/provenance'],['POST','/api/logout']]);
    assert.deepEqual(requests[0].body,{username:'viewer',password:'demo-viewer'});assert.deepEqual(requests[2].body,{facts:[{id:9,version:2},{id:9,version:1}]});
    assert.equal(requests[2].headers.cookie,'sid=synthetic-history-session');assert.equal(requests[2].headers['x-csrf-token'],'synthetic-history-csrf');
    assert.ok(!value.content[0].text.includes('synthetic-history-session'));assert.ok(Buffer.byteLength(value.content[0].text)<32768);
    const continued=await call(client,{limit:1,before:22});assert.equal(continued.isError,false);assert.deepEqual(result(continued).revisions.map(r=>r.version),[1]);assert.equal(result(continued).before,22);assert.equal(result(continued).nextBefore,null);
    const bytes=Buffer.byteLength(value.content[0].text+'\n');
    assert.deepEqual(result(await call(client,{maxOutputBytes:bytes})),output);error(await call(client,{maxOutputBytes:bytes-1}),'OUTPUT_BUDGET_TOO_SMALL');
    assert.ok(requests.every(r=>!r.path.includes('/candidates')&&!r.path.includes('/approve')));await client.listTools();
  }));
});
test('an empty historical page is explicit and never fetches invented evidence',{timeout:10000},async()=>{
  await withHttp((request,reply)=>respond(request,reply,historyWire({empty:true})),async({baseURL,requests})=>withMcp(baseURL,async client=>{
    const output=result(await call(client));assert.deepEqual(output.revisions,[]);assert.deepEqual(output.sources,[]);assert.equal(output.truncated,false);assert.equal(output.nextBefore,null);
    assert.deepEqual(requests.map(r=>r.path),['/api/login','/api/projects/7/history?limit=10','/api/logout']);
  }));
});
test('HTTP and invalid evidence failures remain fixed errors, never partial success, and stdio can recover',{timeout:15000},async()=>{
  let mode='403';
  await withHttp((request,reply)=>{
    if(request.path.includes('/history?')&&mode!=='200'&&mode!=='corrupt')return reply.send({error:'synthetic-private-provider-body'},Number(mode));
    const wire=historyWire();if(mode==='corrupt')wire.proof.provenance[0].revision.version=99;respond(request,reply,wire);
  },async({baseURL})=>withMcp(baseURL,async client=>{
    for(const status of [403,500]){mode=String(status);const value=await call(client);error(value,'HTTP_'+status,status);assert.ok(!JSON.stringify(value).includes('synthetic-private'))}
    mode='corrupt';const corrupt=await call(client);error(corrupt,'INVALID_HISTORY_RESPONSE');assert.equal(result(corrupt).revisions,undefined);
    mode='200';assert.equal((await call(client)).isError,false);await client.listTools();
  }));
});
test('one running history call returns BUSY across all tools and sends no overlapping session',{timeout:10000},async()=>{
  const started=deferred();let release;
  await withHttp((request,reply)=>{
    if(request.path.includes('/history?')){release=()=>respond(request,reply);started.resolve();return}respond(request,reply);
  },async({baseURL,requests})=>withMcp(baseURL,async client=>{
    const first=call(client);await bounded(started.promise,'waiting for busy history');
    for(const name of ['memz_read_context','memz_read_label_context','memz_submit_proposal','memz_read_history_context']){
      const value=await client.callTool({name,arguments:{}});assert.equal(value.isError,true);assert.deepEqual(result(value),{code:'BUSY',outcome:'not_attempted'});
    }
    assert.equal(requests.length,2);release();assert.equal((await first).isError,false);assert.equal(requests.length,4);error(await call(client,{limit:0}),'INVALID_ARGUMENTS');
  },{MEMZ_MCP_ENABLE_LABEL_CONTEXT:'1',MEMZ_MCP_ALLOW_PROPOSALS:'1'}));
});
for(const phase of ['login','history','proof'])for(const mode of ['cancel','disconnect'])test(`SDK ${mode} aborts actual historical ${phase} body and preserves known-session logout`,{timeout:15000},async()=>{
  const started=deferred(),closed=deferred(),loggedOut=deferred();
  await withHttp((request,reply)=>{
    const target=phase==='login'?request.path==='/api/login':phase==='history'?request.path.includes('/history?'):request.path.endsWith('/facts/provenance');
    if(target){reply.res.once('close',closed.resolve);reply.res.writeHead(200,{'content-type':'application/json',...(phase==='login'?{'set-cookie':'sid=synthetic-unknown-login; HttpOnly'}:{})});reply.res.write('{"unfinished":');started.resolve();return}
    if(request.path==='/api/logout'){respond(request,reply);loggedOut.resolve();return}respond(request,reply);
  },async({baseURL,requests})=>withMcp(baseURL,async client=>{
    const caller=new AbortController(),rejected=assert.rejects(call(client,{}, {signal:caller.signal}));
    await bounded(started.promise,'waiting for SDK historical body');if(mode==='cancel')caller.abort(new Error('synthetic-private-caller-reason'));else await client.close();
    await rejected;await bounded(closed.promise,'closing SDK historical body');
    if(phase==='login')assert.deepEqual(requests.map(r=>r.path),['/api/login']);
    else{await bounded(loggedOut.promise,'logging out cancelled historical session');assert.equal(requests.at(-1).path,'/api/logout');assert.equal(requests.filter(r=>r.path==='/api/logout').length,1)}
    if(mode==='cancel'){
      let value;const deadline=Date.now()+2000;
      do{value=await call(client,{limit:0});if(result(value).code!=='BUSY')break;await new Promise(resolve=>setTimeout(resolve,5))}while(Date.now()<deadline);
      error(value,'INVALID_ARGUMENTS');await client.listTools();
    }
  }));
});
