// Real MCP processes, isolated HTTP service, synthetic intent persisted before a killed write.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
module.exports=async({baseURL,call,owner,member,viewer})=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memz-mcp-recovery-'));
  let mode='',activeTransport,committedId,abandonedAuth,writeResponses=0,proofFailures=0;
  const proxy=http.createServer(async(req,res)=>{
    try{
      if(mode==='proof-failure'&&req.method==='GET'&&req.url.includes('/provenance')){
        mode='';proofFailures++;res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"synthetic-private-provenance-body"}');return;
      }
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const response=await fetch(new URL(req.url,baseURL),{method:req.method,headers:{'content-type':'application/json',...(req.headers.cookie?{cookie:req.headers.cookie}:{}),...(req.headers['x-csrf-token']?{'x-csrf-token':req.headers['x-csrf-token']}:{}),...(req.headers['idempotency-key']?{'idempotency-key':req.headers['idempotency-key']}:{})},...(req.method==='GET'?{}:{body:Buffer.concat(chunks)}),signal:AbortSignal.timeout(5000)});
      const bytes=Buffer.from(await response.arrayBuffer());
      if(mode==='kill-after-commit'&&req.url==='/api/login'&&response.status===200)abandonedAuth={cookie:response.headers.get('set-cookie').split(';')[0],csrf:JSON.parse(bytes).csrf};
      if(mode==='kill-after-commit'&&req.url==='/api/projects/1/candidates'&&response.status===200){
        committedId=JSON.parse(bytes).id;writeResponses++;mode='';
        assert.ok(activeTransport.pid);process.kill(activeTransport.pid,'SIGKILL');res.destroy();return;
      }
      res.writeHead(response.status,{'content-type':'application/json',...(response.headers.get('set-cookie')?{'set-cookie':response.headers.get('set-cookie')}:{})});res.end(bytes);
    }catch{res.destroy()}
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const target=`http://127.0.0.1:${proxy.address().port}`;
  async function connect(username,fn){
    const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(__dirname,'../scripts/mcp-server.js')],env:{MEMZ_BASE_URL:target,MEMZ_USERNAME:username,MEMZ_PASSWORD:`demo-${username}`,MEMZ_PROJECT_ID:'1',MEMZ_MCP_ALLOW_PROPOSALS:'1'},stderr:'pipe'});
    const client=new Client({name:'synthetic-recovery-host',version:'1'});let stderr='';transport.stderr.on('data',b=>stderr+=b);
    activeTransport=transport;
    try{await client.connect(transport,{timeout:5000});return await fn(client)}finally{await client.close();activeTransport=null;assert.equal(stderr,'')}
  }
  const invoke=(client,name,arguments_)=>client.callTool({name,arguments:arguments_},undefined,{timeout:15000});
  try{
    const source=await call(member,'/api/projects/1/sources',{title:'MCP 恢复依据（合成）',content:'恢复演练的截止日为18号；非真实模型或业务记录。'});assert.equal(source.status,200);
    const intent={sourceId:source.data.id,subject:'MCP恢复-'+randomUUID(),predicate:'截止日',value:'18号',expectedVersion:0,idempotencyKey:randomUUID()};
    const file=path.join(dir,'intent.json');fs.writeFileSync(file,JSON.stringify(intent));
    const before=(await call(viewer,'/api/projects/1/data')).data;
    await connect('viewer',async client=>{
      const result=await invoke(client,'memz_submit_proposal',intent);assert.equal(result.isError,true);assert.deepEqual(JSON.parse(result.content[0].text),{code:'HTTP_403',outcome:'rejected',status:403});
    });
    await connect('member',async client=>{
      for(const sourceId of [4,2147483647]){
        const result=await invoke(client,'memz_submit_proposal',{...intent,sourceId,idempotencyKey:randomUUID()});assert.equal(result.isError,true);assert.deepEqual(JSON.parse(result.content[0].text),{code:'HTTP_400',outcome:'rejected',status:400});
      }
    });
    assert.deepEqual((await call(viewer,'/api/projects/1/data')).data,before,'denied writes cannot create candidates or audit rows');
    mode='kill-after-commit';
    await connect('member',async client=>{
      await assert.rejects(()=>invoke(client,'memz_submit_proposal',JSON.parse(fs.readFileSync(file))));
      assert.ok(committedId);assert.equal(writeResponses,1);
    });
    // Release only the synthetic session whose process was killed before logout.
    if(abandonedAuth){assert.equal((await call(abandonedAuth,'/api/logout',{})).status,200);abandonedAuth=null}
    await connect('member',async client=>{
      const resumed=await invoke(client,'memz_submit_proposal',JSON.parse(fs.readFileSync(file)));assert.equal(resumed.isError,false);
      const receipt=JSON.parse(resumed.content[0].text);assert.equal(receipt.candidateId,committedId);assert.equal(receipt.statusAtCreation,'pending');assert.equal(receipt.autoApproved,false);
      const changed=await invoke(client,'memz_submit_proposal',{...intent,value:'19号'});assert.equal(JSON.parse(changed.content[0].text).status,409);
      const pending=await invoke(client,'memz_read_context',{query:intent.subject});assert.equal(JSON.parse(pending.content[0].text).facts.length,0);
    });
    const recovered=(await call(viewer,'/api/projects/1/data')).data;
    assert.equal(recovered.candidates.filter(c=>c.subject===intent.subject).length,1);assert.equal(recovered.candidates.find(c=>c.id===committedId).status,'pending');
    assert.equal(recovered.audit.filter(a=>a.action==='propose'&&a.detail===`候选 ${committedId}`).length,1);
    assert.equal((await call(viewer,`/api/projects/1/candidates/${committedId}/approve`,{})).status,403);
    assert.equal((await call(owner,`/api/projects/1/candidates/${committedId}/approve`,{})).status,200);
    mode='proof-failure';
    await connect('viewer',async client=>{
      const failed=await invoke(client,'memz_read_context',{query:intent.subject});assert.equal(failed.isError,true);
      assert.deepEqual(JSON.parse(failed.content[0].text),{code:'HTTP_503',outcome:'read_failed',status:503});assert.ok(!JSON.stringify(failed).includes('synthetic-private'));
      const good=await invoke(client,'memz_read_context',{query:intent.subject});assert.equal(good.isError,false);
      const fact=JSON.parse(good.content[0].text).facts[0];assert.equal(fact.candidateId,committedId);assert.equal(fact.version,1);assert.equal(fact.source.id,source.data.id);assert.equal(fact.source.content,source.data.content);
    });
    assert.equal(proofFailures,1);
    console.log('Synthetic MCP recovery result:',JSON.stringify({synthetic:true,killedAfterCommit:true,restartedFromSavedIntent:true,candidateId:committedId,sourceId:source.data.id,singleProposalAudit:true,pendingUntilOwnerApproval:true,deniedWritesUnchanged:true,provenance503NoPartialContext:true,retryVersion:1}));
  }finally{
    if(abandonedAuth)await call(abandonedAuth,'/api/logout',{});
    proxy.closeAllConnections();await new Promise(r=>proxy.close(r));fs.rmSync(dir,{recursive:true,force:true});
  }
};
