const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Client}=require('pg');
const {randomUUID}=require('node:crypto');
const {startChild}=require('./server-shutdown-helpers');

test('CLI SIGTERM drains a real PostgreSQL request waiting for a lock before closing its pool',async()=>{
  assert.ok(process.env.DATABASE_URL&&process.env.MIGRATION_TEST_DATABASE_URL,'Use the isolated system evidence runner');
  const applicationName='memz_shutdown_'+randomUUID(),url=new URL(process.env.DATABASE_URL);url.searchParams.set('application_name',applicationName);
  const app=await startChild(['server.js'],{DATABASE_URL:url.href,PORT:'0'});
  const admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});let connected=false,locked=false,pending;
  try{
    const login=await fetch(app.base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'viewer',password:'demo-viewer'})});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];await login.json();
    await admin.connect();connected=true;
    await admin.query('BEGIN');await admin.query('LOCK TABLE projects IN ACCESS EXCLUSIVE MODE');locked=true;
    pending=fetch(app.base+'/api/projects',{headers:{cookie},signal:AbortSignal.timeout(15000)});
    pending.catch(()=>{});
    const limit=Date.now()+5000;let waiting=false;
    while(!waiting&&Date.now()<limit){
      // The lock-holding transaction otherwise reuses its first activity
      // snapshot and may never observe the child's later lock wait.
      await admin.query('SELECT pg_stat_clear_snapshot()');
      const result=await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",[applicationName]);
      waiting=result.rows[0].count===1;if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'must signal while the child actually owns a blocked database request');
    app.child.kill('SIGTERM');await app.waitFor(()=>app.stdout().includes('Memz stopping;'));
    assert.equal(app.result(),undefined);app.child.kill('SIGINT');
    const active=await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND datname=current_database()',[applicationName]);
    assert.equal(active.rows[0].count,1,'pool must retain the in-flight connection during drain');
    await admin.query('COMMIT');locked=false;
    const response=await pending;assert.equal(response.status,200);
    assert.ok((await response.json()).some(project=>project.id===1&&project.role==='viewer'));
    assert.deepEqual(await app.exit,{code:0,signal:null});assert.equal(app.stderr(),'');
    const remaining=await admin.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND datname=current_database()',[applicationName]);
    assert.equal(remaining.rows[0].count,0,'successful shutdown must leave no database connection');
  }finally{
    if(locked)await admin.query('ROLLBACK');
    await app.stop();if(pending)await pending.catch(()=>{});if(connected)await admin.end();
  }
});
