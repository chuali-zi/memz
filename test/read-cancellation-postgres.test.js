const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {randomBytes}=require('node:crypto');
const {Client}=require('pg');
const {readContext}=require('../scripts/context-client');
const {readLabelContext}=require('../scripts/label-context');
const name='memz_read_cancel_'+randomBytes(8).toString('hex');
let admin,owner,service,server,base,created=false;
before(async()=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use a dedicated test administrator connection');
  admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});await admin.connect();await admin.query(`CREATE DATABASE ${name}`);created=true;
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;owner=new Client({connectionString:url.href});await owner.connect();
  await owner.query(fs.readFileSync(require('node:path').join(__dirname,'../db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
  url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;
  service=require('../server');server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{
  try{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}if(service)await service.pool.end()}
  finally{if(owner)await owner.end();if(created){await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);console.log('Synthetic read cancellation database cleanup: passed')}if(admin)await admin.end()}
});
test('caller cancellation closes a real locked PostgreSQL read, still logs out, and leaves permissions and pool usable',async()=>{
  const caller=new AbortController(),paths=[];let closed=false,logoutCookie='',operation,rejection;
  const observe=(req,res)=>{
    paths.push(req.url);
    if(req.url.startsWith('/api/projects/1/context?'))res.once('close',()=>{closed=true});
    if(req.url==='/api/logout')logoutCookie=req.headers.cookie||'';
  };
  server.on('request',observe);await owner.query('BEGIN');await owner.query('LOCK TABLE facts IN ACCESS EXCLUSIVE MODE');
  try{
    operation=readContext({baseURL:base,projectId:1,provenanceMode:'snapshot',sourceMode:'deduplicated',signal:caller.signal,timeoutMs:10000,totalTimeoutMs:20000});
    rejection=assert.rejects(operation,error=>error.code==='REQUEST_CANCELLED'&&error.message==='REQUEST_CANCELLED'&&error.cause===undefined);rejection.catch(()=>{});
    let blocked=false;const until=Date.now()+8000;
    while(!blocked&&Date.now()<until){
      await owner.query('SELECT pg_stat_clear_snapshot()');
      const rows=await owner.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename='memz_app' AND wait_event_type='Lock'");
      blocked=rows.rowCount===1;if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(blocked,true,'cancellation must target an actual backend waiting for this fixture lock');
    caller.abort(new Error('synthetic-private-reason'));await rejection;
    const closeDeadline=Date.now()+2000;while(!closed&&Date.now()<closeDeadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(closed,true);assert.equal(paths.length,3);assert.equal(paths.at(-1),'/api/logout');assert.ok(logoutCookie);
  }finally{
    caller.abort();await owner.query('ROLLBACK');server.removeListener('request',observe);if(operation)await operation.catch(()=>{});if(rejection)await rejection.catch(()=>{});
  }
  const session=await fetch(base+'/api/me',{headers:{cookie:logoutCookie}});assert.equal(session.status,401);await session.json();
  const current=await readContext({baseURL:base,projectId:1,provenanceMode:'snapshot',sourceMode:'deduplicated'});assert.equal(current.facts.length,1);assert.equal(current.facts[0].value,'20号');
  const planned=await readLabelContext({baseURL:base,projectId:1,question:'项目的截止日是什么？',protocol:'metadata_exact_v2'});assert.equal(planned.status,'matched');assert.equal(planned.context.facts[0].value,'20号');
  await assert.rejects(()=>readLabelContext({baseURL:base,projectId:1,question:'项目的截止日是什么？',protocol:'metadata_exact_v2',username:'other',password:'demo-other'}),{code:'HTTP_403'});
  assert.equal((await service.pool.query('SELECT id FROM facts')).rowCount,0,'a cancelled reader must not retain transaction identity in the pool');
});
