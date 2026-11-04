const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
test('application survives a terminated idle database connection and reuses its session',async()=>{
  const appURL=new URL(process.env.DATABASE_URL),adminURL=process.env.MIGRATION_TEST_DATABASE_URL;
  assert.ok(adminURL,'Use the isolated system evidence runner');
  const applicationName='memz_connection_recovery_'+randomUUID();appURL.searchParams.set('application_name',applicationName);
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,DATABASE_URL:appURL.href,PORT:'0'},stdio:['ignore','pipe','pipe']});
  let exitCode=null,exited=false,stderr='';child.stderr.on('data',data=>{stderr=(stderr+data).slice(0,65536)});
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exitCode=code;exited=true;resolve({code,signal})}));
  const admin=new Client({connectionString:adminURL});let connected=false;
  try{
    const baseURL=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Recovery test app did not start')),10000);let output='';
      child.once('error',()=>{clearTimeout(timer);reject(new Error('Recovery test app failed to start'))});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Recovery test app exited before startup'))});
      child.stdout.on('data',data=>{output+=data;const match=output.match(/Memz (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1])}});
    });
    const login=await fetch(baseURL+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'viewer',password:'demo-viewer'})});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];await login.json();
    const get=path=>fetch(baseURL+path,{headers:{cookie},signal:AbortSignal.timeout(2000)});
    const before=await get('/api/projects');assert.equal(before.status,200);const projects=await before.json();assert.ok(projects.some(p=>p.id===1&&p.role==='viewer'));
    await admin.connect();connected=true;
    // Target only this child connection, never another process or the existing demo database.
    const terminated=await admin.query("SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND usename='memz_app'",[applicationName]);
    assert.equal(terminated.rowCount,1);assert.equal(terminated.rows[0].stopped,true);
    const deadline=Date.now()+3000;
    while(!exited&&!stderr.includes('Database idle connection lost;')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(exited,false,`application exited after idle database disconnect (code ${exitCode})`);
    assert.equal(stderr.trim(),'Database idle connection lost; future requests will reconnect.','diagnostic contains no connection/client details');
    const after=await get('/api/projects');assert.equal(after.status,200);assert.deepEqual(await after.json(),projects,'same login works after a new pool connection');
    const facts=await get('/api/projects/1/facts?limit=1');assert.equal(facts.status,200);const page=await facts.json();assert.equal(page.facts[0].id,1);
    const proof=await get(`/api/projects/1/facts/1/provenance?version=${page.facts[0].version}`);assert.equal(proof.status,200);assert.equal((await proof.json()).revision.value,page.facts[0].value);
    const foreign=await get('/api/projects/2/facts');assert.equal(foreign.status,403);await foreign.json();
    assert.ok(!stderr.includes('postgres://'),'connection diagnostics must not print connection URLs');
  }finally{if(connected)await admin.end();if(!exited)child.kill('SIGTERM');await exit}
});
