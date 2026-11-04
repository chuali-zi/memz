const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
const {app,pool,tx}=require('../server');
const {createOnce}=require('../idempotency');
const server=app.listen(0,'127.0.0.1');
after(async()=>{await new Promise(r=>server.close(r));await pool.end()});
async function login(name){
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:name,password:`demo-${name}`})});
  assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:(await r.json()).csrf};
}
async function post(auth,path,body,key){
  const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{cookie:auth.cookie,'x-csrf-token':auth.csrf,'content-type':'application/json',...(key===undefined?{}:{'idempotency-key':key})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
}
const sourceBody={title:'幂等来源',content:'合成重复请求'};
const candidateBody={subject:'幂等事实',predicate:'状态',value:'已审',source_id:2,expected_version:0};
const count=(table,where,params=[])=>tx(1,async c=>Number((await c.query(`SELECT count(*) FROM ${table} WHERE ${where}`,params)).rows[0].count));

test('concurrent HTTP retries create one source/candidate and one audit each',async()=>{
  const auth=await login('owner');
  for(const [operation,body,key,action] of [
    ['sources',sourceBody,'http-source','source'],['candidates',candidateBody,'http-candidate','propose']
  ]){
    const results=await Promise.all(Array.from({length:12},()=>post(auth,`/api/projects/1/${operation}`,body,key)));
    for(const r of results){assert.equal(r.status,200);assert.deepEqual(r.body,results[0].body)}
    if(operation==='candidates')assert.deepEqual((await post(auth,'/api/projects/1/candidates',{...body,source_id:'2',expected_version:'0'},key)).body,results[0].body);
    const id=results[0].body.id;
    assert.equal(await count(operation,'id=$1',[id]),1);
    assert.equal(await count('audit','action=$1 AND detail=$2',[action,operation==='sources'?`新增来源 ${id}`:`候选 ${id}`]),1);
    assert.equal(await count('idempotency_requests','operation=$1 AND request_key=$2',[operation,key]),1);
  }
});
test('conflicting content is rejected; normalized values, actor and operation scopes and absent keys remain compatible',async()=>{
  const owner=await login('owner'),member=await login('member'),other=await login('other');
  const original=await post(owner,'/api/projects/1/sources',sourceBody,'scope');
  assert.equal(original.status,200);
  assert.deepEqual((await post(owner,'/api/projects/1/sources',{...sourceBody,title:'  幂等来源  '},'scope')).body,original.body);
  assert.equal((await post(owner,'/api/projects/1/sources',{...sourceBody,content:'changed'},'scope')).status,409);
  const memberResult=await post(member,'/api/projects/1/sources',sourceBody,'scope');assert.equal(memberResult.status,200);assert.notEqual(memberResult.body.id,original.body.id);
  assert.equal((await post(other,'/api/projects/2/sources',sourceBody,'scope')).status,200);
  assert.equal((await post(owner,'/api/projects/1/candidates',{...candidateBody,subject:'独立操作'},'scope')).status,200);
  const a=await post(owner,'/api/projects/1/sources',sourceBody),b=await post(owner,'/api/projects/1/sources',sourceBody);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.notEqual(a.body.id,b.body.id);
});
test('authorization precedes replay; RLS isolates receipts and cached creation status is not current status',async()=>{
  const owner=await login('owner'),viewer=await login('viewer'),other=await login('other');
  for(const auth of [viewer,other])assert.equal((await post(auth,'/api/projects/1/candidates',candidateBody,'http-candidate')).status,403);
  assert.equal((await pool.query('SELECT * FROM idempotency_requests')).rowCount,0);
  assert.equal((await tx(2,c=>c.query("SELECT * FROM idempotency_requests WHERE request_key='http-candidate'"))).rowCount,0);
  await assert.rejects(()=>tx(2,c=>c.query("INSERT INTO idempotency_requests(project_id,actor_id,operation,request_key,request_hash,response) VALUES(1,1,'sources','forged',repeat('a',64),'{}')")),e=>e.code==='42501');
  for(const sql of ['UPDATE idempotency_requests SET response=response','DELETE FROM idempotency_requests'])await assert.rejects(()=>tx(1,c=>c.query(sql)),e=>e.code==='42501');
  const created=await post(owner,'/api/projects/1/candidates',candidateBody,'http-candidate');
  assert.equal((await post(owner,`/api/projects/1/candidates/${created.body.id}/approve`)).status,200);
  const replay=await post(owner,'/api/projects/1/candidates',candidateBody,'http-candidate');assert.deepEqual(replay,created);assert.equal(replay.body.status,'pending');
  assert.equal((await tx(1,c=>c.query('SELECT status FROM candidates WHERE id=$1',[created.body.id]))).rows[0].status,'approved');
});
test('same-key transaction actually waits for PostgreSQL lock then replays the winner',async()=>{
  let enter,enterFailure,release,pidReady,pidFailure;
  const entered=new Promise((r,j)=>{enter=r;enterFailure=j}),gate=new Promise(r=>release=r),pidPromise=new Promise((r,j)=>{pidReady=r;pidFailure=j});
  const options={project:1,user:1,operation:'sources',key:'lock-proof',payload:['locked','value']};
  let secondCreates=0;
  const first=tx(1,c=>createOnce(c,options,async()=>{
    const row=(await c.query("INSERT INTO sources(project_id,title,content) VALUES(1,'锁证明','value') RETURNING *")).rows[0];enter();await gate;return row;
  }));
  first.catch(enterFailure);await entered;
  const second=tx(1,async c=>{pidReady((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);return createOnce(c,options,async()=>{secondCreates++;return {unexpected:true}})});
  second.catch(pidFailure);
  try{
    const pid=await pidPromise,deadline=Date.now()+5000;let waiting=false;
    do{waiting=(await pool.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",[pid])).rowCount>0;if(!waiting)await delay(10)}while(!waiting&&Date.now()<deadline);
    assert.ok(waiting,'second transaction must be observed waiting on an advisory lock');
  }finally{release()}
  const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);assert.equal(secondCreates,0);
  assert.equal(await count('sources',"title='锁证明'"),1);
});
test('rollback leaves no receipt, source or audit; invalid requests do not consume a key',async()=>{
  const options={project:1,user:1,operation:'sources',key:'rollback-proof',payload:['rollback']};
  await assert.rejects(()=>tx(1,c=>createOnce(c,options,async()=>{
    await c.query("INSERT INTO sources(project_id,title,content) VALUES(1,'回滚证明','value')");
    await c.query("INSERT INTO audit(project_id,actor_id,action,detail) VALUES(1,1,'source','回滚证明')");throw new Error('injected after business writes');
  })),/injected/);
  assert.equal(await count('sources',"title='回滚证明'"),0);assert.equal(await count('audit',"detail='回滚证明'"),0);assert.equal(await count('idempotency_requests',"request_key='rollback-proof'"),0);
  const response=await tx(1,c=>createOnce(c,options,async()=>(await c.query("INSERT INTO sources(project_id,title,content) VALUES(1,'回滚证明','retry') RETURNING *")).rows[0]));
  assert.equal(response.content,'retry');assert.equal(await count('idempotency_requests',"request_key='rollback-proof'"),1);
  const auth=await login('owner');
  for(const key of ['', 'bad key', 'x'.repeat(129)])assert.equal((await post(auth,'/api/projects/1/sources',sourceBody,key)).status,400);
  assert.equal((await post(auth,'/api/projects/1/candidates',{...candidateBody,source_id:4},'corrected')).status,400);
  assert.equal(await count('idempotency_requests',"request_key='corrected'"),0);
  assert.equal((await post(auth,'/api/projects/1/candidates',candidateBody,'corrected')).status,200);
});
