const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto'),{Client}=require('pg');
const name='memz_approval_intent_'+randomBytes(8).toString('hex');
let admin,owner,service,server,base,created=false,dropped=false,capture,driverBytes=0;
const sessions={},observations=[];
async function post(actor,route,body={},key){
  const response=await fetch(base+route,{method:'POST',headers:{cookie:sessions[actor].cookie,'x-csrf-token':sessions[actor].csrf,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)}),data=await response.json();
  return {status:response.status,data};
}
async function pending(subject,overrides={},key){
  const result=await post('member','/api/projects/1/candidates',{subject,predicate:'状态',value:'原创待审值',source_id:1,expected_version:0,...overrides},key);assert.equal(result.status,200);assert.equal(result.data.status,'pending');return result.data;
}
async function state(id){return (await owner.query("SELECT c.status,(SELECT count(*)::int FROM revisions r WHERE r.candidate_id=c.id) AS revisions,(SELECT count(*)::int FROM audit WHERE action='approve' AND detail LIKE $2) AS approvals FROM candidates c WHERE c.id=$1",[id,`候选 ${id} →%`])).rows[0]}
async function fingerprint(){const result={};for(const table of ['sources','facts','candidates','revisions','audit','idempotency_requests'])result[table]=(await owner.query(`SELECT count(*)::int AS rows,md5(COALESCE(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) AS hash FROM ${table} t`)).rows[0];return result}
before(async()=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use a dedicated test administrator connection');admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});await admin.connect();await admin.query(`CREATE DATABASE ${name}`);created=true;
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;owner=new Client({connectionString:url.href});await owner.connect();await owner.query(fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
  url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;service=require('../server');
  service.pool.on('connect',client=>{const query=client.query;client.query=async function(sql,...args){const result=await query.call(this,sql,...args);if(result.rows){driverBytes+=Buffer.byteLength(JSON.stringify(result.rows));assert.ok(driverBytes<16*1024*1024)}if(capture)capture.push(typeof sql==='string'?sql:'structured query');return result}});
  server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
  for(const actor of ['owner','member','viewer','other']){const response=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:actor,password:'demo-'+actor})});assert.equal(response.status,200);sessions[actor]={cookie:response.headers.get('set-cookie').split(';')[0],csrf:(await response.json()).csrf}}
});
after(async()=>{
  try{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}if(service)await service.pool.end()}
  finally{if(owner)await owner.end();if(created){await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);dropped=true;console.log('Synthetic approval intent database cleanup: passed')}if(admin)await admin.end();
    assert.ok(driverBytes<16*1024*1024);fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../artifacts/engine-approval-intent-resources.json'),JSON.stringify({synthetic:true,modelCalls:0,driverBytes,temporaryDatabaseDropped:dropped,observations},null,2)+'\n');}
});
test('undefined, malformed or unknown helper decisions reject before candidate SQL and leave all business rows unchanged',async()=>{
  const candidate=await pending('原创动作校验'),before=await fingerprint();
  for(const decision of [undefined,null,'skip','APPROVE','approve ',true,{}]){
    capture=[];await assert.rejects(()=>service.tx(1,c=>service.decide(c,1,1,candidate.id,decision)),error=>error.status===400&&error.message==='操作无效');const queries=capture;capture=null;
    assert.deepEqual(queries,['BEGIN',"SELECT pg_catalog.set_config('app.user_id',$1,true)",'ROLLBACK']);
    const current=await state(candidate.id);assert.deepEqual(current,{status:'pending',revisions:0,approvals:0});assert.deepEqual(await fingerprint(),before);observations.push({scenario:'invalid-helper-action',...current,businessQueries:0});
  }
  for(const decision of ['skip','APPROVE']){const result=await post('owner',`/api/projects/1/candidates/${candidate.id}/${decision}`);assert.equal(result.status,400);assert.deepEqual(result.data,{error:'操作无效'})}
  assert.deepEqual(await fingerprint(),before);
});
test('explicit approval commits exactly once, retains full source and immutable prior revisions, and stale versions do not write',async()=>{
  const first=await pending('原创明确批准');const approved=await post('owner',`/api/projects/1/candidates/${first.id}/approve`);assert.equal(approved.status,200);assert.deepEqual(approved.data,{status:'approved',version:1});
  const revision=(await owner.query('SELECT * FROM revisions WHERE candidate_id=$1',[first.id])).rows[0],source=(await owner.query('SELECT id,content FROM sources WHERE id=$1',[first.source_id])).rows[0];assert.equal(revision.source_id,source.id);assert.equal(revision.value,first.value);assert.equal(revision.approved_by,1);
  const duplicateBefore=await fingerprint();const duplicate=await post('owner',`/api/projects/1/candidates/${first.id}/approve`);assert.equal(duplicate.status,409);assert.deepEqual(await fingerprint(),duplicateBefore);
  const stale=await pending(first.subject,{value:'过期意图',expected_version:0}),before=await fingerprint();assert.equal((await post('owner',`/api/projects/1/candidates/${stale.id}/approve`)).status,409);assert.deepEqual(await fingerprint(),before);
  const second=await pending(first.subject,{value:'第二次明确意图',expected_version:1});assert.deepEqual((await post('owner',`/api/projects/1/candidates/${second.id}/approve`)).data,{status:'approved',version:2});
  assert.deepEqual((await owner.query('SELECT * FROM revisions WHERE candidate_id=$1',[first.id])).rows[0],revision);assert.deepEqual((await owner.query('SELECT id,content FROM sources WHERE id=$1',[first.source_id])).rows[0],source);
  observations.push({scenario:'explicit-approvals',versions:[1,2],priorRevisionUnchanged:true});
});
test('explicit rejection, non-owner/cross-project decisions and foreign sources cannot produce an approval',async()=>{
  const candidate=await pending('原创拒绝权限'),before=await fingerprint();
  for(const actor of ['member','viewer','other']){assert.equal((await post(actor,`/api/projects/1/candidates/${candidate.id}/approve`)).status,403);assert.deepEqual(await fingerprint(),before)}
  const foreign=await post('member','/api/projects/1/candidates',{subject:'原创跨项目来源',predicate:'状态',value:'不写入',source_id:4,expected_version:0});assert.equal(foreign.status,400);assert.deepEqual(await fingerprint(),before);
  const rejected=await post('owner',`/api/projects/1/candidates/${candidate.id}/reject`);assert.equal(rejected.status,200);assert.deepEqual(rejected.data,{status:'rejected'});assert.deepEqual(await state(candidate.id),{status:'rejected',revisions:0,approvals:0});
  const after=await fingerprint();assert.equal((await post('owner',`/api/projects/1/candidates/${candidate.id}/approve`)).status,409);assert.deepEqual(await fingerprint(),after);
});
test('concurrent creation replays one pending receipt and competing explicit approvals preserve one fact/version',async()=>{
  const body={subject:'原创幂等并发',predicate:'状态',value:'待审原意图',source_id:1,expected_version:0};
  const receipts=await Promise.all([post('member','/api/projects/1/candidates',body,'approval-audit-same-key'),post('member','/api/projects/1/candidates',body,'approval-audit-same-key')]);
  assert.deepEqual(receipts[0],receipts[1]);assert.equal(receipts[0].status,200);const first=receipts[0].data;assert.equal(first.status,'pending');assert.deepEqual(await state(first.id),{status:'pending',revisions:0,approvals:0});
  const beforeMismatch=await fingerprint();assert.equal((await post('member','/api/projects/1/candidates',{...body,value:'不同意图'},'approval-audit-same-key')).status,409);assert.deepEqual(await fingerprint(),beforeMismatch);
  const second=await pending(first.subject,{value:'第二个候选'});const decisions=await Promise.all([post('owner',`/api/projects/1/candidates/${first.id}/approve`),post('owner',`/api/projects/1/candidates/${second.id}/approve`)]);assert.deepEqual(decisions.map(x=>x.status).sort(),[200,409]);
  const rows=(await owner.query("SELECT f.id,f.version,(SELECT count(*)::int FROM revisions WHERE fact_id=f.id) AS revisions FROM facts f WHERE project_id=1 AND subject=$1",[first.subject])).rows;assert.equal(rows.length,1);assert.equal(rows[0].version,1);assert.equal(rows[0].revisions,1);
  const replay=await post('member','/api/projects/1/candidates',body,'approval-audit-same-key');assert.deepEqual(replay,receipts[0],'replay is the original pending creation receipt, never an implicit approval or current-status receipt');
});
test('approval failure rolls back candidate, new fact, revision and audit together without losing the pending intent',async()=>{
  const candidate=await pending('原创回滚完整性'),before=await fingerprint();await assert.rejects(()=>service.tx(1,c=>service.decide(c,1,1,candidate.id,'approve',true)),error=>error.message==='injected failure');assert.deepEqual(await fingerprint(),before);assert.deepEqual(await state(candidate.id),{status:'pending',revisions:0,approvals:0});
  assert.deepEqual((await post('owner',`/api/projects/1/candidates/${candidate.id}/approve`)).data,{status:'approved',version:1});
});
