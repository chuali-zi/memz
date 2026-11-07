const {test}=require('node:test'),assert=require('node:assert/strict');
const {Client}=require('pg'),fs=require('node:fs'),{randomBytes}=require('node:crypto');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),{once}=require('node:events');
const {checkSetup}=require('../scripts/check-setup');
async function fixture(schema,fn){
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'isolated test administrator connection required');
  const admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});await admin.connect();
  const name='memz_setup_'+randomBytes(8).toString('hex');let owner,created=false;
  try{
    await admin.query(`CREATE DATABASE ${name}`);created=true;
    const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;owner=new Client({connectionString:url.href});await owner.connect();
    await owner.query(fs.readFileSync(schema,'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    const app=new URL(url);app.username='memz_app';app.password='memz_demo_only';
    await fn(owner,app.href,url.href);
  }finally{if(owner)await owner.end();if(created)await admin.query(`DROP DATABASE ${name}`);await admin.end()}
}
async function snapshot(c){const data={};for(const table of ['projects','memberships','sources','candidates','facts','revisions','audit'])data[table]=(await c.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;return data}
test('read-only setup check reports missing migration before a legacy database can support keyed writes',async()=>{
  await fixture('test/fixtures/schema-5317607.sql',async(owner,url)=>{
    const before=await snapshot(owner);
    const child=spawn(process.execPath,['server.js'],{env:{...process.env,DATABASE_URL:url,PORT:'0'},stdio:['ignore','pipe','pipe']});const exited=once(child,'exit');child.stderr.resume();
    try{
      const base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('legacy startup timeout')),5000);child.stdout.on('data',b=>{output+=b;const m=output.match(/Memz (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1])}});child.once('error',reject)});
      const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'demo-owner'})});assert.equal(login.status,200);
      const csrf=(await login.json()).csrf,cookie=login.headers.get('set-cookie').split(';')[0];
      assert.equal((await fetch(base+'/api/projects',{headers:{cookie}})).status,200);
      const failed=await fetch(base+'/api/projects/1/sources',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json','idempotency-key':'synthetic-setup-intent'},body:JSON.stringify({title:'合成诊断',content:'旧库缺回执表'})});assert.equal(failed.status,500);await failed.json();
    }finally{child.kill('SIGTERM');await exited}
    const report=await checkSetup(url);assert.equal(report.code,'MIGRATION_REQUIRED');assert.equal(report.ok,false);assert.deepEqual(report.details.missing,['idempotency_requests']);
    assert.deepEqual(await snapshot(owner),before,'diagnosis and failed write leave original rows untouched');
    for(const file of ['001-current-revision-integrity.sql','002-create-idempotency.sql'])await owner.query(fs.readFileSync('db/migrations/'+file,'utf8'));
    const needs003=await checkSetup(url);assert.equal(needs003.code,'MIGRATION_REQUIRED');assert.match(needs003.message,/001、002、003/);assert.equal(needs003.details,undefined);
    await owner.query(fs.readFileSync('db/migrations/003-membership-active.sql','utf8'));
    assert.equal((await checkSetup(url)).code,'BASIC_CHECKS_PASSED');
    assert.deepEqual(await snapshot(owner),{...before,memberships:before.memberships.map(row=>({...row,active:true}))});
  });
});
test('setup diagnostic rejects administrator and disabled RLS, and prints no connection secrets',async()=>{
  await fixture('db/schema.sql',async(owner,url,adminURL)=>{
    const before=await snapshot(owner);assert.equal((await checkSetup(adminURL)).code,'UNSAFE_DATABASE_ROLE');
    await assert.rejects(()=>promisify(execFile)(process.execPath,['scripts/check-setup.js'],{env:{...process.env,DATABASE_URL:adminURL},timeout:15000}),e=>e.code===1&&e.stderr===''&&JSON.parse(e.stdout).code==='UNSAFE_DATABASE_ROLE'&&!e.stdout.includes(adminURL));
    const run=await promisify(execFile)(process.execPath,['scripts/check-setup.js'],{env:{...process.env,DATABASE_URL:url},timeout:15000});assert.equal(run.stderr,'');assert.equal(JSON.parse(run.stdout).ok,true);assert.ok(!run.stdout.includes('memz_demo_only'));
    await owner.query('ALTER TABLE sources DISABLE ROW LEVEL SECURITY');assert.equal((await checkSetup(url)).code,'RLS_DISABLED');
    await owner.query('ALTER TABLE sources ENABLE ROW LEVEL SECURITY');assert.deepEqual(await snapshot(owner),before);
    const wrong=new URL(url);wrong.password='synthetic-password-canary';const bad=await checkSetup(wrong.href);assert.equal(bad.code,'DATABASE_UNAVAILABLE');assert.ok(!JSON.stringify(bad).includes('synthetic-password-canary'));
  });
});
test('setup checker rejects nonlocal parsed connection targets without contacting them',async()=>{
  for(const url of ['postgres://u:synthetic-secret@example.invalid/db','postgres://u:synthetic-secret@127.0.0.1/db?host=example.invalid']){
    const report=await checkSetup(url);assert.equal(report.code,'LOCAL_DATABASE_REQUIRED');assert.ok(!JSON.stringify(report).includes('synthetic-secret'));
  }
});
