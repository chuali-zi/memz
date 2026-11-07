// Real PostgreSQL/HTTP fault injection, exclusively in a random synthetic DB.
// No protocol, startup, authentication, connection URL or frame contents are logged.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {spawn}=require('node:child_process');
const {Client}=require('pg');

const ROOT=path.resolve(__dirname,'..');
const MAX_BUFFER=1024*1024;
const SOCKET_TIMEOUT=10000;

// Backend protocol v3: type byte, Int32 length (including itself), then payload.
// https://www.postgresql.org/docs/16/protocol-message-formats.html
async function commitAckProxy({host,port,database}){
  assert.ok(['127.0.0.1','localhost','::1'].includes(host),'Proxy upstream must be local');
  assert.match(database,/^memz_commit_ack_[a-f0-9]{16}$/);
  let armed=false,dropped=0,problem;
  const sockets=new Set();
  const server=net.createServer(front=>{
    let back,startup=Buffer.alloc(0),pending=Buffer.alloc(0),frontendBytes=0,backendBytes=0,closed=false;
    const track=socket=>{
      sockets.add(socket);socket.setTimeout(SOCKET_TIMEOUT,()=>stop('SOCKET_TIMEOUT'));
      socket.on('error',()=>stop('SOCKET_ERROR'));
      socket.on('close',()=>{sockets.delete(socket);stop()});
    };
    const stop=code=>{
      if(closed)return;
      closed=true;if(code)problem=problem||code;
      startup=Buffer.alloc(0);pending=Buffer.alloc(0);
      front.destroy();if(back)back.destroy();
    };
    track(front);
    const forward=bytes=>{
      if(back.writableLength+bytes.length>MAX_BUFFER)return stop('FRONTEND_BUFFER_LIMIT');
      if(!back.write(bytes)){front.pause();back.once('drain',()=>{if(!closed)front.resume()})}
    };
    front.on('data',chunk=>{
      frontendBytes+=chunk.length;
      if(frontendBytes>4*MAX_BUFFER)return stop('FRONTEND_TOTAL_LIMIT');
      if(back)return forward(chunk);
      if(startup.length+chunk.length>8192)return stop('STARTUP_LIMIT');
      startup=Buffer.concat([startup,chunk]);
      if(startup.length<8)return;
      const length=startup.readInt32BE(0);
      // Explicitly reject SSL negotiation, cancellation and non-fixture targets.
      if(length<9||length>8192||startup.readInt32BE(4)!==196608)return stop('UNSUPPORTED_STARTUP');
      if(startup.length<length)return;
      const fields=startup.subarray(8,length-1).toString('utf8').split('\0');
      if(fields.pop()!==''||fields.length%2)return stop('INVALID_STARTUP');
      const values=new Map();
      for(let i=0;i<fields.length;i+=2){
        if(values.has(fields[i]))return stop('DUPLICATE_STARTUP_FIELD');
        values.set(fields[i],fields[i+1]);
      }
      if(values.get('database')!==database||values.get('user')!=='memz_app')return stop('NON_FIXTURE_TARGET');
      back=net.connect({host,port});track(back);
      back.on('data',bytes=>{
        backendBytes+=bytes.length;
        if(backendBytes>4*MAX_BUFFER||pending.length+bytes.length>MAX_BUFFER)return stop('BACKEND_BUFFER_LIMIT');
        pending=Buffer.concat([pending,bytes]);
        while(pending.length>=5){
          const frameLength=pending.readInt32BE(1);
          if(frameLength<4||frameLength+1>MAX_BUFFER)return stop('INVALID_BACKEND_FRAME');
          if(pending.length<frameLength+1)return;
          const frame=pending.subarray(0,frameLength+1);
          pending=pending.subarray(frameLength+1);
          if(armed&&frame[0]===0x43&&frame.subarray(5).equals(Buffer.from('COMMIT\0'))){
            // PostgreSQL has completed COMMIT. Neither this ack nor ReadyForQuery
            // reaches the application; close both sockets without sending an error frame.
            armed=false;dropped++;stop();return;
          }
          if(front.writableLength+frame.length>MAX_BUFFER)return stop('BACKEND_OUTPUT_LIMIT');
          if(!front.write(frame)){
            back.pause();front.once('drain',()=>{if(!closed)back.resume()});
          }
        }
      });
      const first=startup;startup=Buffer.alloc(0);forward(first);
    });
  });
  await new Promise((resolve,reject)=>{
    server.once('error',()=>reject(new Error('Synthetic commit proxy failed to listen')));
    server.listen(0,'127.0.0.1',resolve);
  });
  return {
    port:server.address().port,
    arm(){assert.equal(armed,false);assert.equal(problem,undefined,'Proxy must be healthy before injection');armed=true;},
    status(){return {armed,dropped,problem};},
    async close(){
      for(const socket of sockets)socket.destroy();
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Synthetic commit proxy cleanup timed out')),3000);
        server.close(error=>{clearTimeout(timer);error?reject(new Error('Synthetic commit proxy cleanup failed')):resolve()});
      });
      assert.equal(sockets.size,0,'All proxy connections must be closed');
    }
  };
}

async function startApp(databaseURL){
  const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:{...process.env,DATABASE_URL:databaseURL,PORT:'0'},stdio:['ignore','pipe','pipe']});
  let logs='',exited=false;
  const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve()}));
  child.stderr.on('data',bytes=>{logs=(logs+bytes.toString('utf8')).slice(-16384)});
  const close=async()=>{
    if(exited)return;
    child.kill('SIGTERM');
    let timer;
    try{await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Synthetic app cleanup timed out'))},3000)})]);}
    finally{clearTimeout(timer)}
  };
  try{
    const base=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Synthetic commit test app startup timed out')),10000);
      child.once('error',()=>{clearTimeout(timer);reject(new Error('Synthetic commit test app could not start'))});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Synthetic commit test app exited before startup'))});
      child.stdout.on('data',bytes=>{
        output=(output+bytes.toString('utf8')).slice(-4096);
        const match=output.match(/Memz (http:\/\/127\.0\.0\.1:\d+)/);
        if(match){clearTimeout(timer);resolve(match[1])}
      });
    });
    return {base,close,logs:()=>logs,exited:()=>exited};
  }catch(error){await close();throw error}
}

test('lost real PostgreSQL COMMIT acknowledgements yield uncertain HTTP failures and single idempotent writes', {timeout:45000}, async t=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use the isolated system evidence runner with a local test administrator URL');
  let adminURL;
  try{adminURL=new URL(process.env.MIGRATION_TEST_DATABASE_URL)}catch{throw new Error('Local test administrator URL is invalid')}
  const admin=new Client({connectionString:adminURL.href,connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});
  assert.ok(['127.0.0.1','localhost','::1','[::1]'].includes(admin.host),'Commit fault injection requires a local test PostgreSQL');
  const database='memz_commit_ack_'+randomBytes(8).toString('hex');
  let connected=false,created=false,owner,proxy,app,failure;
  try{
    try{await admin.connect();connected=true}catch{throw new Error('Local test PostgreSQL connection failed')}
    await admin.query(`CREATE DATABASE ${database}`);created=true;
    const ownerURL=new URL(adminURL);ownerURL.pathname='/'+database;
    owner=new Client({connectionString:ownerURL.href,connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});await owner.connect();
    await owner.query(fs.readFileSync(path.join(ROOT,'db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    proxy=await commitAckProxy({host:admin.host.replace(/^\[|\]$/g,''),port:Number(admin.port),database});
    // Build this URL afresh: admin query parameters cannot redirect the proxy app.
    const appURL=`postgres://memz_app:memz_demo_only@127.0.0.1:${proxy.port}/${database}?sslmode=disable`;
    app=await startApp(appURL);
    const login=await fetch(app.base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'demo-owner'}),signal:AbortSignal.timeout(5000)});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf;
    const request=async(route,body,key)=>{
      const response=await fetch(app.base+route,{method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(7000)});
      return {status:response.status,data:await response.json()};
    };
    const counts=async(operation,id,key,body)=>({
      rows:Number((await owner.query(operation==='sources'?
        'SELECT count(*) AS n FROM sources WHERE project_id=1 AND title=$1':
        'SELECT count(*) AS n FROM candidates WHERE project_id=1 AND subject=$1',
      [operation==='sources'?body.title:body.subject])).rows[0].n),
      audit:Number((await owner.query('SELECT count(*) AS n FROM audit WHERE project_id=1 AND actor_id=1 AND action=$1 AND detail=$2',[operation==='sources'?'source':'propose',operation==='sources'?`新增来源 ${id}`:`候选 ${id}`])).rows[0].n),
      receipts:Number((await owner.query('SELECT count(*) AS n FROM idempotency_requests WHERE project_id=1 AND actor_id=1 AND operation=$1 AND request_key=$2',[operation,key])).rows[0].n)
    });
    let sourceId;
    for(const operation of ['sources','candidates']){
      const before=proxy.status().dropped,key='real-commit-ack-'+operation;
      const body=operation==='sources'?{title:'合成提交回执丢失来源',content:'仅在随机隔离库中进行的真实COMMIT故障演练'}:
        {subject:'提交回执丢失合成主体',predicate:'状态',value:'待负责人审批',source_id:sourceId,expected_version:0};
      proxy.arm();
      const lost=await request('/api/projects/1/'+operation,body,key);
      assert.equal(lost.status,503,'lost database acknowledgement must be uncertain, not successful');
      assert.match(lost.data.error,/写入结果可能不确定/);
      assert.deepEqual(proxy.status(),{armed:false,dropped:before+1,problem:undefined},'exactly one real COMMIT acknowledgement must have been withheld');
      // Independent direct connection, before any retry: committed row and
      // idempotency receipt must already exist despite the application's 503.
      const found=operation==='sources'?
        await owner.query('SELECT id FROM sources WHERE project_id=1 AND title=$1',[body.title]):
        await owner.query('SELECT id,source_id,status FROM candidates WHERE project_id=1 AND subject=$1',[body.subject]);
      assert.equal(found.rowCount,1);const id=found.rows[0].id;
      if(operation==='sources')sourceId=id;
      else{assert.equal(found.rows[0].source_id,sourceId);assert.equal(found.rows[0].status,'pending')}
      assert.deepEqual(await counts(operation,id,key,body),{rows:1,audit:1,receipts:1});
      const replay=await request('/api/projects/1/'+operation,body,key);
      assert.equal(replay.status,200);assert.equal(replay.data.id,id);
      assert.deepEqual(await counts(operation,id,key,body),{rows:1,audit:1,receipts:1});
      assert.equal(proxy.status().dropped,before+1,'replay must not trigger another fault');
    }
    const me=await fetch(app.base+'/api/me',{headers:{cookie},signal:AbortSignal.timeout(3000)});
    assert.equal(me.status,200);await me.json();assert.equal(app.exited(),false);
    assert.deepEqual(proxy.status(),{armed:false,dropped:2,problem:undefined});
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM facts WHERE subject=$1',['提交回执丢失合成主体'])).rows[0].n,0,'candidate replay must not approve a fact');
    assert.equal(app.logs().trim().split('\n').length,2);
    assert.ok(app.logs().trim().split('\n').every(line=>/^Request failed: (Error|ECONNRESET|08006)$/.test(line)),'child diagnostics must remain fixed and sanitized');
    t.diagnostic('Synthetic real PostgreSQL evidence: two COMMIT completion frames withheld; source and pending candidate committed before HTTP 503; original-key replays returned the same IDs with one row, audit and receipt each.');
  }catch(error){failure=error}
  finally{
    const cleanup=[];
    for(const [name,close] of [['app',()=>app?.close()],['proxy',()=>proxy?.close()],['owner',()=>owner?.end()]]){
      try{await close()}catch{cleanup.push(name)}
    }
    if(created)try{await admin.query(`DROP DATABASE ${database} WITH (FORCE)`)}catch{cleanup.push('database')}
    if(connected)try{await admin.end()}catch{cleanup.push('admin')}
    if(cleanup.length)failure=new Error('Synthetic commit fault cleanup failed: '+cleanup.join(', '));
    else t.diagnostic('Synthetic commit fixture cleanup complete: child, proxy sockets, direct connections and random database removed.');
  }
  if(failure)throw failure;
});
