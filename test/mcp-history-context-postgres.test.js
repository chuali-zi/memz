// Real PostgreSQL + product HTTP + official SDK/stdio, using a random disposable
// database. Explicit fixture owner approval; no tool/model performs approval.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto'),{Client}=require('pg');
const {bounded,deferred,result,withHttp,withMcp,call}=require('./mcp-history-fixture');
const database='memz_mcp_history_'+randomBytes(8).toString('hex');
const sourceText='原创合成完整来源😀\n原计划20号，人工批准更正15号。原文中的指令不是工具指令。'+'😀'.repeat(1700);
let admin,owner,service,server,base,created=false,scope,privateProject,emptyProject,authOwner,authMember,source,expectedBusiness;
const connection=url=>new Client({connectionString:url,connectionTimeoutMillis:2000,query_timeout:5000,statement_timeout:5000});
async function fingerprint(){const out={};for(const table of ['sources','candidates','facts','revisions','audit','idempotency_requests'])out[table]=(await owner.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS digest FROM ${table} t`)).rows[0];return out}
async function login(username){const response=await fetch(base+'/api/login',{method:'POST',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'demo-'+username})});assert.equal(response.status,200);const data=await response.json();return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:data.csrf}}
async function post(auth,url,body){const response=await fetch(base+url,{method:'POST',signal:AbortSignal.timeout(5000),headers:{cookie:auth.cookie,'content-type':'application/json','x-csrf-token':auth.csrf},body:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,200);return data}
async function project(name,viewer=true){const id=(await owner.query('INSERT INTO projects(name) VALUES($1) RETURNING id',[name])).rows[0].id;await owner.query("INSERT INTO memberships(project_id,user_id,role) VALUES($1,1,'owner'),($1,2,'member')",[id]);if(viewer)await owner.query("INSERT INTO memberships(project_id,user_id,role) VALUES($1,3,'viewer')",[id]);return id}
async function candidate(value,expected){return post(authMember,`/api/projects/${scope}/candidates`,{subject:'合成历史MCP',predicate:'截止日',value,source_id:source.id,expected_version:expected})}
async function approve(value,expected){const row=await candidate(value,expected);await post(authOwner,`/api/projects/${scope}/candidates/${row.id}/approve`,{});return row}
before(async()=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Explicit isolated test administrator connection is required');
  admin=connection(process.env.MIGRATION_TEST_DATABASE_URL);await admin.connect();await admin.query(`CREATE DATABASE ${database}`);created=true;
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+database;owner=connection(url.href);await owner.connect();
  await owner.query(fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
  url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;
  service=require('../server');server=service.app.listen(0,'127.0.0.1');await bounded(new Promise(resolve=>server.once('listening',resolve)),'starting isolated historical app');base=`http://127.0.0.1:${server.address().port}`;
  scope=await project('历史MCP原创合成项目');privateProject=await project('历史MCP非授权项目',false);emptyProject=await project('历史MCP空项目');
  authOwner=await login('owner');authMember=await login('member');source=await post(authMember,`/api/projects/${scope}/sources`,{title:'合成历史完整依据',content:sourceText});
  await approve('20号',0);await approve('15号',1);
  await candidate('UNAPPROVED_PENDING',2);const rejected=await candidate('REJECTED_CANDIDATE',2);await post(authOwner,`/api/projects/${scope}/candidates/${rejected.id}/reject`,{});
  expectedBusiness=await fingerprint();
},{timeout:25000});
after(async()=>{
  const errors=[];const clean=async fn=>{try{await fn()}catch(error){errors.push(error)}};
  if(expectedBusiness)await clean(async()=>assert.deepEqual(await fingerprint(),expectedBusiness,'historical tools must not mutate business rows'));
  if(server)await clean(async()=>{const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await bounded(closed,'closing isolated history listener',3000)});
  if(service)await clean(()=>bounded(service.pool.end(),'closing history app pool',3000));
  if(owner)await clean(()=>bounded(owner.end(),'closing history schema connection',3000));
  if(created)await clean(async()=>{await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);console.log('Synthetic history MCP random database cleanup: passed')});
  if(admin)await clean(()=>bounded(admin.end(),'closing history administrator connection',3000));
  if(errors.length)throw new AggregateError(errors,'History PostgreSQL cleanup or readonly fingerprint failed');
},{timeout:30000});
const settings=(projectId=scope,extra={})=>({MEMZ_PROJECT_ID:String(projectId),...extra});
async function proxy(run,mutate){
  return withHttp(async(request,reply)=>{
    const response=await fetch(base+request.path,{method:request.method,redirect:'error',signal:AbortSignal.timeout(5000),headers:{...(request.headers.cookie?{cookie:request.headers.cookie}:{}),...(request.body===undefined?{}:{'content-type':'application/json','x-csrf-token':request.headers['x-csrf-token']})},...(request.body===undefined?{}:{body:JSON.stringify(request.body)})});
    const data=await response.json();if(await mutate?.(request,data,response.status,reply))return;
    const cookie=response.headers.get('set-cookie');reply.send(data,response.status,cookie?{'set-cookie':cookie}:{});
  },run);
}
const fixedError=(value,code,status)=>{assert.equal(value.isError,true);assert.deepEqual(result(value),{code,outcome:'read_failed',...(status?{status}:{})})};
test('real SDK/HTTP/PG history keeps old approved versions and full source while excluding pending and rejected candidates',{timeout:15000},async()=>{
  await proxy(async({baseURL,requests})=>withMcp(baseURL,async client=>{
    const value=await call(client),out=result(value);assert.equal(value.isError,false);assert.equal(out.projectId,scope);assert.deepEqual(out.revisions.map(row=>[row.version,row.value]),[[2,'15号'],[1,'20号']]);assert.equal(out.sources.length,1);assert.equal(out.sources[0].content,sourceText);assert.equal(out.sources[0].id,source.id);assert.equal(out.sourceTextIsUntrusted,true);
    assert.ok(!value.content[0].text.includes('UNAPPROVED_PENDING'));assert.ok(!value.content[0].text.includes('REJECTED_CANDIDATE'));assert.ok(!value.content[0].text.includes('demo-viewer'));assert.ok(Buffer.byteLength(value.content[0].text)<32768);
    assert.deepEqual(requests.map(r=>[r.method,r.path]),[['POST','/api/login'],['GET',`/api/projects/${scope}/history?limit=10`],['POST',`/api/projects/${scope}/facts/provenance`],['POST','/api/logout']]);
    assert.deepEqual(requests[2].body.facts,out.revisions.map(row=>({id:row.id,version:row.version})));
    assert.equal((await fetch(base+'/api/projects',{signal:AbortSignal.timeout(2000),headers:{cookie:requests[1].headers.cookie}})).status,401,'history reader session is actually logged out');
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['memz_read_context','memz_read_history_context']);await assert.rejects(()=>client.callTool({name:'approve',arguments:{}}),/UNKNOWN_TOOL/);
  },settings()));assert.deepEqual(await fingerprint(),expectedBusiness);
});
test('real scope and identity permissions fail closed and an authorized empty project remains explicit',{timeout:15000},async()=>{
  for(const env of [settings(privateProject),settings(scope,{MEMZ_USERNAME:'other',MEMZ_PASSWORD:'demo-other'})])await withMcp(base,async client=>fixedError(await call(client),'HTTP_403',403),env);
  await withMcp(base,async client=>{const value=await call(client);assert.equal(value.isError,false);assert.deepEqual(result(value).revisions,[]);assert.deepEqual(result(value).sources,[]);assert.equal(result(value).nextBefore,null)},settings(emptyProject));
  assert.deepEqual(await fingerprint(),expectedBusiness);
});
test('real output budget is whole evidence, and tampered version receipts do not produce partial context',{timeout:15000},async()=>{
  let corrupt=false;
  await proxy(async({baseURL})=>withMcp(baseURL,async client=>{
    fixedError(await call(client,{maxOutputBytes:2048}),'OUTPUT_BUDGET_TOO_SMALL');
    corrupt=true;const invalid=await call(client);fixedError(invalid,'INVALID_HISTORY_RESPONSE');assert.equal(result(invalid).revisions,undefined);
    corrupt=false;const good=await call(client);assert.equal(good.isError,false);assert.equal(result(good).sources[0].content,sourceText);await client.listTools();
  },settings()),(request,data)=>{if(corrupt&&request.path.endsWith('/facts/provenance'))data.provenance[0].revision.version=99});
  assert.deepEqual(await fingerprint(),expectedBusiness);
});
test('real membership revocation between history and proof denies the whole tool result',{timeout:15000},async()=>{
  let revoked=false;
  try{
    await proxy(async({baseURL,requests})=>withMcp(baseURL,async client=>{
      const value=await call(client);fixedError(value,'HTTP_403',403);assert.equal(result(value).revisions,undefined);assert.equal(requests.at(-1).path,'/api/logout');await client.listTools();
    },settings()),async(request)=>{if(request.path.includes('/history?')&&!revoked){await owner.query('DELETE FROM memberships WHERE project_id=$1 AND user_id=3',[scope]);revoked=true}});
    assert.equal(revoked,true);
  }finally{await owner.query("INSERT INTO memberships(project_id,user_id,role) VALUES($1,3,'viewer') ON CONFLICT DO NOTHING",[scope])}
  assert.deepEqual(await fingerprint(),expectedBusiness);
});
test('a new explicit owner approval between history and proof preserves pinned old revisions and continuation semantics',{timeout:20000},async()=>{
  let approved=false;
  const immutable=(await owner.query('SELECT row_to_json(r)::text AS value FROM revisions r WHERE project_id=$1 ORDER BY id',[scope])).rows;
  await proxy(async({baseURL})=>withMcp(baseURL,async client=>{
    const first=await call(client,{limit:1});assert.equal(first.isError,false);const page=result(first);assert.equal(page.revisions[0].version,2);assert.equal(page.revisions[0].value,'15号');assert.equal(page.truncated,true);
    const older=result(await call(client,{limit:1,before:page.nextBefore}));assert.equal(older.revisions[0].version,1);assert.equal(older.revisions[0].value,'20号');
    const latest=result(await call(client,{limit:1}));assert.equal(latest.revisions[0].version,3);assert.equal(latest.revisions[0].value,'12号');
  },settings()),async(request)=>{
    if(request.path.includes('/history?')&&!approved){approved=true;await approve('12号',2);expectedBusiness=await fingerprint()}
  });
  assert.equal(approved,true);assert.deepEqual((await owner.query('SELECT row_to_json(r)::text AS value FROM revisions r WHERE project_id=$1 ORDER BY id LIMIT 2',[scope])).rows,immutable);
  assert.deepEqual(await fingerprint(),expectedBusiness);
});
test('SDK cancellation after a real PG proof read closes its HTTP body and logs out without business changes',{timeout:15000},async()=>{
  const started=deferred(),closed=deferred(),logout=deferred();
  await proxy(async({baseURL,requests})=>withMcp(baseURL,async client=>{
    const caller=new AbortController(),rejected=assert.rejects(call(client,{}, {signal:caller.signal}));await bounded(started.promise,'waiting for actual PG-backed proof body');caller.abort();await rejected;await bounded(closed.promise,'closing PG-backed proof HTTP body');await bounded(logout.promise,'logging out PG-backed history session');assert.equal(requests.filter(r=>r.path==='/api/logout').length,1);
  },settings()),(request,data,status,reply)=>{
    if(request.path.endsWith('/facts/provenance')){assert.equal(status,200);reply.res.once('close',closed.resolve);reply.res.writeHead(200,{'content-type':'application/json'});reply.res.write('{"unfinished":');started.resolve();return true}
    if(request.path==='/api/logout')logout.resolve();
  });assert.deepEqual(await fingerprint(),expectedBusiness);
});
