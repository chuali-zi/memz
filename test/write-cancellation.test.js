const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {submitProposal}=require('../scripts/proposal-client');
const {createSource}=require('../scripts/source-client');
const intent={projectId:1,sourceId:2,subject:'合成取消',predicate:'状态',value:'待审',expectedVersion:0,idempotencyKey:'synthetic-cancellation-key'};
const source={projectId:1,title:'合成来源',content:'只用于取消回归',idempotencyKey:'synthetic-source-cancellation-key'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const login=()=>new Response(JSON.stringify({csrf:'synthetic-csrf'}),{headers:{'set-cookie':'sid=synthetic-cancellation; HttpOnly'}});
const receipt=body=>({...body,id:7,project_id:1,status:'pending'});
async function service(handler,run){
  const requests=[],server=http.createServer((req,res)=>{
    const chunks=[];req.on('data',part=>chunks.push(part));req.on('end',()=>{
      const entry={path:req.url,key:req.headers['idempotency-key'],body:chunks.length?JSON.parse(Buffer.concat(chunks)):undefined};requests.push(entry);
      res.setHeader('content-type','application/json');handler(entry,res);
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{return await run({baseURL:`http://127.0.0.1:${server.address().port}`,requests})}
  finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
}
for(const [name,invoke] of [['proposal',options=>submitProposal({proposal:{...intent},...options})],['source',options=>createSource({source:{...source},...options})]]){
  test(`${name}: an already cancelled intent never logs in or starts a write`,async()=>{
    const controller=new AbortController();controller.abort(new Error('synthetic-private-cancellation-reason'));let calls=0;
    await assert.rejects(()=>invoke({signal:controller.signal,fetchImpl:async()=>{calls++;throw new Error('must not fetch')}}),{code:'REQUEST_CANCELLED',outcome:'not_attempted'});
    assert.equal(calls,0);
  });
  test(`${name}: cancellation after login stops before write and still logs out`,async()=>{
    const controller=new AbortController(),paths=[];
    await assert.rejects(()=>invoke({signal:controller.signal,fetchImpl:async(url,options)=>{
      paths.push(url.pathname);
      if(url.pathname==='/api/login'){controller.abort();return login()}
      assert.equal(url.pathname,'/api/logout');assert.equal(options.signal.aborted,false);return new Response('{}');
    }}),{code:'REQUEST_CANCELLED',outcome:'not_attempted'});
    assert.deepEqual(paths,['/api/login','/api/logout']);
  });
}
test('real HTTP login cancellation closes the request and never starts a candidate POST',{timeout:15000},async()=>{
  const started=deferred(),closed=deferred();
  await service((entry,res)=>{assert.equal(entry.path,'/api/login');res.on('close',closed.resolve);started.resolve()},async({baseURL,requests})=>{
    const controller=new AbortController(),running=submitProposal({baseURL,proposal:intent,signal:controller.signal});
    const rejected=assert.rejects(running,{code:'REQUEST_CANCELLED',outcome:'not_attempted'});
    await started.promise;controller.abort();await rejected;await closed.promise;
    assert.deepEqual(requests.map(r=>r.path),['/api/login']);
  });
});
test('real HTTP cancellation during a write response keeps unknown outcome, stable intent and independent logout',{timeout:15000},async()=>{
  const writing=deferred(),closed=deferred();let sentBody;
  await service((entry,res)=>{
    if(entry.path==='/api/login'){res.setHeader('set-cookie','sid=synthetic-cancellation');res.end(JSON.stringify({csrf:'synthetic-csrf'}))}
    else if(entry.path==='/api/logout')res.end('{}');
    else{sentBody=entry.body;res.write('{"id":');res.on('close',closed.resolve);writing.resolve()}
  },async({baseURL,requests})=>{
    const controller=new AbortController(),original={...intent},running=submitProposal({baseURL,proposal:original,signal:controller.signal});
    const rejected=assert.rejects(running,{code:'REQUEST_CANCELLED',outcome:'unknown'});
    original.value='must not change the intent';await writing.promise;controller.abort();await rejected;await closed.promise;
    assert.equal(sentBody.value,intent.value);
    assert.deepEqual(requests.map(r=>r.path),['/api/login','/api/projects/1/candidates','/api/logout']);
    assert.equal(requests[1].key,intent.idempotencyKey);
  });
});
test('logout 401 cancels an unfinished real HTTP body before reporting cleanup complete',{timeout:15000},async()=>{
  const closed=deferred();let logoutClosed=false;
  await service((entry,res)=>{
    if(entry.path==='/api/login'){res.setHeader('set-cookie','sid=synthetic-cancellation');res.end(JSON.stringify({csrf:'synthetic-csrf'}))}
    else if(entry.path==='/api/logout'){res.writeHead(401);res.write('unfinished');res.on('close',()=>{logoutClosed=true;closed.resolve()})}
    else res.end(JSON.stringify(receipt(entry.body)));
  },async({baseURL})=>{
    const result=await submitProposal({baseURL,proposal:intent});assert.equal(result.sessionCleanup,'logged_out');
    for(let i=0;i<50&&!logoutClosed;i++)await delay(5);
    assert.equal(logoutClosed,true,'unused logout body must close without waiting for its five second timeout');await closed.promise;
  });
});
test('a rejected write keeps its sanitized HTTP outcome when cancelling its unused body fails',async()=>{
  for(const status of [403,500])for(const bodyKind of ['cancel-rejects','errored-stream']){
    const paths=[];
    await assert.rejects(()=>submitProposal({proposal:intent,fetchImpl:async(url)=>{
      paths.push(url.pathname);
      if(url.pathname==='/api/login')return login();
      if(url.pathname==='/api/logout')return new Response('{}');
      const error=new Error('synthetic-private-body-failure');
      if(bodyKind==='errored-stream')return new Response(new ReadableStream({start(controller){controller.error(error)}}),{status});
      return {ok:false,status,body:{cancel:async()=>{throw error}}};
    }}),{code:`HTTP_${status}`,message:`HTTP_${status}`,outcome:status===403?'rejected':'unknown',status});
    assert.deepEqual(paths,['/api/login','/api/projects/1/candidates','/api/logout']);
  }
});
test('logout 401 with an errored body reports cleanup failure without changing a confirmed creation receipt',async()=>{
  const result=await submitProposal({proposal:intent,fetchImpl:async(url,options)=>{
    if(url.pathname==='/api/login')return login();
    if(url.pathname==='/api/logout')return new Response(new ReadableStream({start(controller){controller.error(new Error('synthetic-private-cleanup-failure'))}}),{status:401});
    return new Response(JSON.stringify(receipt(JSON.parse(options.body))));
  }});
  assert.equal(result.candidateId,7);assert.equal(result.sessionCleanup,'logout_failed');assert.ok(!JSON.stringify(result).includes('synthetic-private'));
});
test('real SDK cancellation during login prevents any later candidate request and releases BUSY',{timeout:15000},async()=>{
  const started=deferred(),closed=deferred();
  await service((entry,res)=>{assert.equal(entry.path,'/api/login');res.on('close',closed.resolve);started.resolve()},async({baseURL,requests})=>{
    const transport=new StdioClientTransport({command:process.execPath,args:[require('node:path').resolve(__dirname,'../scripts/mcp-server.js')],env:{MEMZ_BASE_URL:baseURL,MEMZ_MCP_ALLOW_PROPOSALS:'1'},stderr:'pipe'});
    const client=new Client({name:'synthetic-cancellation-regression',version:'1'});let stderr='';transport.stderr.on('data',b=>stderr+=b);
    try{
      await client.connect(transport);const controller=new AbortController();
      const {projectId,...arguments_}=intent;
      const rejected=assert.rejects(client.callTool({name:'memz_submit_proposal',arguments:arguments_},undefined,{signal:controller.signal,timeout:10000}));
      await started.promise;controller.abort();await rejected;await client.listTools();await closed.promise;
      let result;
      for(let i=0;i<50;i++){result=await client.callTool({name:'memz_read_context',arguments:{limit:0}});if(JSON.parse(result.content[0].text).code!=='BUSY')break;await delay(5)}
      assert.equal(JSON.parse(result.content[0].text).code,'INVALID_ARGUMENTS');
      assert.deepEqual(requests.map(r=>r.path),['/api/login']);
    }finally{await client.close();assert.equal(stderr,'')}
  });
});
for(const mode of ['cancel','disconnect'])test(`real SDK ${mode} during an accepted write closes HTTP, logs out and never retries`,{timeout:15000},async()=>{
  const writing=deferred(),closed=deferred(),loggedOut=deferred();let accepted=0;
  await service((entry,res)=>{
    if(entry.path==='/api/login'){res.setHeader('set-cookie','sid=synthetic-cancellation');res.end(JSON.stringify({csrf:'synthetic-csrf'}))}
    else if(entry.path==='/api/logout'){res.end('{}');loggedOut.resolve()}
    else{accepted++;res.on('close',closed.resolve);writing.resolve()}
  },async({baseURL,requests})=>{
    const transport=new StdioClientTransport({command:process.execPath,args:[require('node:path').resolve(__dirname,'../scripts/mcp-server.js')],env:{MEMZ_BASE_URL:baseURL,MEMZ_MCP_ALLOW_PROPOSALS:'1'},stderr:'pipe'});
    const client=new Client({name:'synthetic-write-interruption',version:'1'});let stderr='';transport.stderr.on('data',b=>stderr+=b);
    try{
      await client.connect(transport);const controller=new AbortController(),{projectId,...arguments_}=intent;
      const rejected=assert.rejects(client.callTool({name:'memz_submit_proposal',arguments:arguments_},undefined,{signal:controller.signal,timeout:10000}));
      await writing.promise;if(mode==='cancel')controller.abort();else await client.close();
      await rejected;await closed.promise;await loggedOut.promise;
      assert.equal(accepted,1,'the request was already accepted; cancellation must not imply rollback or retry');
      assert.deepEqual(requests.map(r=>r.path),['/api/login','/api/projects/1/candidates','/api/logout']);assert.equal(requests[1].key,intent.idempotencyKey);
    }finally{await client.close();assert.equal(stderr,'')}
  });
});
