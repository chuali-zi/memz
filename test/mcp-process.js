const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
module.exports=async({baseURL,call,owner,member,viewer})=>{
  async function withClient(username,allow,fn,projectId=1){
    const transport=new StdioClientTransport({command:process.execPath,args:['scripts/mcp-server.js'],env:{...process.env,MEMZ_BASE_URL:baseURL,MEMZ_USERNAME:username,MEMZ_PASSWORD:`demo-${username}`,MEMZ_PROJECT_ID:String(projectId),MEMZ_MCP_ALLOW_PROPOSALS:allow?'1':'0'},stderr:'pipe'});
    const client=new Client({name:'synthetic-mcp-test',version:'1.0.0'});let stderr='';
    transport.stderr.on('data',b=>stderr+=b);
    try{await client.connect(transport);await fn(client)}finally{await client.close();assert.equal(stderr,'')}
  }
  const source=await call(member,'/api/projects/1/sources',{title:'MCP 合成依据',content:'MCP 流程截止日为18号。不是模型实测。'});assert.equal(source.status,200);
  const proposal={sourceId:source.data.id,subject:'MCP-'+randomUUID(),predicate:'截止日',value:'18号',expectedVersion:0,idempotencyKey:randomUUID()};
  let id;
  await withClient('member',true,async client=>{
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['memz_read_context','memz_submit_proposal']);
    const overlapping=await Promise.all([1,2].map(()=>client.callTool({name:'memz_read_context',arguments:{query:proposal.subject}})));
    assert.equal(overlapping.filter(r=>r.isError&&JSON.parse(r.content[0].text).code==='BUSY').length,1);
    assert.equal(overlapping.filter(r=>r.isError===false).length,1);
    const first=await client.callTool({name:'memz_submit_proposal',arguments:proposal});assert.equal(first.isError,false);const receipt=JSON.parse(first.content[0].text);id=receipt.candidateId;assert.equal(receipt.autoApproved,false);assert.equal(receipt.sessionCleanup,'logged_out');
    const second=await client.callTool({name:'memz_submit_proposal',arguments:proposal});assert.equal(JSON.parse(second.content[0].text).candidateId,id);
    const changed=await client.callTool({name:'memz_submit_proposal',arguments:{...proposal,value:'19号'}});assert.equal(changed.isError,true);assert.equal(JSON.parse(changed.content[0].text).status,409);
    const pending=await client.callTool({name:'memz_read_context',arguments:{query:proposal.subject}});assert.equal(JSON.parse(pending.content[0].text).facts.length,0);
    await assert.rejects(()=>client.callTool({name:'approve',arguments:{candidateId:id}}));
  });
  const state=(await call(viewer,'/api/projects/1/data')).data;
  assert.equal(state.candidates.filter(c=>c.subject===proposal.subject).length,1);assert.equal(state.candidates.find(c=>c.id===id).status,'pending');
  assert.equal(state.audit.filter(a=>a.action==='propose'&&a.detail===`候选 ${id}`).length,1);
  for(const username of ['viewer','other'])await withClient(username,true,async client=>{
    const denied=await client.callTool({name:'memz_submit_proposal',arguments:{...proposal,idempotencyKey:randomUUID()}});assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).status,403);
  });
  await withClient('member',true,async client=>{
    const denied=await client.callTool({name:'memz_submit_proposal',arguments:{...proposal,sourceId:4,idempotencyKey:randomUUID()}});assert.equal(JSON.parse(denied.content[0].text).status,400);
  });
  await withClient('viewer',false,async client=>{
    const denied=await client.callTool({name:'memz_read_context',arguments:{}});assert.equal(JSON.parse(denied.content[0].text).status,403);
  },2);
  const execute=require('node:util').promisify(require('node:child_process').execFile);
  const example=require('node:path').resolve(__dirname,'../scripts/mcp-read-example.js');
  const exampleEnv={...process.env,MEMZ_DEMO_BASE_URL:baseURL,MEMZ_DEMO_PROJECT_ID:'1',MEMZ_USERNAME:'owner',MEMZ_PASSWORD:'synthetic-example-canary',MEMZ_MCP_ALLOW_PROPOSALS:'1'};
  const beforeExample=(await call(viewer,'/api/projects/1/data')).data;
  const pendingExample=await execute(process.execPath,[example,proposal.subject],{env:exampleEnv,timeout:55000});
  assert.equal(pendingExample.stderr,'');assert.equal(JSON.parse(pendingExample.stdout).facts.length,0);
  assert.deepEqual((await call(viewer,'/api/projects/1/data')).data,beforeExample,'read-only host must not approve or mutate pending evidence');
  assert.equal((await call(owner,`/api/projects/1/candidates/${id}/approve`,{})).status,200);
  const approvedExample=await execute(process.execPath,[example,proposal.subject],{env:exampleEnv,timeout:55000});
  const exampleContext=JSON.parse(approvedExample.stdout);assert.equal(approvedExample.stderr,'');
  assert.equal(exampleContext.facts[0].source.id,source.data.id);assert.equal(exampleContext.facts[0].source.content,'MCP 流程截止日为18号。不是模型实测。');
  assert.equal(exampleContext.facts[0].candidateId,id);assert.equal(exampleContext.facts[0].version,1);assert.equal(exampleContext.sourceTextIsUntrusted,true);
  assert.ok(!approvedExample.stdout.includes('synthetic-example-canary'));
  const continuation=await execute(process.execPath,[example,proposal.subject,String(exampleContext.facts[0].id)],{env:exampleEnv,timeout:55000});assert.equal(JSON.parse(continuation.stdout).facts.length,0);
  await assert.rejects(()=>execute(process.execPath,[example,proposal.subject],{env:{...exampleEnv,MEMZ_DEMO_PROJECT_ID:'2'},timeout:55000}),e=>e.code===1&&e.stdout===''&&e.stderr==='{"code":"HTTP_403"}\n');
  await withClient('viewer',false,async client=>{
    const result=await client.callTool({name:'memz_read_context',arguments:{query:proposal.subject,maxOutputBytes:4096}});assert.equal(result.isError,false);
    const context=JSON.parse(result.content[0].text);assert.equal(context.facts[0].candidateId,id);assert.equal(context.facts[0].version,1);assert.equal(context.facts[0].source.id,source.data.id);assert.equal(context.sourceTextIsUntrusted,true);assert.ok(Buffer.byteLength(result.content[0].text)<=4096);
  });
};
