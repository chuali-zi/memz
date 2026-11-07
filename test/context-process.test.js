const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {Client}=require('pg'),{randomBytes}=require('node:crypto');
const {databasePoolOptions}=require('../scripts/database');
const suffix=randomBytes(8).toString('hex'),database='memz_context_process_'+suffix,role='memz_context_process_role_'+suffix;
const originalDatabaseURL=process.env.DATABASE_URL,children=new Map(),sockets=new Set();
let admin,owner,service,server,ready,appURL,created=false,roleCreated=false,adminConnected=false,requests=0;
const fixtureClient=url=>new Client({...databasePoolOptions(url),connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});
async function within(promise,ms){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Context process fixture cleanup deadline')),ms)})])}
  finally{clearTimeout(timer)}
}
before(async()=>{
  // File-level parallelism must not let integration.test.js approve project 1
  // between the CLI and ENV reads whose identical output is asserted below.
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use an isolated local test administrator connection');
  try{
    admin=fixtureClient(process.env.MIGRATION_TEST_DATABASE_URL);admin.on('error',()=>{});
    assert.ok(['127.0.0.1','localhost','::1','[::1]'].includes(admin.host));
    await admin.connect();adminConnected=true;await admin.query(`CREATE DATABASE ${database}`);created=true;
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'context_process_synthetic_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);roleCreated=true;
    const ownerURL=new URL(process.env.MIGRATION_TEST_DATABASE_URL);ownerURL.pathname='/'+database;
    owner=fixtureClient(ownerURL.href);owner.on('error',()=>{});await owner.connect();
    const schema=require('node:fs').readFileSync(require('node:path').join(__dirname,'../db/schema.sql'),'utf8');
    assert.match(schema,/^CREATE ROLE memz_app .*;\r?\n/m,'Fixture must replace the shared role declaration');
    await owner.query(schema.replace(/^CREATE ROLE memz_app .*;\r?\n/m,'').replace(/\bmemz_app\b/g,role));
    const url=new URL('postgres://placeholder:context_process_synthetic_only@127.0.0.1/memz');
    url.hostname=admin.host.includes(':')&&!admin.host.startsWith('[')?'['+admin.host+']':admin.host;url.port=String(admin.port);url.username=role;url.pathname='/'+database;appURL=url.href;
    process.env.DATABASE_URL=appURL;service=require('../server');
    const identity=(await service.pool.query('SELECT current_database() AS database,current_user AS role')).rows[0];
    assert.deepEqual(identity,{database,role});
    server=service.app.listen(0,'127.0.0.1');
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
    server.on('request',()=>requests++);ready=require('node:events').once(server,'listening');await ready;
  }catch{throw new Error('Context process synthetic fixture initialization failed')}
});
after(async t=>{
  const failed=[];
  async function clean(stage,fn){try{await fn()}catch{failed.push(stage)}}
  await clean('children',async()=>{const endings=[...children.values()];for(const child of children.keys())child.kill('SIGKILL');await within(Promise.all(endings),3000);assert.equal(children.size,0)});
  if(server)await clean('server',async()=>{
    const endings=[...sockets].map(socket=>new Promise(resolve=>socket.once('close',resolve)));
    const closed=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    server.closeAllConnections();for(const socket of sockets)socket.destroy();
    await within(Promise.all([closed,...endings]),3000);assert.equal(sockets.size,0);
  });
  if(service)await clean('pool',()=>within(service.pool.end(),3000));
  if(owner)await clean('owner',()=>within(owner.end(),3000));
  if(created)await clean('database',()=>admin.query(`DROP DATABASE ${database}`));
  if(roleCreated)await clean('role',()=>admin.query(`DROP ROLE ${role}`));
  if(adminConnected)await clean('absence',async()=>{
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0);
    assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount,0);
  });
  if(admin)await clean('admin',()=>within(admin.end(),3000));
  if(originalDatabaseURL===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=originalDatabaseURL;
  if(failed.length){t.diagnostic('Context process fixture cleanup failed at stages: '+failed.join(', '));throw new Error('Context process synthetic fixture cleanup failed')}
  t.diagnostic('Context process fixture cleanup: all CLI children and HTTP sockets closed; pool and owner closed; own random database and restricted role absent; administrator closed.');
});
async function invoke(input,{env={},close=true}={}){
  await ready;
  const child=spawn(process.execPath,['scripts/context-client.js','--stdin'],{env:{...process.env,MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',...env,DATABASE_URL:appURL,MEMZ_BASE_URL:`http://127.0.0.1:${server.address().port}`},stdio:['pipe','pipe','pipe']});
  let markClosed;children.set(child,new Promise(resolve=>{markClosed=resolve}));
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',failure,killTimer;
    function stop(message){if(failure)return;failure=new Error(message);child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),250)}
    const timer=setTimeout(()=>stop('client process did not terminate'),10000);
    child.stdout.on('data',chunk=>{if(failure)return;if(Buffer.byteLength(stdout)+chunk.length>4*1024*1024)return stop('unbounded child output');stdout+=chunk});
    child.stderr.on('data',chunk=>{if(failure)return;if(Buffer.byteLength(stderr)+chunk.length>65536)return stop('unbounded child diagnostics');stderr+=chunk});child.stdin.on('error',()=>{});
    child.on('error',()=>stop('client process failed to start'));
    // Never reject before close: fixture teardown must not drop the database
    // while a timed-out child is still making authenticated requests.
    child.on('close',code=>{clearTimeout(timer);clearTimeout(killTimer);children.delete(child);markClosed();if(failure)reject(failure);else resolve({code,stdout,stderr})});
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
