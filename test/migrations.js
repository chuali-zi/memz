const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {Client}=require('pg');
const adminUrl=process.env.MIGRATION_TEST_DATABASE_URL;
if(!adminUrl)throw new Error('Set MIGRATION_TEST_DATABASE_URL to a test PostgreSQL admin connection; no default is used.');
const migration=fs.readFileSync('db/migrations/001-current-revision-integrity.sql','utf8');
const tables=['projects','memberships','sources','facts','candidates','revisions','audit'];
async function snapshot(c){
  const rows={};
  for(const table of tables)rows[table]=(await c.query(`SELECT * FROM public.${table} ORDER BY 1,2`)).rows;
  const sequences=(await c.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;
  const policies=(await c.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows;
  const grants=(await c.query("SELECT table_name,grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' ORDER BY 1,2,3")).rows;
  return {rows,sequences,policies,grants};
}
async function constraints(c){return (await c.query("SELECT conname,pg_get_constraintdef(oid) AS definition,convalidated FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname")).rows}
async function migrate(c,sql=migration){try{await c.query(sql)}catch(e){await c.query('ROLLBACK');throw e}}
async function fixture(file,fn){
  const admin=new Client({connectionString:adminUrl});await admin.connect();
  const name=`memz_migration_${crypto.randomBytes(8).toString('hex')}`;
  let c;
  try{
    // The normal demo initialization creates the shared application role first.
    assert.equal((await admin.query("SELECT 1 FROM pg_roles WHERE rolname='memz_app'")).rowCount,1);
    await admin.query(`CREATE DATABASE ${name}`);
    const url=new URL(adminUrl);url.pathname=`/${name}`;
    c=new Client({connectionString:url.href});await c.connect();
    const sql=fs.readFileSync(file,'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,'');
    await c.query(sql);
    await fn(c,url.href);
  }finally{
    if(c)await c.end();
    // Only drop the random database created by this test, never the supplied DB.
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}
async function assertGuards(c){
  for(const [sql,code] of [
    ["INSERT INTO facts(project_id,subject,predicate,version,current_revision_id) VALUES(1,'wrong','pointer',1,1)",'23503'],
    ['UPDATE facts SET version=99 WHERE id=1','23503'],
    ['UPDATE facts SET current_revision_id=NULL WHERE id=1','23514']
  ])await assert.rejects(()=>c.query(sql),e=>e.code===code);
}
test('legacy upgrade preserves populated data, policies, grants and sequences; repeat and concurrent runs succeed',async()=>{
  await fixture('test/fixtures/schema-5317607.sql',async(c,url)=>{
    await c.query(`INSERT INTO sources(project_id,title,content) VALUES(1,'保留来源','不可删除');
      INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by,status)
        VALUES(1,'项目','截止日','15号',5,1,1,'approved');
      INSERT INTO revisions(project_id,fact_id,version,value,source_id,candidate_id,approved_by)
        VALUES(1,1,2,'15号',5,2,1);
      UPDATE facts SET version=2,current_revision_id=2 WHERE id=1;
      INSERT INTO audit(project_id,actor_id,action,detail) VALUES(1,1,'approve','保留 v2 历史');`);
    const before=await snapshot(c);
    await migrate(c);assert.deepEqual(await snapshot(c),before);
    const definitions=await constraints(c);
    await migrate(c);assert.deepEqual(await snapshot(c),before);assert.deepEqual(await constraints(c),definitions);
    const other=new Client({connectionString:url});await other.connect();
    try{await Promise.all([migrate(c),migrate(other)])}finally{await other.end()}
    assert.deepEqual(await snapshot(c),before);assert.deepEqual(await constraints(c),definitions);
    await assertGuards(c);
    // Writes remain possible after migration; advance the same fact via a real revision.
    await c.query(`BEGIN; SET LOCAL ROLE memz_app; SELECT set_config('app.user_id','1',true);
      INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by)
        VALUES(1,'项目','截止日','10号',5,2,1);
      INSERT INTO revisions(project_id,fact_id,version,value,source_id,candidate_id,approved_by)
        VALUES(1,1,3,'10号',5,3,1);
      UPDATE facts SET version=3,current_revision_id=3 WHERE id=1;
      UPDATE candidates SET status='approved' WHERE id=3;
      INSERT INTO audit(project_id,actor_id,action,detail) VALUES(1,1,'approve','升级后 v3'); COMMIT;`);
    assert.equal((await c.query('SELECT version FROM facts WHERE id=1')).rows[0].version,3);
  });
});
test('fresh schema accepts migration twice without changing data',async()=>{
  await fixture('db/schema.sql',async c=>{
    const before=await snapshot(c);await migrate(c);await migrate(c);
    assert.deepEqual(await snapshot(c),before);await assertGuards(c);
  });
});
for(const [label,sql] of [
  ['foreign fact pointer',"INSERT INTO facts(project_id,subject,predicate,version,current_revision_id) VALUES(1,'wrong','pointer',1,1)"],
  ['version mismatch','UPDATE facts SET version=2 WHERE id=1'],
  ['missing pointer','UPDATE facts SET current_revision_id=NULL WHERE id=1']
])test(`invalid legacy ${label} fails atomically and preserves data`,async()=>{
  await fixture('test/fixtures/schema-5317607.sql',async c=>{
    await c.query(sql);const before=await snapshot(c),definitions=await constraints(c);
    await assert.rejects(()=>migrate(c),e=>['23503','23514'].includes(e.code));
    assert.deepEqual(await snapshot(c),before);assert.deepEqual(await constraints(c),definitions);
    assert.equal((await c.query("SELECT to_regclass('public.revisions_project_id_fact_id_version_id_key') AS idx")).rows[0].idx,null);
  });
});
test('application role cannot migrate; lock timeout leaves the legacy database unchanged',async()=>{
  await fixture('test/fixtures/schema-5317607.sql',async(c,url)=>{
    const before=await snapshot(c),definitions=await constraints(c);
    await c.query('SET ROLE memz_app');
    try{await assert.rejects(()=>migrate(c),e=>e.code==='42501')}finally{await c.query('RESET ROLE')}
    assert.deepEqual(await snapshot(c),before);assert.deepEqual(await constraints(c),definitions);
    const blocker=new Client({connectionString:url});await blocker.connect();
    try{
      await blocker.query('BEGIN; LOCK TABLE public.facts IN ACCESS SHARE MODE');
      await assert.rejects(()=>migrate(c),e=>e.code==='55P03');
    }finally{await blocker.query('ROLLBACK');await blocker.end()}
    assert.deepEqual(await snapshot(c),before);assert.deepEqual(await constraints(c),definitions);
    await migrate(c);assert.deepEqual(await snapshot(c),before);
  });
});
test('full HTTP integration suite works against an upgraded legacy database',async()=>{
  await fixture('test/fixtures/schema-5317607.sql',async(c,url)=>{
    await migrate(c);
    await migrate(c,fs.readFileSync('db/migrations/002-create-idempotency.sql','utf8'));
    const appUrl=new URL(url);appUrl.username='memz_app';appUrl.password='memz_demo_only';
    const execFile=require('node:util').promisify(require('node:child_process').execFile);
    const childEnv={...process.env,DATABASE_URL:appUrl.href};
    delete childEnv.NODE_TEST_CONTEXT;
    const {stdout}=await execFile(process.execPath,['--test','--test-reporter=tap','test/integration.test.js'],{
      env:childEnv,timeout:30000
    });
    assert.match(stdout,/^# pass 1$/m);
    assert.match(stdout,/^# fail 0$/m);
  });
});

test('idempotent creates work on fresh and upgraded databases; migration 002 preserves existing rows and receipts',async()=>{
  const addition=fs.readFileSync('db/migrations/002-create-idempotency.sql','utf8');
  for(const file of ['test/fixtures/schema-5317607.sql','db/schema.sql'])await fixture(file,async(c,url)=>{
    await migrate(c);
    const before=await snapshot(c);
    const concurrent=new Client({connectionString:url});await concurrent.connect();
    try{await Promise.all([migrate(c,addition),migrate(concurrent,addition)])}finally{await concurrent.end()}
    await migrate(c,addition);
    const after=await snapshot(c);
    assert.deepEqual(after.rows,before.rows);assert.deepEqual(after.sequences,before.sequences);
    const oldPolicies=rows=>rows.filter(r=>r.tablename!=='idempotency_requests');
    const oldGrants=rows=>rows.filter(r=>r.table_name!=='idempotency_requests');
    assert.deepEqual(oldPolicies(after.policies),oldPolicies(before.policies));assert.deepEqual(oldGrants(after.grants),oldGrants(before.grants));
    const appUrl=new URL(url);appUrl.username='memz_app';appUrl.password='memz_demo_only';
    const childEnv={...process.env,DATABASE_URL:appUrl.href};delete childEnv.NODE_TEST_CONTEXT;
    const execFile=require('node:util').promisify(require('node:child_process').execFile);
    const {stdout}=await execFile(process.execPath,['--test','--test-reporter=tap','test/idempotency.js'],{env:childEnv,timeout:30000});
    assert.match(stdout,/^# pass 5$/m);assert.match(stdout,/^# fail 0$/m);
    const populated=await snapshot(c),receipts=(await c.query('SELECT * FROM idempotency_requests ORDER BY project_id,actor_id,operation,request_key')).rows;
    await migrate(c,addition);
    assert.deepEqual(await snapshot(c),populated);
    assert.deepEqual((await c.query('SELECT * FROM idempotency_requests ORDER BY project_id,actor_id,operation,request_key')).rows,receipts);
  });
});
test('bounded fact retrieval preserves pagination, isolation and search semantics',async()=>{
  await fixture('db/schema.sql',async(c,url)=>{
    const appUrl=new URL(url);appUrl.username='memz_app';appUrl.password='memz_demo_only';
    const childEnv={...process.env,DATABASE_URL:appUrl.href};delete childEnv.NODE_TEST_CONTEXT;
    const execFile=require('node:util').promisify(require('node:child_process').execFile);
    const {stdout}=await execFile(process.execPath,['--test','--test-reporter=tap','test/pagination.js'],{env:childEnv,timeout:30000});
    assert.match(stdout,/^# pass 14$/m);assert.match(stdout,/^# fail 0$/m);
  });
});
