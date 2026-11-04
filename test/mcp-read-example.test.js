const {test}=require('node:test'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const script=path.resolve(__dirname,'../scripts/mcp-read-example.js');
test('read-only MCP example rejects invalid input and credential-bearing destinations without output leaks',()=>{
  for(const [args,baseURL] of [[['x'.repeat(201)],'http://127.0.0.1:9'],[['项目','-1'],'http://127.0.0.1:9'],[[],'http://user:synthetic-example-canary@127.0.0.1:9'],[[],'https://example.com']]){
    assert.throws(()=>execFileSync(process.execPath,[script,...args],{env:{...process.env,MEMZ_DEMO_BASE_URL:baseURL},timeout:5000,stdio:['ignore','pipe','pipe']}),e=>e.status===1&&e.stdout.length===0&&e.stderr.toString()==='{"code":"MCP_READ_FAILED"}\n');
  }
});

test('real local HTTP failure through MCP exposes only a fixed error code',async()=>{
  const http=require('node:http'),{once}=require('node:events');let requests=0;
  const server=http.createServer((req,res)=>{requests++;res.writeHead(503,{'content-type':'application/json','set-cookie':'sid=synthetic-secret-cookie'});res.end(JSON.stringify({error:'synthetic-private-body'}))});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const execute=require('node:util').promisify(require('node:child_process').execFile);
    await assert.rejects(()=>execute(process.execPath,[script,'项目'],{env:{...process.env,MEMZ_DEMO_BASE_URL:`http://127.0.0.1:${server.address().port}`,MEMZ_DEMO_PROJECT_ID:'1'},timeout:10000}),e=>e.code===1&&e.stdout===''&&e.stderr==='{"code":"HTTP_503"}\n');
    assert.equal(requests,1,'failed login must not proceed to data reads or retry');
  }finally{await new Promise(resolve=>server.close(resolve))}
});
