const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),{randomBytes}=require('node:crypto'),{Client}=require('pg');
const execute=require('node:util').promisify(require('node:child_process').execFile);
async function dropTestDatabase(admin,database){
  assert.match(database,/^memz_repeat_[0-9a-f]{16}$/);
  try{await admin.query(`DROP DATABASE ${database}`)}
  catch(error){throw new Error(`Repeated rehearsal cleanup failed for ${database} (${error.code||'unknown'}); inspect this test database only; no forced disconnect or cleanup retry was attempted`,{cause:error})}
}
test('two complete demo runs preserve earlier records in a fresh isolated database',async t=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use the isolated system evidence runner');
  const admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});
  const database='memz_repeat_'+randomBytes(8).toString('hex');
  let created=false,owner,server,pool;
  const tables=['projects','memberships','sources','candidates','facts','revisions','audit','idempotency_requests'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await owner.query(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows.map(r=>r.row)])));
  const assertPreserved=(before,after)=>{for(const table of tables){const rows=new Set(after[table]);for(const row of before[table])assert.ok(rows.has(row),`existing ${table} row changed or disappeared`)}};
  await admin.connect();
  try{
    await admin.query(`CREATE DATABASE ${database}`);created=true;
    const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+database;
    owner=new Client({connectionString:url.href});await owner.connect();
    await owner.query(fs.readFileSync('db/schema.sql','utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;
    const service=require('../server');pool=service.pool;server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const baseURL=`http://127.0.0.1:${server.address().port}`,initial=await snapshot(),rounds=[];let previous=initial;
    for(let round=1;round<=2;round++){
      const {stdout}=await execute(process.execPath,['scripts/demo-story.js'],{env:{...process.env,MEMZ_DEMO_BASE_URL:baseURL},timeout:30000,maxBuffer:1024*1024});
      const story=JSON.parse(stdout),fact=story.context.facts[0];
      assert.equal(story.synthetic,true);assert.equal(story.steps.length,7);assert.equal(fact.value,'15号');assert.equal(fact.version,2);assert.equal(story.provenanceV1.value,'20号');
      assert.equal(story.steps[3].status,409);assert.equal(story.steps[6].viewerWriteStatus,403);assert.equal(story.steps[6].otherProjectReadStatus,403);
      const current=await snapshot();assertPreserved(previous,current);
      const additions=Object.fromEntries(tables.map(table=>[table,current[table].length-previous[table].length]));
      assert.deepEqual(additions,{projects:0,memberships:0,sources:3,candidates:4,facts:1,revisions:2,audit:10,idempotency_requests:7});
      const states=(await owner.query('SELECT status FROM candidates WHERE subject=$1 ORDER BY id',[story.subject])).rows.map(r=>r.status);
      assert.deepEqual(states,['approved','approved','pending','rejected']);
      rounds.push({round,subject:story.subject,factId:fact.id,value:fact.value,version:fact.version,sourceId:fact.source.id,oldSourceId:story.provenanceV1.source.id,additions});previous=current;
    }
    assert.notEqual(rounds[0].subject,rounds[1].subject);assert.notEqual(rounds[0].factId,rounds[1].factId);assert.notEqual(rounds[0].sourceId,rounds[1].sourceId);
    assertPreserved(initial,previous);
    // The test's own open owner connection deliberately blocks DROP; no other database is targeted.
    await assert.rejects(()=>dropTestDatabase(admin,database),error=>error.cause?.code==='55006'&&error.message.includes(database)&&error.message.includes('no forced disconnect'));
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,1);
    t.diagnostic('Controlled cleanup failure: own open connection produced 55006 and a named-target error; database retained until connections close');
    t.diagnostic('Synthetic repeated rehearsal: '+JSON.stringify({rounds,seedRowsPreserved:true,firstRoundRowsPreserved:true}));
  }finally{
    try{
      try{if(server)await new Promise(r=>server.close(r))}finally{try{if(pool)await pool.end()}finally{if(owner)await owner.end()}}
    }finally{
      try{
        if(created){
          await dropTestDatabase(admin,database);assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0);t.diagnostic('Repeated rehearsal temporary database cleanup: confirmed');
        }
      }finally{await admin.end()}
    }
  }
});
