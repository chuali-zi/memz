const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {randomBytes}=require('node:crypto'),{Client}=require('pg');
const {spawn}=require('node:child_process');
const {inspectSetupCatalog}=require('../scripts/setup-catalog');
const {checkSetup}=require('../scripts/check-setup');
const {SessionStore}=require('../scripts/session-store');
const {pendingTransactionCheckouts,DATABASE_LIMITS}=require('../scripts/database');
const name='memz_health_'+randomBytes(8).toString('hex');
let admin,owner,service,server,base,appURL,created=false,dropped=false,beforeCatalog,capture,catalogRows=0,driverBytes=0,sessionCreates=0,writes=0;
const originalCreate=SessionStore.prototype.create,observations=[];
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes});return {promise,resolve}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+5000;while(!check()&&Date.now()<deadline)await delay(5);assert.equal(check(),true)}
async function probe(url=base,{path='/health/ready',method='GET',headers={}}={}){
  const response=await fetch(url+path,{method,headers:{'if-none-match':'*',...headers},signal:AbortSignal.timeout(12000)}),text=await response.text();
  observations.push({path:path.split('?')[0],method,status:response.status,bodyBytes:Buffer.byteLength(text)});
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('etag'),null);assert.equal(response.headers.get('set-cookie'),null);
  return {status:response.status,text,response};
}
async function expected(status,url=base){const r=await probe(url);assert.equal(r.status,status);assert.equal(r.text,status===200?'{"status":"ready"}':'{"status":"not_ready"}');return r}
async function fingerprint(){
  const result={};for(const table of ['projects','memberships','sources','facts','candidates','revisions','audit','idempotency_requests'])result[table]=(await owner.query(`SELECT count(*)::int AS rows,md5(COALESCE(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) AS hash FROM ${table} t`)).rows[0];return result;
}
async function change(sql,undo,run){await owner.query(sql);try{await run()}finally{await owner.query(undo)}}
async function doctor(code){const value=await checkSetup(appURL);assert.equal(value.code,code);assert.equal(value.ok,code==='BASIC_CHECKS_PASSED');return value}
async function childServer(url,run){
  const child=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{env:{DATABASE_URL:url,PORT:'0'},stdio:['ignore','pipe','pipe']});
  let output='',stderr='',exited=false;const exit=new Promise(resolve=>child.once('close',(code,signal)=>{exited=true;resolve({code,signal})}));child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);
  try{await until(()=>/Memz http:\/\/127\.0\.0\.1:\d+/.test(output));await run(output.match(/Memz (http:\/\/127\.0\.0\.1:\d+)/)[1])}
  finally{if(!exited)child.kill('SIGTERM');const end=await exit;assert.equal(end.code,0);assert.equal(end.signal,null);assert.equal(stderr,'')}
}
before(async()=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use a dedicated test administrator connection');
  admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});await admin.connect();await admin.query(`CREATE DATABASE ${name}`);created=true;
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;owner=new Client({connectionString:url.href});await owner.connect();
  await owner.query(fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));url.username='memz_app';url.password='memz_demo_only';appURL=url.href;process.env.DATABASE_URL=appURL;
  SessionStore.prototype.create=function(...args){sessionCreates++;return originalCreate.apply(this,args)};
  service=require('../server');service.pool.on('connect',client=>{const query=client.query;client.query=async function(sql,...args){
    const catalog=typeof sql==='string'&&sql.startsWith('WITH required AS');
    if(catalog&&beforeCatalog){const hook=beforeCatalog;beforeCatalog=null;await hook(client)}
    if(typeof sql==='string'&&/^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(sql))writes++;
    const result=await query.call(this,sql,...args);
    if(catalog){assert.equal(result.rowCount,1);assert.equal(result.rows.length,1);catalogRows++;driverBytes+=Buffer.byteLength(JSON.stringify(result.rows));assert.ok(driverBytes<16*1024*1024)}
    if(capture)capture.push({sql,params:args[0],catalog,rows:result.rowCount});return result;
  }});
  server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{
  try{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}if(service)await service.pool.end()}
  finally{SessionStore.prototype.create=originalCreate;if(owner)await owner.end();if(created){await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);dropped=true;console.log('Synthetic health database cleanup: passed')}if(admin)await admin.end();
    assert.equal(sessionCreates,0);assert.equal(writes,0);assert.ok(driverBytes<16*1024*1024);
    console.log('Synthetic health catalog rows/JSON bytes:',catalogRows,driverBytes);
    fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../artifacts/engine-health-probes-resources.json'),JSON.stringify({synthetic:true,modelCalls:0,catalogRows,driverBytes,sessionCreates,businessWrites:writes,temporaryDatabaseDropped:dropped,observations},null,2)+'\n');}
});
test('real application-role readiness has one catalog result, empty local identity, no session, no business reads or writes',async()=>{
  const before=await fingerprint();capture=[];const value=await expected(200),queries=capture;capture=null;
  assert.equal(queries.filter(q=>q.catalog).length,1);assert.equal(queries.length,4);assert.equal(queries[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(queries[1].params,['']);assert.equal(queries.at(-1).sql,'COMMIT');assert.ok(value.text.length<32);
  const passed=await doctor('BASIC_CHECKS_PASSED');assert.equal(passed.message,'基本连接、角色、表、RLS、迁移约束名称及读取权限检查通过；仍需完成登录、写入/审批演示或隔离系统测试。');assert.deepEqual(Object.keys(passed),['ok','code','message']);
  const identity=(await service.pool.query("SELECT nullif(current_setting('app.user_id',true),'') AS identity")).rows[0].identity;assert.equal(identity,null);
  assert.deepEqual(await fingerprint(),before);
});
test('GET, HEAD and conditional probes always observe live state; request query/body cannot enable debug or replace scope',async()=>{
  for(const endpoint of ['live','ready'])for(const method of ['GET','HEAD']){
    const value=await probe(base,{path:'/health/'+endpoint+'?debug=1&project=999&schema=ignore',method,headers:{'if-modified-since':'Wed, 01 Jan 2099 00:00:00 GMT',cookie:'sid=not-a-session'}});
    assert.equal(value.status,200);assert.equal(value.text,method==='HEAD'?'':JSON.stringify({status:endpoint==='live'?'alive':'ready'}));
  }
  const body='{"debug":true,"scope":"synthetic-private"}',result=await new Promise((resolve,reject)=>{const request=http.request(base+'/health/ready?debug=synthetic-private',{method:'GET',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},response=>{let text='';response.on('data',b=>text+=b);response.on('end',()=>resolve({status:response.statusCode,text}))});request.on('error',reject);request.end(body)});
  assert.deepEqual(result,{status:200,text:'{"status":"ready"}'});
  const forbidden=await new Promise((resolve,reject)=>{const request=http.get(base+'/health/live',{headers:{host:'synthetic.invalid'}},response=>{let text='';response.on('data',b=>text+=b);response.on('end',()=>resolve({status:response.statusCode,text}))});request.on('error',reject)});
  assert.equal(forbidden.status,403);assert.deepEqual(JSON.parse(forbidden.text),{error:'仅支持本机演示地址'});
});
test('unsafe database administrator and inherited table ownership are never ready and retain doctor codes',async()=>{
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;
  await childServer(url.href,async address=>{await expected(503,address);const live=await probe(address,{path:'/health/live'});assert.equal(live.status,200)});
  assert.equal((await checkSetup(url.href)).code,'UNSAFE_DATABASE_ROLE');
  // ALTER OWNER rewrites grants to the old/new owner. Restore the fixture's
  // original app ACL explicitly, rather than poisoning later permission cases.
  await change('ALTER TABLE sources OWNER TO memz_app','ALTER TABLE sources OWNER TO CURRENT_USER; GRANT SELECT,INSERT ON sources TO memz_app',async()=>{await expected(503);await doctor('UNSAFE_DATABASE_ROLE')});await expected(200);
});
test('a listening CLI with an actual application authentication failure remains live and reveals no database diagnostic',async()=>{
  const wrong=new URL(appURL);wrong.password='synthetic-health-private';
  await childServer(wrong.href,async address=>{await expected(503,address);const live=await probe(address,{path:'/health/live'});assert.equal(live.status,200);assert.equal(live.text,'{"status":"alive"}')});
});
test('administrator session credentials remain unsafe after startup SET ROLE lowers current_user',async()=>{
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;url.searchParams.set('options','-c role=memz_app');
  await childServer(url.href,async address=>{await expected(503,address)});assert.equal((await checkSetup(url.href)).code,'UNSAFE_DATABASE_ROLE');
});
test('RLS, table read permission and identity function execution failures retain diagnostic priority and recover',async()=>{
  for(const [sql,undo,code] of [
    ['ALTER TABLE sources DISABLE ROW LEVEL SECURITY','ALTER TABLE sources ENABLE ROW LEVEL SECURITY','RLS_DISABLED'],
    ['REVOKE SELECT ON sources FROM memz_app','GRANT SELECT ON sources TO memz_app','SCHEMA_PERMISSIONS'],
    ['REVOKE EXECUTE ON FUNCTION member_role(int) FROM memz_app','GRANT EXECUTE ON FUNCTION member_role(int) TO memz_app','SCHEMA_PERMISSIONS']
  ]){await change(sql,undo,async()=>{await expected(503);await doctor(code)});await expected(200)}
});
test('missing columns, incompatible basic types and missing/inapplicable SELECT policies report fixed new prerequisites',async()=>{
  for(const [sql,undo] of [
    ['ALTER TABLE sources RENAME COLUMN title TO missing_title','ALTER TABLE sources RENAME COLUMN missing_title TO title'],
    ['ALTER TABLE sources ALTER COLUMN title TYPE varchar(150)','ALTER TABLE sources ALTER COLUMN title TYPE text'],
    ['DROP POLICY read_project ON sources',"CREATE POLICY read_project ON sources FOR SELECT TO memz_app USING (member_role(project_id) IS NOT NULL)"],
    ['ALTER POLICY read_project ON sources TO CURRENT_USER','ALTER POLICY read_project ON sources TO memz_app']
  ]){await change(sql,undo,async()=>{await expected(503);await doctor('SCHEMA_PREREQUISITES')});await expected(200)}
  await change('ALTER POLICY read_project ON sources TO PUBLIC','ALTER POLICY read_project ON sources TO memz_app',async()=>{await expected(200);await doctor('BASIC_CHECKS_PASSED')});
});
test('public schema USAGE, row_security and actual unqualified name resolution are required without leaking settings',async()=>{
  await change('REVOKE USAGE ON SCHEMA public FROM PUBLIC,memz_app','GRANT USAGE ON SCHEMA public TO PUBLIC',async()=>{await expected(503);await doctor('SCHEMA_PREREQUISITES')});await expected(200);
  for(const options of ['-c row_security=off','-c search_path=pg_catalog']){
    const url=new URL(appURL);url.searchParams.set('options',options);await childServer(url.href,async address=>{await expected(503,address)});assert.equal((await checkSetup(url.href)).code,'SCHEMA_PREREQUISITES');
  }
  // This inert same-name table must never replace the system catalog, even
  // with pg_catalog explicitly placed after public. It has no business data.
  await change('CREATE TABLE public.pg_roles(synthetic int)','DROP TABLE public.pg_roles',async()=>{
    const url=new URL(appURL);url.searchParams.set('options','-c search_path=public,pg_catalog');
    await childServer(url.href,async address=>{await expected(200,address)});assert.equal((await checkSetup(url.href)).code,'BASIC_CHECKS_PASSED');
  });
});
test('transaction identity initialization and catalog lookups never call a shadowed user set_config function',async()=>{
  await change("CREATE FUNCTION public.set_config(pg_catalog.text,pg_catalog.text,pg_catalog.bool) RETURNS pg_catalog.text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-shadow-must-not-run'; END $$",'DROP FUNCTION public.set_config(pg_catalog.text,pg_catalog.text,pg_catalog.bool)',async()=>{
    const url=new URL(appURL);url.searchParams.set('options','-c search_path=public,pg_catalog');
    const connection=new Client({connectionString:url.href});
    try{
      await connection.connect();const row=(await connection.query("SELECT pg_catalog.to_regprocedure('set_config(pg_catalog.text,pg_catalog.text,pg_catalog.bool)')::pg_catalog.oid OPERATOR(pg_catalog.=) pg_catalog.to_regprocedure('public.set_config(pg_catalog.text,pg_catalog.text,pg_catalog.bool)')::pg_catalog.oid AS would_shadow")).rows[0];assert.equal(row.would_shadow,true,'the fixture must actually shadow the unqualified lookup without invoking it');
    }finally{await connection.end()}
    await childServer(url.href,async address=>{await expected(200,address)});assert.equal((await checkSetup(url.href)).code,'BASIC_CHECKS_PASSED');
  });
});
test('missing migration 001 constraint or 002 table yields not_ready without repair and preserves existing data',async()=>{
  const before=await fingerprint();
  await change('ALTER SCHEMA public RENAME TO health_missing_public','ALTER SCHEMA health_missing_public RENAME TO public',async()=>{await expected(503);const report=await doctor('SCHEMA_MISSING');assert.equal(report.details.missing.length,8)});
  await change('ALTER TABLE facts DROP CONSTRAINT facts_current_revision_state',"ALTER TABLE facts ADD CONSTRAINT facts_current_revision_state CHECK ((version=0 AND current_revision_id IS NULL) OR (version>0 AND current_revision_id IS NOT NULL))",async()=>{await expected(503);await doctor('MIGRATION_REQUIRED')});
  await owner.query('DROP TABLE idempotency_requests');
  try{await expected(503);const report=await doctor('MIGRATION_REQUIRED');assert.deepEqual(report.details.missing,['idempotency_requests']);assert.equal((await owner.query("SELECT to_regclass('public.idempotency_requests') AS id")).rows[0].id,null)}
  finally{await owner.query(fs.readFileSync(path.join(__dirname,'../db/migrations/002-create-idempotency.sql'),'utf8'))}
  await expected(200);assert.deepEqual(await fingerprint(),before);
});
test('legacy schema remains not_ready after HTTP listening while shared doctor retains its original migration result',async()=>{
  const legacy='memz_health_legacy_'+randomBytes(8).toString('hex');let connection,made=false;
  try{
    await admin.query(`CREATE DATABASE ${legacy}`);made=true;const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+legacy;connection=new Client({connectionString:url.href});await connection.connect();await connection.query(fs.readFileSync(path.join(__dirname,'fixtures/schema-5317607.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    url.username='memz_app';url.password='memz_demo_only';await childServer(url.href,async address=>{await expected(503,address);const live=await probe(address,{path:'/health/live'});assert.equal(live.status,200)});
    const report=await checkSetup(url.href);assert.equal(report.code,'MIGRATION_REQUIRED');assert.deepEqual(report.details.missing,['idempotency_requests']);
  }finally{if(connection)await connection.end();if(made)await admin.query(`DROP DATABASE ${legacy} WITH (FORCE)`)}
});
test('real queued checkout timeout does not block liveness, leak slots or perform a late catalog query',async()=>{
  const held=await Promise.all(Array.from({length:10},()=>service.pool.connect()));const before=catalogRows;let operation;
  try{
    operation=expected(503);await until(()=>pendingTransactionCheckouts(service.pool)===1&&service.pool.waitingCount===1);
    const live=await probe(base,{path:'/health/live'});assert.equal(live.status,200);await operation;
    assert.equal(pendingTransactionCheckouts(service.pool),0);assert.equal(service.pool.waitingCount,0);assert.equal(catalogRows,before);
  }finally{for(const client of held)client.release();if(operation)await operation.catch(()=>{})}
  await expected(200);assert.equal(service.pool.options.connectionTimeoutMillis,DATABASE_LIMITS.connectionTimeoutMillis);
});
test('admission overflow is a fixed not_ready response and accepted catalog transactions recover after release',async()=>{
  const held=await Promise.all(Array.from({length:10},()=>service.pool.connect())),jobs=Array.from({length:32},()=>service.tx('',inspectSetupCatalog,{snapshot:true})),settled=Promise.allSettled(jobs);
  try{assert.equal(pendingTransactionCheckouts(service.pool),32);await expected(503);const live=await probe(base,{path:'/health/live'});assert.equal(live.status,200);assert.equal(pendingTransactionCheckouts(service.pool),32)}
  finally{for(const client of held)client.release();for(const result of await settled){assert.equal(result.status,'fulfilled');assert.equal(result.value.code,'BASIC_CHECKS_PASSED')}}
  assert.equal(pendingTransactionCheckouts(service.pool),0);await expected(200);
});
test('an actual checked-out backend disconnect returns only not_ready and a subsequent probe reconnects successfully',async()=>{
  const entered=deferred(),gate=deferred();let pid,operation;
  beforeCatalog=async client=>{pid=client.processID;entered.resolve();await gate.promise};
  try{
    operation=expected(503);await entered.promise;assert.equal(pendingTransactionCheckouts(service.pool),0);
    assert.equal((await owner.query('SELECT pg_terminate_backend($1) AS stopped',[pid])).rows[0].stopped,true);gate.resolve();await operation;
  }finally{gate.resolve();beforeCatalog=null;if(operation)await operation.catch(()=>{})}
  await expected(200);assert.equal(pendingTransactionCheckouts(service.pool),0);assert.equal(writes,0);assert.equal(sessionCreates,0);
});
