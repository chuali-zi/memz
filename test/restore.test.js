const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {Client}=require('pg');
const {readContext}=require('../scripts/context-client');
const {createInterface}=require('node:readline');

function pgTool(name,url,input){
  const u=new URL(url),container=process.env.PG_TOOLS_CONTAINER;
  const env={...process.env,PGPASSWORD:decodeURIComponent(u.password)};
  const args=['--host',u.hostname,'--port',u.port||'5432','--username',decodeURIComponent(u.username),'--dbname',u.pathname.slice(1),...(name==='pg_dump'?['--format=custom']:['--exit-on-error','--single-transaction','--no-owner'])];
  return new Promise((resolve,reject)=>{
    const binary=fs.existsSync(`/usr/lib/postgresql/16/bin/${name}`)?`/usr/lib/postgresql/16/bin/${name}`:name;
    const child=spawn(container?'docker':binary,container?['exec','-i','-e','PGPASSWORD',container,name,...args]:args,{env,stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0;const timer=setTimeout(()=>{child.kill();reject(new Error(`${name} timed out`))},60000);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024){child.kill();reject(new Error('Synthetic backup exceeds test limit'))}else chunks.push(chunk)});
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(new Error(`${name} could not start`))});
    child.on('close',code=>{clearTimeout(timer);resolve({code,bytes:Buffer.concat(chunks)})});child.stdin.end(input);
  });
}
async function service(url){
  const u=new URL(url);u.username='memz_app';u.password='memz_demo_only';
  const child=spawn(process.execPath,['-e',"const {app}=require('./server');const s=app.listen(0,'127.0.0.1',()=>console.log(s.address().port));"],{env:{...process.env,DATABASE_URL:u.href},stdio:['ignore','pipe','pipe']});
  child.stderr.resume();const lines=createInterface({input:child.stdout});
  let stop;
  try{
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Restore test app startup timeout')),10000);stop=()=>{clearTimeout(timer);reject(new Error('Restore test app failed to start'))};child.once('exit',stop);child.once('error',stop);lines.once('line',line=>{clearTimeout(timer);resolve(Number(line))})});
    assert.ok(Number.isInteger(port)&&port>0);return {baseURL:`http://127.0.0.1:${port}`,close:async()=>{if(child.exitCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill()})}};
  }catch(error){child.kill();throw error}finally{lines.close();child.removeListener('exit',stop);child.removeListener('error',stop)}
}
async function login(baseURL,name){const r=await fetch(baseURL+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:name,password:`demo-${name}`})});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:(await r.json()).csrf}}
async function call(baseURL,auth,path,body,key){const r=await fetch(baseURL+path,{method:body===undefined?'GET':'POST',headers:{cookie:auth.cookie,'content-type':'application/json','x-csrf-token':auth.csrf,...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()}}
async function snapshot(c){
  const rows={};for(const table of ['projects','memberships','sources','facts','candidates','revisions','audit','idempotency_requests'])rows[table]=(await c.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
  return {rows,rls:(await c.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows,sequences:(await c.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY 1")).rows,policies:(await c.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows,grants:(await c.query("SELECT table_name,grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' ORDER BY 1,2,3")).rows,constraints:(await c.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1")).rows};
}
test('custom backup restores revisions, idempotency, RLS and future writes in isolated databases',async t=>{
  const adminURL=process.env.MIGRATION_TEST_DATABASE_URL;assert.ok(adminURL,'Use the isolated system evidence runner with an administrator URL');
  const admin=new Client({connectionString:adminURL});await admin.connect();
  const names=[],clients=[],services=[];
  try{
    const urls=[];for(const suffix of ['source','target']){const name=`memz_restore_${crypto.randomBytes(8).toString('hex')}_${suffix}`;await admin.query(`CREATE DATABASE ${name}`);names.push(name);const u=new URL(adminURL);u.pathname=`/${name}`;urls.push(u.href);const c=new Client({connectionString:u.href});await c.connect();clients.push(c)}
    const [source,target]=clients;
    await source.query(fs.readFileSync('db/schema.sql','utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    const beforeApp=await service(urls[0]);services.push(beforeApp);const owner=await login(beforeApp.baseURL,'owner');
    const sourceBody={title:'恢复演练合成来源',content:'批准截止日15号；恢复后应保留原始依据。'};
    const created=await call(beforeApp.baseURL,owner,'/api/projects/1/sources',sourceBody,'restore-source-1');assert.equal(created.status,200);
    const proposal=await call(beforeApp.baseURL,owner,'/api/projects/1/candidates',{subject:'项目',predicate:'截止日',value:'15号',expected_version:1,source_id:created.data.id},'restore-candidate-1');assert.equal(proposal.status,200);
    assert.equal((await call(beforeApp.baseURL,owner,`/api/projects/1/candidates/${proposal.data.id}/approve`,{})).status,200);
    const context=await readContext({baseURL:beforeApp.baseURL,query:'项目'});assert.equal(context.facts[0].version,2);
    await beforeApp.close();services.pop();const before=await snapshot(source);
    const dump=await pgTool('pg_dump',urls[0]);assert.equal(dump.code,0);assert.ok(dump.bytes.length>16);
    const bad=await pgTool('pg_restore',urls[1],dump.bytes.subarray(0,16));assert.notEqual(bad.code,0);
    assert.equal((await target.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rowCount,0,'invalid archive leaves empty target');
    assert.equal((await pgTool('pg_restore',urls[1],dump.bytes)).code,0);
    assert.deepEqual(await snapshot(target),before,'all business rows, sequence positions, policies, grants and constraints survive');
    const restored=await service(urls[1]);services.push(restored);const restoredOwner=await login(restored.baseURL,'owner');
    assert.deepEqual(await readContext({baseURL:restored.baseURL,query:'项目'}),context);
    const replay=await call(restored.baseURL,restoredOwner,'/api/projects/1/sources',sourceBody,'restore-source-1');assert.deepEqual(replay,created);
    assert.deepEqual(await snapshot(target),before,'idempotent replay after restore changes no business rows or sequence positions');
    await assert.rejects(()=>readContext({baseURL:restored.baseURL,username:'other',password:'demo-other'}),e=>e.status===403);
    const u=new URL(urls[1]);u.username='memz_app';u.password='memz_demo_only';const appClient=new Client({connectionString:u.href});await appClient.connect();
    try{assert.equal((await appClient.query('SELECT * FROM facts')).rowCount,0);await appClient.query('BEGIN');await appClient.query("SELECT set_config('app.user_id','4',true)");assert.equal((await appClient.query('SELECT * FROM facts WHERE project_id=1')).rowCount,0);await appClient.query('ROLLBACK')}finally{await appClient.end()}
    const nextSource=await call(restored.baseURL,restoredOwner,'/api/projects/1/sources',{title:'恢复后新来源',content:'合成新版本16号'});assert.equal(nextSource.status,200);assert.ok(nextSource.data.id>created.data.id);
    const next=await call(restored.baseURL,restoredOwner,'/api/projects/1/candidates',{subject:'项目',predicate:'截止日',value:'16号',expected_version:2,source_id:nextSource.data.id});assert.equal(next.status,200);assert.ok(next.data.id>proposal.data.id);
    assert.equal((await call(restored.baseURL,restoredOwner,`/api/projects/1/candidates/${next.data.id}/approve`,{})).status,200);
    assert.equal((await readContext({baseURL:restored.baseURL,query:'项目'})).facts[0].version,3);
    const old=await call(restored.baseURL,restoredOwner,'/api/projects/1/facts/1/provenance?version=2');assert.equal(old.status,200);assert.equal(old.data.source.id,created.data.id);assert.equal(old.data.revision.value,'15号');
    assert.deepEqual(await snapshot(source),before,'source database remains unchanged by recovery');
    t.diagnostic(`Synthetic custom archive: ${dump.bytes.length} bytes; sha256=${crypto.createHash('sha256').update(dump.bytes).digest('hex')}; corrupt archive rejected; restored data and continuation verified`);
  }finally{
    for(const app of services)await app.close();for(const c of clients)await c.end();for(const name of names)await admin.query(`DROP DATABASE ${name}`);await admin.end();
    t.diagnostic('Both random recovery databases and child services cleaned up');
  }
});
