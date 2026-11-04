const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {app,pool}=require('../server');
const server=app.listen(0,'127.0.0.1');
const ready=require('node:events').once(server,'listening');let requests=0;server.on('request',()=>requests++);
after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end()});
async function invoke(input,{env={},close=true}={}){
  await ready;
  const child=spawn(process.execPath,['scripts/context-client.js','--stdin'],{env:{...process.env,MEMZ_BASE_URL:`http://127.0.0.1:${server.address().port}`,MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',...env},stdio:['pipe','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('client process did not terminate'))},10000);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>4*1024*1024){child.kill();reject(new Error('unbounded child output'))}});
    child.stderr.on('data',chunk=>{stderr+=chunk});child.stdin.on('error',()=>{});
    child.on('error',error=>{clearTimeout(timer);reject(error)});
    child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});
    if(close)child.stdin.end(input);else if(input)child.stdin.write(input);
  });
}
test('stdio child reads real authenticated context as one JSON result',async()=>{
  const result=await invoke(JSON.stringify({projectId:1,query:'项目',limit:1}));assert.equal(result.code,0,result.stderr);assert.equal(result.stderr,'');
  const context=JSON.parse(result.stdout);assert.equal(context.projectId,1);assert.equal(context.facts.length,1);assert.ok(context.facts[0].revisionId>0);assert.ok(context.facts[0].source.id>0);
  assert.equal(context.sourceTextIsUntrusted,true);assert.ok(!result.stdout.includes('demo-viewer'));assert.ok(!result.stdout.includes('sid='));
});
test('stdio request cannot override credentials or transport and invalid input causes no request',async()=>{
  for(const input of ['{"password":"synthetic-secret-marker"}','{"baseURL":"http://example.invalid"}','{}\n{}','[{}]','x'.repeat(16385)]){
    const before=requests,result=await invoke(input);assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/INVALID_STDIN|INPUT_TOO_LARGE/);assert.ok(!result.stderr.includes('synthetic-secret-marker'));assert.equal(requests,before);
  }
});
test('stdio child returns no partial context for unauthorized project',async()=>{
  const result=await invoke('{"projectId":1}',{env:{MEMZ_USERNAME:'other',MEMZ_PASSWORD:'demo-other'}});
  assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/HTTP_403/);assert.ok(!result.stderr.includes('demo-other'));
});
test('stdio child terminates if its parent never ends the request',async()=>{
  const before=requests,result=await invoke('{',{close:false});assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/INPUT_TIMEOUT/);assert.equal(requests,before);
});

test('stdio rejects a NUL query before opening a session',async()=>{
  const before=requests,result=await invoke(JSON.stringify({query:'前\u0000后'}));
  assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/INVALID_QUERY/);assert.equal(requests,before);
});
