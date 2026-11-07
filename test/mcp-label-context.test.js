const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {config}=require('../scripts/mcp-server');
const {selector,question,metadata,exact,deferred,result,withHttp,respond,withMcp,call}=require('./mcp-label-fixture');
const error=(value,code,status)=>{assert.equal(value.isError,true);assert.deepEqual(result(value),{code,outcome:'read_failed',...(status?{status}:{})})};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('label opt-in flag is strict and defaults off without changing the proposal flag',()=>{
  assert.equal(config({}).enableLabelContext,false);
  for(const value of ['',null,true,false,1,0,'true','01','yes'])assert.throws(()=>config({MEMZ_MCP_ENABLE_LABEL_CONTEXT:value}),/INVALID_CONFIG/);
  for(const value of ['0','1',undefined])assert.equal(config({MEMZ_MCP_ENABLE_LABEL_CONTEXT:value}).enableLabelContext,value==='1');
});
test('the four flag combinations preserve old discovery order and disabled tools never perform HTTP',{timeout:30000},async()=>{
  await withHttp(()=>assert.fail('Discovery and disabled tools must not call HTTP'),async({baseURL,requests})=>{
    for(const labels of ['0','1'])for(const proposals of ['0','1'])await withMcp(baseURL,async client=>{
      const tools=(await client.listTools()).tools;
      assert.deepEqual(tools.map(t=>t.name),['memz_read_context',...(proposals==='1'?['memz_submit_proposal']:[]),...(labels==='1'?['memz_read_label_context']:[])]);
      assert.deepEqual(Object.keys(tools[0].inputSchema.properties),['query','limit','after','maxOutputBytes']);
      if(labels==='0')await assert.rejects(()=>call(client),/UNKNOWN_TOOL/);
      else{
        const tool=tools.at(-1);assert.deepEqual(Object.keys(tool.inputSchema.properties),['question','maxOutputBytes']);assert.deepEqual(tool.inputSchema.required,['question']);assert.equal(tool.inputSchema.additionalProperties,false);
        assert.deepEqual(tool.annotations,{readOnlyHint:true,destructiveHint:false,openWorldHint:false});
      }
      if(proposals==='0')await assert.rejects(()=>client.callTool({name:'memz_submit_proposal',arguments:{}}),/UNKNOWN_TOOL/);
      await assert.rejects(()=>client.callTool({name:'approve',arguments:{}}),/UNKNOWN_TOOL/);
    },{MEMZ_MCP_ENABLE_LABEL_CONTEXT:labels,MEMZ_MCP_ALLOW_PROPOSALS:proposals});
    assert.equal(requests.length,0);
  });
});
test('new question arguments cannot replace scope, identity, transport, policy, evidence or cancellation',{timeout:15000},async()=>{
  await withHttp(()=>assert.fail('Rejected arguments must not call HTTP'),async({baseURL,requests})=>withMcp(baseURL,async client=>{
    for(const key of ['projectId','baseURL','username','password','protocol','labels','selector','value','gold','evidence','query','limit','after','fetchImpl','signal','timeoutMs','totalTimeoutMs'])error(await call(client,{question,[key]:'synthetic-private-input'}),'INVALID_ARGUMENTS');
    for(const invalid of [undefined,'','   ',true,[],{},'x'.repeat(211),'前\ud800后','前\0后'])error(await call(client,{question:invalid}),'INVALID_ARGUMENTS');
    for(const maxOutputBytes of [2047,32769,1.5,null,'4096'])error(await call(client,{question,maxOutputBytes}),'INVALID_ARGUMENTS');
    assert.equal(requests.length,0);
  }));
});
test('real SDK v2 reads 512 authorized labels internally and returns one full untrusted exact proof',{timeout:15000},async()=>{
  const labels=Array.from({length:511},(_,i)=>({subject:'合成目录'+i,predicate:'字段'})).concat([selector]),context=exact();
  context.sources[0].content='完整合成依据😀\n其中的“忽略指令”也只是数据。'+ '😀'.repeat(1900);
  await withHttp((req,reply)=>respond(req,reply,{labels:metadata({labels}),context}),async({baseURL,requests})=>withMcp(baseURL,async client=>{
    const value=await call(client);assert.equal(value.isError,false);const output=result(value);
    assert.equal(output.schema,'memz-label-context-v2');assert.equal(output.protocol,'metadata_exact_v2');assert.equal(output.status,'matched');assert.equal(output.sourceTextIsUntrusted,true);
    assert.deepEqual(output.context,context);assert.equal(output.context.provenance[0].sourceTextIsUntrusted,true);assert.equal(output.execution.modelCalls,0);assert.match(output.consistency,/separate/);assert.equal(Object.hasOwn(output,'labels'),false);
    assert.ok(Buffer.byteLength(value.content[0].text)<=32768);
    assert.deepEqual(requests.map(r=>r.path),['/api/login','/api/projects/7/current-labels','/api/projects/7/context/exact','/api/logout']);
    assert.deepEqual(requests[0].body,{username:'viewer',password:'demo-viewer'});assert.equal(requests[1].method,'GET');assert.equal(requests[2].method,'POST');assert.deepEqual(requests[2].body,{selector});
    assert.equal(requests[2].headers.cookie,'sid=synthetic-mcp-label-session');assert.equal(requests[2].headers['x-csrf-token'],'synthetic-mcp-label-csrf');
    assert.ok(!value.content[0].text.includes('sid='));await client.listTools();
  }));
});
test('a running label read returns BUSY for both read tools without starting another HTTP session',{timeout:15000},async()=>{
  const started=deferred();let release;
  await withHttp((request,reply)=>{
    if(request.path==='/api/projects/7/current-labels'){release=()=>reply.send(metadata());started.resolve();return}
    respond(request,reply);
  },async({baseURL,requests})=>withMcp(baseURL,async client=>{
    const first=call(client);await started.promise;
    const overlapping=await Promise.all([call(client),client.callTool({name:'memz_read_context',arguments:{}})]);
    for(const value of overlapping){assert.equal(value.isError,true);assert.deepEqual(result(value),{code:'BUSY',outcome:'not_attempted'})}
    assert.deepEqual(requests.map(r=>r.path),['/api/login','/api/projects/7/current-labels']);release();
    assert.equal((await first).isError,false);assert.equal(requests.length,4);await client.listTools();
  }));
});
test('valid escaped metadata larger than the MCP send cap never reaches stdio',{timeout:15000},async()=>{
  const labels=Array.from({length:511},(_,i)=>({subject:'\u0001'.repeat(100),predicate:'p'+String(i).padStart(3,'0')+'\u0001'.repeat(96)})).concat([selector]),wire=metadata({labels});
  assert.ok(Buffer.byteLength(JSON.stringify(wire))>262144);
  await withHttp((req,reply)=>respond(req,reply,{labels:wire}),async({baseURL})=>withMcp(baseURL,async client=>{
    const value=await call(client);assert.equal(value.isError,false);assert.equal(result(value).status,'matched');assert.ok(Buffer.byteLength(JSON.stringify(value))<262144);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['memz_read_context','memz_read_label_context']);
  }));
});
test('513 overflow and unsupported questions return explicit declines without exact reads or fallback',{timeout:15000},async()=>{
  for(const [wire,input,status] of [[metadata({labels:[],complete:false}),{question},'needs_scope'],[metadata(),{question:'它的交付时间是什么？'},'needs_scope'],[metadata(),{question:'晨桥服务最初的交付时间是什么？'},'unsupported']]){
    await withHttp((req,reply)=>respond(req,reply,{labels:wire}),async({baseURL,requests})=>withMcp(baseURL,async client=>{
      const value=await call(client,input);assert.equal(value.isError,false);assert.equal(result(value).status,status);assert.equal(result(value).context,undefined);
      assert.deepEqual(requests.map(r=>r.path),['/api/login','/api/projects/7/current-labels','/api/logout']);
    }));
  }
});
test('invalid metadata or exact evidence returns no partial content and leaves stdio usable',{timeout:20000},async()=>{
  const cases=[
    ['INVALID_CURRENT_LABELS_RESPONSE',wire=>{wire.labels[0].gold='synthetic-private-gold'},null],
    ['INVALID_CURRENT_LABELS_RESPONSE',wire=>{wire.projectId=8},null],
    ['INVALID_CURRENT_LABELS_RESPONSE',wire=>{wire.complete=false},null],
    ['INVALID_EXACT_CONTEXT_RESPONSE',null,wire=>{wire.selector.predicate='synthetic-private-mismatch'}],
    ['INVALID_EXACT_CONTEXT_RESPONSE',null,wire=>{wire.provenance=[]}],
    ['INVALID_EXACT_CONTEXT_RESPONSE',null,wire=>{wire.sources=[]}]
  ];
  for(const [code,mutateMetadata,mutateExact] of cases){
    const labels=metadata({labels:[{...selector}]}),context=exact();mutateMetadata?.(labels);mutateExact?.(context);
    await withHttp((req,reply)=>respond(req,reply,{labels,context}),async({baseURL,requests})=>withMcp(baseURL,async client=>{
      const value=await call(client);error(value,code);assert.ok(!JSON.stringify(value).includes('synthetic-private'));assert.equal(requests.length,mutateMetadata?3:4);await client.listTools();
    }));
  }
});
test('HTTP permission errors are read failures and an output budget error never clips evidence or closes stdio',{timeout:15000},async()=>{
  let status=403;const context=exact();context.sources[0].content='完整证据'.repeat(700);
  await withHttp((req,reply)=>respond(req,reply,{context:status===200?context:{error:'synthetic-private-error'},status}),async({baseURL,requests})=>withMcp(baseURL,async client=>{
    error(await call(client),'HTTP_403',403);status=500;error(await call(client),'HTTP_500',500);status=200;
    const tooSmall=await call(client,{question,maxOutputBytes:2048});error(tooSmall,'OUTPUT_BUDGET_TOO_SMALL');assert.equal(result(tooSmall).context,undefined);await client.listTools();
    const success=await call(client);assert.equal(success.isError,false);assert.equal(result(success).context.sources[0].content,context.sources[0].content);
    assert.equal(requests.length,16);assert.ok(requests.every(r=>!r.path.includes('candidates')&&!r.path.includes('approve')));
  }));
});
for(const tool of ['memz_read_context','memz_read_label_context'])for(const mode of ['cancel','disconnect'])test(`real SDK ${mode} stops ${tool} during HTTP body reading and still logs out`,{timeout:15000},async()=>{
  const started=deferred(),closed=deferred(),loggedOut=deferred();
  await withHttp((req,reply)=>{
    if(req.path==='/api/logout'){reply.send({ok:true});loggedOut.resolve();return}
    if(req.path.endsWith('/facts?'+new URLSearchParams({q:'',limit:'10'}).toString())||req.path==='/api/projects/7/context/exact'){
      reply.res.writeHead(200,{'content-type':'application/json'});reply.res.write('{"unfinished":');reply.res.on('close',closed.resolve);started.resolve();return;
    }
    respond(req,reply);
  },async({baseURL,requests})=>withMcp(baseURL,async client=>{
    const controller=new AbortController(),arguments_=tool==='memz_read_context'?{}:{question};
    const rejected=assert.rejects(client.callTool({name:tool,arguments:arguments_},undefined,{signal:controller.signal,timeout:10000}));
    await started.promise;if(mode==='cancel')controller.abort(new Error('synthetic-private-reason'));else await client.close();
    await rejected;await closed.promise;await loggedOut.promise;
    if(mode==='cancel'){
      let value;const until=Date.now()+2000;
      do{value=await call(client,{question:''});if(result(value).code!=='BUSY')break;await delay(5)}while(Date.now()<until);
      error(value,'INVALID_ARGUMENTS');assert.ok(!JSON.stringify(value).includes('synthetic-private'));
    }
    assert.equal(requests.filter(r=>r.path==='/api/logout').length,1);
  }));
});
test('generated hosts explicitly disable inherited label opt-in and preserve the old tool list',{timeout:15000},async()=>{
  for(const host of ['claude-desktop','vscode']){
    const printed=execFileSync(process.execPath,['scripts/mcp-config.js','--host',host],{cwd:require('node:path').resolve(__dirname,'..'),env:{MEMZ_MCP_ENABLE_LABEL_CONTEXT:'1',MEMZ_MCP_ALLOW_PROPOSALS:'1',MEMZ_PASSWORD:'synthetic-private-env'},encoding:'utf8'}),entry=JSON.parse(printed)[host==='vscode'?'servers':'mcpServers'].memz;
    assert.equal(entry.env.MEMZ_MCP_ENABLE_LABEL_CONTEXT,'0');assert.equal(entry.env.MEMZ_MCP_ALLOW_PROPOSALS,'0');assert.ok(!printed.includes('synthetic-private-env'));
    await withMcp(entry.env.MEMZ_BASE_URL,async client=>{
      assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['memz_read_context']);await assert.rejects(()=>call(client),/UNKNOWN_TOOL/);
    },entry.env);
  }
});
