const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {Client}=require('pg');
const {DATABASE_LIMITS}=require('../scripts/database');
const {app,pool,tx}=require('../server');
const server=app.listen(0,'127.0.0.1'),ready=once(server,'listening');
after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end()});

test('PostgreSQL connections inherit the server statement deadline',async()=>{
  assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout,'10s');
});
test('statement cancellation rolls back the whole transaction and clears its local identity',async()=>{
  let pid;
  await assert.rejects(()=>tx(1,async client=>{
    pid=client.processID;
    await client.query('CREATE TEMP TABLE memz_deadline_rollback(value int) ON COMMIT DROP');
    await client.query('INSERT INTO memz_deadline_rollback VALUES(1)');
    await client.query('SET LOCAL statement_timeout=75');
    await client.query('SELECT pg_sleep(2)');
  }),error=>error.code==='57014');
  const client=await pool.connect();
  try{
    assert.equal(client.processID,pid,'a successful rollback should retain this healthy client');
    assert.equal((await client.query("SELECT to_regclass('pg_temp.memz_deadline_rollback') AS table_name")).rows[0].table_name,null);
    assert.equal((await client.query("SELECT nullif(current_setting('app.user_id',true),'') AS user_id")).rows[0].user_id,null);
    assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout,'10s');
    assert.equal((await client.query('SELECT * FROM facts')).rowCount,0,'RLS stays closed after the timeout');
  }finally{client.release()}
  assert.equal((await tx(1,client=>client.query('SELECT role FROM memberships WHERE project_id=1'))).rows[0].role,'owner');
});
test('a callback that catches its SQL failure cannot turn an aborted PostgreSQL transaction into a success receipt',async()=>{
  for(const timedOut of [false,true]){
    let pid,calls=0,swallowed;
    await assert.rejects(()=>tx(1,async client=>{
      calls++;pid=client.processID;
      await client.query('CREATE TEMP TABLE memz_swallowed_failure(value int) ON COMMIT DROP');
      await client.query('INSERT INTO memz_swallowed_failure VALUES(1)');
      if(timedOut)await client.query('SET LOCAL statement_timeout=75');
      try{await client.query(timedOut?'SELECT pg_sleep(2)':'SELECT 1/0')}
      catch(error){swallowed=error.code}
      return {ok:true,value:'synthetic-private-result'};
    }),error=>error.message==='Database transaction did not commit'&&error.cause===undefined);
    assert.equal(calls,1,'failed commit confirmation must never repeat the callback');
    assert.equal(swallowed,timedOut?'57014':'22012');
    const client=await pool.connect();
    try{
      assert.equal(client.processID,pid);
      assert.equal((await client.query("SELECT to_regclass('pg_temp.memz_swallowed_failure') AS table_name")).rows[0].table_name,null);
      assert.equal((await client.query("SELECT nullif(current_setting('app.user_id',true),'') AS user_id")).rows[0].user_id,null);
      assert.equal((await client.query('SELECT * FROM facts')).rowCount,0);
    }finally{client.release()}
  }
});
test('client response timeout discards the unfinished connection and the next transaction reconnects',async()=>{
  let pid;
  await assert.rejects(()=>tx(1,async client=>{
    pid=client.processID;
    await client.query({text:'SELECT pg_sleep(2)',query_timeout:75});
  }),error=>error.message==='Query read timeout');
  const next=await tx(3,async client=>({pid:client.processID,role:(await client.query('SELECT role FROM memberships WHERE project_id=1 AND user_id=3')).rows[0].role}));
  assert.notEqual(next.pid,pid);assert.equal(next.role,'viewer');
});
test('a terminated checked-out backend does not crash the process or poison the next transaction',async()=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use an isolated system evidence database');
  const admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});await admin.connect();
  let signalStarted,pid;
  const started=new Promise(resolve=>{signalStarted=resolve});
  const operation=tx(1,async client=>{pid=client.processID;signalStarted();await client.query('SELECT pg_sleep(5)')});
  const rejection=assert.rejects(operation,error=>['57P01','ECONNRESET'].includes(error.code)||/Connection terminated|not queryable/.test(error.message));
  try{
    await started;
    const terminated=await admin.query("SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename='memz_app'",[pid]);
    assert.equal(terminated.rowCount,1);assert.equal(terminated.rows[0].stopped,true);await rejection;
    const next=await tx(1,client=>client.query('SELECT 1 AS value'));assert.equal(next.rows[0].value,1);
  }finally{await admin.end()}
});
test('saturated pool bounds real HTTP reads and writes, then recovers with the same session',async()=>{
  await ready;const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'demo-owner'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf;
  const held=[];
  try{
    for(let i=0;i<DATABASE_LIMITS.max;i++)held.push(await pool.connect());
    const started=Date.now();
    const responses=await Promise.all([
      fetch(base+'/api/projects',{headers:{cookie},signal:AbortSignal.timeout(10000)}),
      fetch(base+'/api/projects/1/sources',{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({title:'must not be written',content:'synthetic'}),signal:AbortSignal.timeout(10000)})
    ]);
    for(const response of responses)assert.equal(response.status,503);
    assert.deepEqual(await responses[0].json(),{error:'数据库请求超时，请稍后重试'});
    assert.match((await responses[1].json()).error,/写入结果可能不确定/);
    assert.ok(Date.now()-started<DATABASE_LIMITS.connectionTimeoutMillis+4000);
    assert.equal(pool.waitingCount,0,'timed out requests must leave no pending checkouts');
  }finally{for(const client of held)client.release()}
  const recovered=await fetch(base+'/api/projects',{headers:{cookie}});assert.equal(recovered.status,200);
  assert.ok((await recovered.json()).some(project=>project.id===1&&project.role==='owner'));
  assert.equal((await tx(1,client=>client.query("SELECT id FROM sources WHERE title='must not be written'"))).rowCount,0,'timed out writes must not execute later');
});
