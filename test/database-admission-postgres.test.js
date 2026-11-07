const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {randomBytes}=require('node:crypto');
const {Client,Pool}=require('pg');
const {DATABASE_LIMITS,MAX_PENDING_CHECKOUTS,databasePoolOptions,pendingTransactionCheckouts,runTransaction}=require('../scripts/database');
const name='memz_admission_'+randomBytes(8).toString('hex');
let admin,owner,service,server,base,appURL,cookie,csrf,created=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+4000;while(!check()&&Date.now()<deadline)await delay(5);assert.equal(check(),true)}
async function scoped(client){return (await client.query('SELECT id FROM facts WHERE project_id=1')).rowCount}
async function counts(){return (await owner.query('SELECT (SELECT count(*) FROM sources)::int AS sources,(SELECT count(*) FROM candidates)::int AS candidates,(SELECT count(*) FROM audit)::int AS audit,(SELECT count(*) FROM idempotency_requests)::int AS receipts')).rows[0]}
async function hold(){const clients=await Promise.all(Array.from({length:10},()=>service.pool.connect()));return clients}
function release(clients){for(const client of clients.splice(0))client.release()}
function post(path,body,key){return fetch(base+path,{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)})}
before(async()=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use a dedicated test administrator connection');
  admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});await admin.connect();await admin.query(`CREATE DATABASE ${name}`);created=true;
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;owner=new Client({connectionString:url.href});await owner.connect();
  await owner.query(fs.readFileSync(require('node:path').join(__dirname,'../db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
  url.username='memz_app';url.password='memz_demo_only';appURL=url.href;process.env.DATABASE_URL=appURL;
  service=require('../server');server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'demo-owner'})});
  assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
});
after(async()=>{
  try{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}if(service)await service.pool.end()}
  finally{if(owner)await owner.end();if(created){await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);console.log('Synthetic admission database cleanup: passed')}if(admin)await admin.end()}
});
test('real pg raw pool has 50 unguarded queued checkouts and drains them without a transaction',async()=>{
  const pool=new Pool(databasePoolOptions(appURL)),held=[];let settled;
  try{
    const connecting=Array.from({length:10},()=>pool.connect());
    assert.equal(pool.totalCount,10);assert.equal(pool.waitingCount,0,'handshakes are absent from waitingCount');
    held.push(...await Promise.all(connecting));
    const queued=Array.from({length:50},()=>pool.connect().then(client=>client.release()));settled=Promise.allSettled(queued);
    assert.equal(pool.waitingCount,50);held.pop().release();
    for(const result of await settled)assert.equal(result.status,'fulfilled');assert.equal(pool.waitingCount,0);
  }finally{release(held);if(settled)await settled;await pool.end()}
});
test('real initial handshakes and native queue share 32 guarded handoffs, with RLS identity preserved',async()=>{
  const pool=new Pool(databasePoolOptions(appURL));let settled;
  try{
    const jobs=Array.from({length:MAX_PENDING_CHECKOUTS},(_,i)=>runTransaction(pool,i%2?4:3,scoped));settled=Promise.allSettled(jobs);
    assert.equal(pendingTransactionCheckouts(pool),32);assert.equal(pool.totalCount,10);assert.equal(pool.waitingCount,22);
    let called=false;await assert.rejects(runTransaction(pool,1,()=>{called=true}),{code:'DB_ADMISSION_BUSY'});assert.equal(called,false);
    const results=await settled;for(let i=0;i<results.length;i++){assert.equal(results[i].status,'fulfilled');assert.equal(results[i].value,i%2?0:1)}
    assert.equal(pendingTransactionCheckouts(pool),0);assert.equal(pool.waitingCount,0);assert.equal((await pool.query('SELECT id FROM facts')).rowCount,0);
  }finally{if(settled)await settled;await pool.end()}
});
test('HTTP overflow rejects source and candidate before SQL while accepted writes and scoped reads finish once',async()=>{
  const held=await hold(),before=await counts();let accepted,queued,queuedResults;
  try{
    accepted=post('/api/projects/1/sources',{title:'synthetic accepted admission',content:'fixture'},'admission-accepted');
    await until(()=>pendingTransactionCheckouts(service.pool)===1);
    queued=Array.from({length:31},(_,i)=>service.tx(i%2?4:3,scoped));queuedResults=Promise.allSettled(queued);
    assert.equal(service.pool.waitingCount,32);assert.equal(pendingTransactionCheckouts(service.pool),32);
    const responses=await Promise.all([
      post('/api/projects/1/sources',{title:'synthetic denied admission',content:'fixture'},'admission-denied-source'),
      post('/api/projects/1/candidates',{subject:'synthetic denied admission',predicate:'fixture',value:'fixture',source_id:1,expected_version:0},'admission-denied-candidate'),
      fetch(base+'/api/projects',{headers:{cookie},signal:AbortSignal.timeout(10000)})
    ]);
    for(const response of responses){assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'1');assert.deepEqual(await response.json(),{error:'服务繁忙，请稍后重试'})}
    assert.deepEqual(await counts(),before,'denied work must not write source/candidate/audit/idempotency rows');
    assert.equal(pendingTransactionCheckouts(service.pool),32);assert.equal(service.pool.waitingCount,32);
    release(held);const response=await accepted;assert.equal(response.status,200);const source=await response.json();assert.equal(source.title,'synthetic accepted admission');
    const results=await queuedResults;for(let i=0;i<results.length;i++){assert.equal(results[i].status,'fulfilled');assert.equal(results[i].value,i%2?0:1)}
    assert.deepEqual(await counts(),{sources:before.sources+1,candidates:before.candidates,audit:before.audit+1,receipts:before.receipts+1});
    assert.equal((await owner.query("SELECT id FROM sources WHERE title='synthetic denied admission'")).rowCount,0);
    assert.equal((await owner.query("SELECT id FROM candidates WHERE subject='synthetic denied admission'")).rowCount,0);
    assert.equal(pendingTransactionCheckouts(service.pool),0);assert.equal(service.pool.waitingCount,0);
    const replay=await post('/api/projects/1/sources',{title:'synthetic accepted admission',content:'fixture'},'admission-accepted');assert.equal(replay.status,200);assert.deepEqual(await replay.json(),source);
    assert.deepEqual(await counts(),{sources:before.sources+1,candidates:before.candidates,audit:before.audit+1,receipts:before.receipts+1});
  }finally{release(held);if(accepted)await accepted.catch(()=>{});if(queuedResults)await queuedResults}
});
test('six native queued requests time out without callbacks or slot leaks, then same-session HTTP recovers',async()=>{
  const held=await hold();let calls=0;const started=Date.now();
  const jobs=Array.from({length:6},()=>service.tx(1,()=>{calls++;return 1})),settled=Promise.allSettled(jobs);
  try{
    assert.equal(pendingTransactionCheckouts(service.pool),6);assert.equal(service.pool.waitingCount,6);
    for(const result of await settled){assert.equal(result.status,'rejected');assert.equal(result.reason.message,'timeout exceeded when trying to connect')}
    assert.equal(calls,0);assert.ok(Date.now()-started>=DATABASE_LIMITS.connectionTimeoutMillis-200);
    assert.equal(pendingTransactionCheckouts(service.pool),0);assert.equal(service.pool.waitingCount,0);
  }finally{release(held);await settled}
  const response=await fetch(base+'/api/projects',{headers:{cookie}});assert.equal(response.status,200);assert.equal(response.headers.get('retry-after'),null);assert.ok((await response.json()).some(project=>project.id===1));
});
test('a real checked-out backend loss preserves queued admissions and transaction failure cleanup, then restores RLS reads',async()=>{
  const held=await hold(),victim=held.pop();let signal;
  const disconnected=new Promise(resolve=>{signal=resolve});victim.once('error',signal);
  const jobs=Array.from({length:6},(_,i)=>service.tx(i%2?4:3,scoped)),settled=Promise.allSettled(jobs);let released=false;
  try{
    assert.equal(pendingTransactionCheckouts(service.pool),6);
    assert.equal((await owner.query('SELECT pg_terminate_backend($1) AS stopped',[victim.processID])).rows[0].stopped,true);
    const failure=await disconnected;victim.release(failure);released=true;
    const results=await settled;for(let i=0;i<results.length;i++){assert.equal(results[i].status,'fulfilled');assert.equal(results[i].value,i%2?0:1)}
    assert.equal(pendingTransactionCheckouts(service.pool),0);assert.equal(service.pool.waitingCount,0);
  }finally{if(!released)victim.release();release(held);await settled}
  let started;const active=new Promise(resolve=>{started=resolve});let pid;
  const operation=service.tx(1,async client=>{pid=client.processID;started();await client.query('SELECT pg_sleep(5)')}),outcome=Promise.allSettled([operation]);
  await active;assert.equal(pendingTransactionCheckouts(service.pool),0);
  await owner.query('SELECT pg_terminate_backend($1)',[pid]);const [result]=await outcome;assert.equal(result.status,'rejected');
  assert.equal(pendingTransactionCheckouts(service.pool),0);assert.equal(await service.tx(3,scoped),1);assert.equal(await service.tx(4,scoped),0);
  assert.equal((await service.pool.query('SELECT id FROM facts')).rowCount,0);
});
