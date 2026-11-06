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

test('stdio rejects escaped unpaired Unicode surrogates without a session',async()=>{
  for(const query of ['前\ud800后','前\udc00后']){
    const before=requests,result=await invoke(JSON.stringify({query}));assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/INVALID_QUERY/);assert.equal(requests,before);
  }
});

test('stdio applies optional final output budget and returns no partial JSON when too small',async()=>{
  const result=await invoke(JSON.stringify({projectId:1,query:'项目',limit:1,maxOutputBytes:2000}));assert.equal(result.code,0,result.stderr);assert.ok(Buffer.byteLength(result.stdout)<=2000);assert.equal(JSON.parse(result.stdout).outputBudget.maxBytes,2000);
  const tiny=await invoke(JSON.stringify({projectId:1,maxOutputBytes:1}));assert.equal(tiny.code,1);assert.equal(tiny.stdout,'');assert.match(tiny.stderr,/OUTPUT_BUDGET_TOO_SMALL/);
  const before=requests,invalid=await invoke('{"maxOutputBytes":0}');assert.equal(invalid.code,1);assert.equal(invalid.stdout,'');assert.match(invalid.stderr,/INVALID_OUTPUT_BUDGET/);assert.equal(requests,before);
});

test('stdio accepts a continuation cursor and rejects invalid cursors before HTTP',async()=>{
  const first=await invoke('{"projectId":1,"limit":1}');assert.equal(first.code,0,first.stderr);const firstContext=JSON.parse(first.stdout),after=firstContext.facts[0].id;
  const next=await invoke(JSON.stringify({projectId:1,limit:1,after,maxOutputBytes:2000}));assert.equal(next.code,0,next.stderr);const result=JSON.parse(next.stdout);assert.equal(result.after,after);assert.ok(result.facts.every(f=>f.id>after));assert.ok(Buffer.byteLength(next.stdout)<=2000);
  const end=await invoke('{"after":2147483647}');assert.equal(end.code,0);assert.deepEqual(JSON.parse(end.stdout).facts,[]);assert.equal(JSON.parse(end.stdout).nextAfter,null);
  const before=requests,invalid=await invoke('{"after":-1}');assert.equal(invalid.code,1);assert.equal(invalid.stdout,'');assert.match(invalid.stderr,/INVALID_AFTER/);assert.equal(requests,before);
});

test('stdio and environment independently select batch and deduplicated context',async()=>{
  const request={projectId:1,query:'项目',limit:1,provenanceMode:'batch',sourceMode:'deduplicated'};
  const selected=await invoke(JSON.stringify(request));assert.equal(selected.code,0,selected.stderr);
  const context=JSON.parse(selected.stdout);assert.equal(context.schemaVersion,2);assert.equal(context.sourceTextIsUntrusted,true);assert.equal(context.sources.length,1);assert.equal(context.facts[0].sourceId,context.sources[0].id);assert.equal(context.facts[0].source,undefined);
  const env=await invoke('{"projectId":1,"query":"项目","limit":1}',{env:{MEMZ_PROVENANCE_MODE:'batch',MEMZ_SOURCE_MODE:'deduplicated'}});assert.equal(env.code,0,env.stderr);assert.deepEqual(JSON.parse(env.stdout),context);
  const overridden=await invoke('{"projectId":1,"query":"项目","limit":1,"provenanceMode":"individual","sourceMode":"inline"}',{env:{MEMZ_PROVENANCE_MODE:'batch',MEMZ_SOURCE_MODE:'deduplicated'}});assert.equal(overridden.code,0,overridden.stderr);assert.equal(JSON.parse(overridden.stdout).schemaVersion,1);
  for(const input of ['{"provenanceMode":"parallel"}','{"sourceMode":null}']){const before=requests,result=await invoke(input);assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/INVALID_(PROVENANCE|SOURCE)_MODE/);assert.equal(requests,before)}
});

test('stdio and environment opt into lexical matching and reject invalid search before HTTP',async()=>{
  const request={projectId:1,query:'截止日 项目',limit:1,searchMode:'all_terms',provenanceMode:'batch',sourceMode:'deduplicated'};
  const result=await invoke(JSON.stringify(request));assert.equal(result.code,0,result.stderr);const context=JSON.parse(result.stdout);
  assert.equal(context.facts.length,1);assert.deepEqual(context.search.terms,['截止日','项目']);assert.equal(context.search.order,'fact_id_asc');assert.equal(context.schemaVersion,2);
  const {searchMode,...withoutMode}=request;
  const env=await invoke(JSON.stringify(withoutMode),{env:{MEMZ_SEARCH_MODE:'all_terms'}});assert.equal(env.code,0,env.stderr);assert.deepEqual(JSON.parse(env.stdout),context);
  const overridden=await invoke(JSON.stringify({...request,searchMode:'substring'}),{env:{MEMZ_SEARCH_MODE:'all_terms'}});assert.equal(overridden.code,0,overridden.stderr);assert.equal(JSON.parse(overridden.stdout).search,undefined);
  for(const input of [{searchMode:'ranked'},{searchMode:null},{searchMode:'all_terms',query:' '},{searchMode:'all_terms',query:'a b c d e f g h i'}]){
    const before=requests,invalid=await invoke(JSON.stringify(input));assert.equal(invalid.code,1);assert.equal(invalid.stdout,'');assert.match(invalid.stderr,/INVALID_SEARCH_MODE|INVALID_QUERY|TOO_MANY_SEARCH_TERMS/);assert.equal(requests,before);
  }
});

test('stdio and environment opt into a bounded snapshot without changing default output',async()=>{
  const request={projectId:1,query:'截止日 项目',searchMode:'all_terms',limit:1,provenanceMode:'snapshot',sourceMode:'deduplicated'};
  const result=await invoke(JSON.stringify(request));assert.equal(result.code,0,result.stderr);const context=JSON.parse(result.stdout);
  assert.equal(context.facts.length,1);assert.equal(context.schemaVersion,2);assert.deepEqual(context.snapshot,{schema:'memz-context-snapshot-v1',consistency:'single-page-repeatable-read'});assert.equal(context.facts[0].sourceId,context.sources[0].id);
  const {provenanceMode,...withoutMode}=request;
  const env=await invoke(JSON.stringify(withoutMode),{env:{MEMZ_PROVENANCE_MODE:'snapshot'}});assert.equal(env.code,0,env.stderr);assert.deepEqual(JSON.parse(env.stdout),context);
  const overridden=await invoke(JSON.stringify({...request,provenanceMode:'individual'}),{env:{MEMZ_PROVENANCE_MODE:'snapshot'}});assert.equal(overridden.code,0,overridden.stderr);assert.equal(JSON.parse(overridden.stdout).snapshot,undefined);
  const before=requests,invalid=await invoke(JSON.stringify({...request,limit:26}));assert.equal(invalid.code,1);assert.equal(invalid.stdout,'');assert.match(invalid.stderr,/INVALID_SNAPSHOT_LIMIT/);assert.equal(requests,before);
  const tiny=await invoke(JSON.stringify({...request,maxOutputBytes:1}));assert.equal(tiny.code,1);assert.equal(tiny.stdout,'');assert.match(tiny.stderr,/OUTPUT_BUDGET_TOO_SMALL/);
});
