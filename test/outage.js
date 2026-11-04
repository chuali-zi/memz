// Dedicated disposable PostgreSQL instance: never stop the developer's database.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {randomUUID}=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {Client}=require('pg');
const execute=promisify(execFile),env={...process.env};
for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
const docker=async(...args)=>(await execute('docker',['--host=unix:///var/run/docker.sock',...args],{env,timeout:45000,maxBuffer:1024*1024})).stdout.trim();
async function main(){
  const report={synthetic:true,passed:false,checks:[],cleanup:false};let container,server,pool,owner,connected=false;
  try{
    const reservation=require('node:net').createServer();
    await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
    container=await docker('create','--name','memz-outage-'+randomUUID(),'-p',`127.0.0.1:${port}:5432`,'-e','POSTGRES_PASSWORD=postgres_demo_only','-e','POSTGRES_DB=memz','postgres:16');
    await docker('start',container);
    const address=await docker('port',container,'5432/tcp');assert.match(address,/^127\.0\.0\.1:\d+$/);
    const ownerURL=`postgres://postgres:postgres_demo_only@${address}/memz`;
    async function ready(){
      for(let i=0;i<100;i++){
        const client=new Client({connectionString:ownerURL,connectionTimeoutMillis:500});
        try{await client.connect();await client.query('SELECT 1');await client.end();return}catch{await client.end().catch(()=>{});await new Promise(r=>setTimeout(r,100))}
      }
      throw new Error('isolated PostgreSQL did not become ready');
    }
    await ready();owner=new Client({connectionString:ownerURL});await owner.connect();connected=true;
    await owner.query(fs.readFileSync('db/schema.sql','utf8'));await owner.end();connected=false;
    process.env.DATABASE_URL=`postgres://memz_app:memz_demo_only@${address}/memz`;
    const appModule=require('../server');pool=appModule.pool;
    server=appModule.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${server.address().port}`;
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'demo-owner'})});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf;
    const request=(path,opts={})=>fetch(base+path,{...opts,headers:{cookie,...opts.headers},signal:AbortSignal.timeout(5000)});
    const before=await request('/api/projects');assert.equal(before.status,200);const projects=await before.json();
    const sent=[];let loseNext=false,committedId;
    const context=vm.createContext({document:{querySelector:()=>({username:{}})},crypto:{randomUUID},fetch:async(path,opts)=>{
      sent.push({key:opts.headers['Idempotency-Key'],body:opts.body});
      const response=await request(path,{...opts,headers:{...opts.headers,'X-CSRF-Token':csrf}});
      if(loseNext){loseNext=false;assert.equal(response.status,200);committedId=(await response.json()).id;throw new Error('synthetic response lost after commit')}
      return response;
    }});
    vm.runInContext(fs.readFileSync('public/app.js','utf8')+'\nglobalThis.create=createRecord;',context);
    const body={title:'隔离停机恢复来源',content:'仅合成测试数据'},path='/api/projects/1/sources';
    await docker('stop','--time','5',container);
    const down=await request('/api/projects');report.readDuringOutage={status:down.status,body:await down.json()};
    assert.equal(down.status,503,'database unavailable read should be explicitly retryable');
    await assert.rejects(context.create(path,body),/503.*写入结果可能不确定/);assert.equal(sent.length,1,'no automatic write replay');
    report.checks.push('read503-write503-no-automatic-replay');
    await docker('start',container);await ready();
    const after=await request('/api/projects');assert.equal(after.status,200);assert.deepEqual(await after.json(),projects);
    const saved=await context.create(path,body);assert.equal(sent[0].key,sent[1].key);assert.ok(saved.id);
    report.checks.push('same-session-and-create-key-after-restart');
    const uncertain={title:'响应丢失恢复来源',content:'数据库已提交但客户端没有收到响应'};
    loseNext=true;await assert.rejects(context.create(path,uncertain),/synthetic response lost/);assert.equal(sent.length,3);
    await docker('stop','--time','5',container);
    await assert.rejects(context.create(path,uncertain),/503/);assert.equal(sent[2].key,sent[3].key);
    await docker('start',container);await ready();
    const replay=await context.create(path,uncertain);assert.equal(replay.id,committedId);assert.equal(sent[2].key,sent[4].key);
    owner=new Client({connectionString:ownerURL});await owner.connect();connected=true;
    for(const title of [body.title,uncertain.title])assert.equal((await owner.query('SELECT count(*)::int AS n FROM sources WHERE title=$1',[title])).rows[0].n,1);
    const foreign=await request('/api/projects/2/facts');assert.equal(foreign.status,403);await foreign.json();
    report.checks.push('committed-response-loss-replay-no-duplicate','project-boundary-preserved');
    await owner.end();connected=false;
    report.browser=await require('./outage-browser')({base,stop:()=>docker('stop','--time','5',container),start:async()=>{await docker('start',container);await ready()},count:async title=>{const c=new Client({connectionString:ownerURL});try{await c.connect();return (await c.query('SELECT count(*)::int AS n FROM sources WHERE title=$1',[title])).rows[0].n}finally{await c.end()}}});
    report.passed=true;
  }finally{
    try{
      try{if(connected)await owner.end()}finally{try{if(server)await new Promise(r=>server.close(r))}finally{if(pool)await pool.end()}}
    }finally{
      try{if(container){await docker('rm','-f','-v',container);report.cleanup=true}}
      finally{fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/outage-report.json',JSON.stringify(report,null,2)+'\n')}
    }
  }
  console.log('PostgreSQL stop/start recovery: passed; artifacts/outage-report.json');
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
