const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {page}=require('./label-context-fixture');
let requests=0;
const server=http.createServer((req,res)=>{
  req.resume();requests++;const url=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json');
  if(url.pathname==='/api/login'){res.setHeader('set-cookie','sid=synthetic-cli; HttpOnly');res.end(JSON.stringify({csrf:'synthetic-cli'}));return}
  if(url.pathname==='/api/logout'){res.end('{}');return}
  if(url.pathname!=='/api/projects/7/context'){res.statusCode=403;res.end('{}');return}
  res.end(JSON.stringify(page({query:url.searchParams.get('q'),searchMode:url.searchParams.get('match')||'substring'})));
});
const ready=new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
async function invoke(input,{env={},close=true,args=['--stdin']}={}){
  await ready;
  const child=spawn(process.execPath,['scripts/label-context.js',...args],{env:{...process.env,MEMZ_BASE_URL:`http://127.0.0.1:${server.address().port}`,MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',MEMZ_PROJECT_ID:'7',MEMZ_QUESTION:'晨桥服务的交付时间是什么？',...env},stdio:['pipe','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Label CLI did not terminate'))},10000);
    child.stdout.on('data',data=>{stdout+=data;if(Buffer.byteLength(stdout)>4194304){child.kill('SIGKILL');reject(new Error('Label CLI output exceeded its bound'))}});
    child.stderr.on('data',data=>stderr+=data);child.stdin.on('error',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Label CLI could not start'))});
    child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});
    if(close)child.stdin.end(input);else if(input)child.stdin.write(input);
  });
}
test('the explicit stdin and environment CLI return one bounded current receipt without credentials',async()=>{
  for(const options of [{},{args:[]}]){
    const before=requests,result=await invoke('{}',options);assert.equal(result.code,0);assert.equal(result.stderr,'');assert.equal(requests-before,6);
    const value=JSON.parse(result.stdout);assert.equal(value.status,'matched');assert.equal(value.context.facts.length,1);assert.equal(value.context.sources.length,1);
    assert.equal(value.execution.modelCalls,0);assert.equal(value.selection.candidateFacts,3);assert.equal(value.selection.retainedFacts,1);
    assert.ok(!result.stdout.includes('sid='));assert.ok(!result.stdout.includes('demo-viewer'));
  }
});
test('stdin cannot replace credentials, transport, vocabulary or fixed retrieval modes',async()=>{
  for(const key of ['password','username','baseURL','labels','value','answer','gold','evidence','searchMode','limit','after','provenanceMode','fetchImpl']){
    const before=requests,result=await invoke(JSON.stringify({[key]:'synthetic-private-input'}));
    assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/INVALID_STDIN_REQUEST/);assert.ok(!result.stderr.includes('synthetic-private-input'));assert.equal(requests,before);
  }
});
test('invalid bytes, oversized or unfinished stdin and invalid arguments fail before HTTP',async()=>{
  for(const input of ['{}\n{}','[{}]','x'.repeat(16385),Buffer.from([0xff,0xfe])]){
    const before=requests,result=await invoke(input);assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/INVALID_STDIN|INPUT_TOO_LARGE/);assert.equal(requests,before);
  }
  const before=requests,unfinished=await invoke('{',{close:false});assert.equal(unfinished.code,1);assert.match(unfinished.stderr,/INPUT_TIMEOUT/);assert.equal(unfinished.stdout,'');assert.equal(requests,before);
  const argumentsResult=await invoke('',{args:['--unsupported']});assert.equal(argumentsResult.code,1);assert.match(argumentsResult.stderr,/INVALID_ARGUMENTS/);assert.equal(requests,before);
});
test('missing scope and malformed configuration use fixed errors without echoing private input',async()=>{
  for(const options of [{env:{MEMZ_PROJECT_ID:''}},{env:{MEMZ_BASE_URL:'http://synthetic-private@[invalid'}},{env:{MEMZ_TOTAL_TIMEOUT_MS:'0'}}]){
    const before=requests,result=await invoke('{}',options);assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/INVALID_/);assert.ok(!result.stderr.includes('synthetic-private'));assert.equal(requests,before);
  }
  const before=requests,invalidUnicode=await invoke(JSON.stringify({question:'前\ud800后'}));
  assert.equal(invalidUnicode.code,1);assert.match(invalidUnicode.stderr,/INVALID_PLANNER_QUESTION/);assert.equal(invalidUnicode.stdout,'');assert.equal(requests,before);
});
test('declines remain explicit JSON while authorization and final output failures emit no partial stdout',async()=>{
  const before=requests,declined=await invoke('{"question":"它的交付时间是什么？"}');
  assert.equal(declined.code,0);assert.equal(declined.stderr,'');assert.equal(JSON.parse(declined.stdout).status,'needs_scope');assert.equal(requests-before,3);
  const denied=await invoke('{"projectId":99}');assert.equal(denied.code,1);assert.equal(denied.stdout,'');assert.match(denied.stderr,/HTTP_403/);
  const tiny=await invoke('{"maxOutputBytes":1}');assert.equal(tiny.code,1);assert.equal(tiny.stdout,'');assert.match(tiny.stderr,/OUTPUT_BUDGET_TOO_SMALL/);
});
