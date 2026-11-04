const {test,after}=require('node:test');const assert=require('node:assert/strict');const {app,pool,tx,decide,readProject}=require('../server');
const server=app.listen(0,'127.0.0.1');after(async()=>{server.close();await pool.end()});
async function login(name){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:name,password:`demo-${name}`})});return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:(await r.json()).csrf}}
async function call(auth,path,body,headers={}){const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body?'POST':'GET',headers:{cookie:auth.cookie,'content-type':'application/json','x-csrf-token':auth.csrf,...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}}
async function candidate(auth,overrides={}){return call(auth,'/api/projects/1/candidates',{subject:'项目',predicate:'截止日',value:'15号',source_id:2,expected_version:1,...overrides})}
const choose=(id)=>tx(1,c=>decide(c,1,1,id,'approve'));
test('真实 PostgreSQL：权限、事务、并发、输入和检索',async()=>{const owner=await login('owner'),member=await login('member'),viewer=await login('viewer'),other=await login('other');
const attr=(await pool.query("SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0];assert.deepEqual(attr,{rolsuper:false,rolbypassrls:false,rolcreaterole:false});assert.equal((await pool.query('SELECT * FROM facts')).rowCount,0,'无上下文默认拒绝');
assert.equal((await tx(1,c=>c.query('SELECT * FROM facts'))).rowCount,1);assert.equal((await tx(4,c=>c.query('SELECT * FROM facts'))).rowCount,0);assert.equal((await pool.query('SELECT * FROM facts')).rowCount,0,'连接复用不残留身份');
// The database must reject pointers to another fact or another version,
// even when a caller has the owner's project permissions.
for(const sql of [
  "INSERT INTO facts(project_id,subject,predicate,version,current_revision_id) VALUES(1,'错误指针','测试',1,1)",
  'UPDATE facts SET version=2 WHERE id=1'
]) await assert.rejects(()=>tx(1,c=>c.query(sql)),e=>e.code==='23503');
for(const sql of [
  'UPDATE facts SET current_revision_id=NULL WHERE id=1',
  'UPDATE facts SET version=0 WHERE id=1'
]) await assert.rejects(()=>tx(1,c=>c.query(sql)),e=>e.code==='23514');
assert.equal((await call(other,'/api/projects/1/data')).status,403);assert.equal((await call(other,'/api/projects/1/data',null,{'X-User':'1'})).status,403);assert.equal((await candidate(viewer)).status,403);assert.equal((await candidate(member,{source_id:4})).status,400);assert.equal((await call(other,'/api/projects/1/candidates/1/approve',{})).status,403);
await assert.rejects(()=>tx(2,c=>c.query("INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by) VALUES(1,'跨项目','来源','x',4,0,2)")), e=>e.code==='23503');const rejected=(await candidate(member,{subject:'拒绝',predicate:'记录',expected_version:0})).data;await tx(1,c=>decide(c,1,1,rejected.id,'reject'));assert.equal((await call(owner,'/api/projects/1/data?q=%E6%8B%92%E7%BB%9D')).data.facts.length,0);
const beforeInvalid=await readProject(1,1,'');
for(const badText of ['前\ud800后','前\udc00后']){
  for(const field of ['title','content']){
    const response=await call(member,'/api/projects/1/sources',{title:'合成编码',content:'原文',[field]:badText});
    assert.equal(response.status,400,JSON.stringify({field,sent:badText,returned:response.data[field]}));
  }
  for(const field of ['subject','predicate','value'])assert.equal((await candidate(member,{[field]:badText})).status,400,`unpaired surrogate ${field}`);
}

for(const field of ['title','content'])assert.equal((await call(member,'/api/projects/1/sources',{title:'合成输入',content:'合成原文',[field]:'前\u0000后'})).status,400,`NUL source ${field}`);
for(const field of ['subject','predicate','value'])assert.equal((await candidate(member,{[field]:'前\u0000后'})).status,400,`NUL candidate ${field}`);
for(const path of ['facts','sources','data'])for(const q of ['%00','x'.repeat(201)+'%00'])assert.equal((await call(viewer,`/api/projects/1/${path}?q=${q}`)).status,400,`NUL query ${path}`);

for(const value of [null,true,false,[],[1],{},'', ' ', '1e0', '0x1',1.5,-1,2147483648]) {
  assert.equal((await candidate(member,{expected_version:value})).status,400,`invalid version ${JSON.stringify(value)}`);
  assert.equal((await candidate(member,{source_id:value})).status,400,`invalid source ${JSON.stringify(value)}`);
}
for(const id of ['1e0','0x1','2147483648'])assert.equal((await call(owner,`/api/projects/${id}/data`)).status,400);
assert.deepEqual(await readProject(1,1,''),beforeInvalid,'无效输入不得创建候选或审计');
const guard=(await candidate(member,{subject:'权限检查',predicate:'状态',expected_version:0})).data;const before=await readProject(1,1,'');for(const actor of [member,viewer])for(const decision of ['approve','reject'])assert.equal((await call(actor,`/api/projects/1/candidates/${guard.id}/${decision}`,{})).status,403);assert.deepEqual(await readProject(1,1,''),before,'非负责人操作不得更改事实、候选、修订或审计');for(const table of ['revisions','audit'])for(const verb of ['UPDATE','DELETE']){const sql=verb==='UPDATE'?`UPDATE ${table} SET project_id=project_id`:`DELETE FROM ${table}`;await assert.rejects(()=>tx(1,c=>c.query(sql)),e=>e.code==='42501',`${verb} ${table} 必须拒绝`)}
const snap=(await candidate(member,{subject:'快照',predicate:'测试',expected_version:0,value:'已提交'})).data;let writerFinished=false;const originalConnect=pool.connect.bind(pool);pool.connect=async()=>{pool.connect=originalConnect;const client=await originalConnect();const query=client.query.bind(client);client.query=async(...args)=>{const result=await query(...args);if(typeof args[0]==='string'&&args[0].startsWith('SELECT f.id,f.subject')){client.query=query;await choose(snap.id);writerFinished=true}return result};return client};let oldView;try{const response=await call(owner,'/api/projects/1/data');assert.equal(response.status,200);oldView=response.data}finally{pool.connect=originalConnect}assert.ok(writerFinished);assert.equal(oldView.facts.some(f=>f.subject==='快照'),false);assert.equal(oldView.candidates.find(c=>c.id===snap.id).status,'pending');assert.equal(oldView.history.some(h=>h.subject==='快照'),false);assert.equal(oldView.audit.some(a=>a.action==='approve'&&a.detail.startsWith(`候选 ${snap.id} →`)),false);const newView=await readProject(1,1,'');assert.equal(newView.facts.find(f=>f.subject==='快照').value,'已提交');assert.equal(newView.candidates.find(c=>c.id===snap.id).status,'approved');assert.ok(newView.history.some(h=>h.subject==='快照'));assert.ok(newView.audit.some(a=>a.action==='approve'&&a.detail.startsWith(`候选 ${snap.id} →`)));
const a=(await candidate(member)).data,b=(await candidate(member,{value:'16号'})).data;const outcomes=await Promise.allSettled([choose(a.id),choose(b.id)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.status===409).length,1);const approved=outcomes[0].status==='fulfilled'?a:b;await assert.rejects(()=>choose(approved.id),e=>e.status===409);let v=(await tx(1,c=>c.query('SELECT version FROM facts WHERE id=1'))).rows[0].version;assert.equal(v,2);
const rollback=(await candidate(member,{expected_version:2,value:'不应出现'})).data;await assert.rejects(()=>tx(1,c=>decide(c,1,1,rollback.id,'approve',true)),/injected/);let state=await tx(1,async c=>({f:(await c.query('SELECT version FROM facts WHERE id=1')).rows[0],c:(await c.query('SELECT status FROM candidates WHERE id=$1',[rollback.id])).rows[0],r:(await c.query('SELECT id FROM revisions WHERE candidate_id=$1',[rollback.id])).rowCount,a:(await c.query("SELECT id FROM audit WHERE action='approve' AND detail LIKE $1",[`候选 ${rollback.id} →%`])).rowCount}));assert.equal(state.f.version,2);assert.equal(state.c.status,'pending');assert.equal(state.r,0);assert.equal(state.a,0);
const one=(await candidate(member,{subject:'首次',predicate:'键',expected_version:0})).data,two=(await candidate(member,{subject:'首次',predicate:'键',expected_version:0})).data;const first=await Promise.allSettled([choose(one.id),choose(two.id)]);assert.equal(first.filter(x=>x.status==='fulfilled').length,1);assert.equal(first.filter(x=>x.status==='rejected'&&x.reason.status===409).length,1);
const bad=(await candidate(member,{subject:'文本',predicate:'安全',value:`<script>alert('x')</script> 100%_`,expected_version:0})).data;await choose(bad.id);for(const query of ['文本',"'",'%', '_','<script>']){const r=await call(owner,`/api/projects/1/data?q=${encodeURIComponent(query)}`);assert.equal(r.status,200);assert.ok(r.data.facts.some(f=>f.value.includes('<script>')))}assert.equal((await call(owner,'/api/projects/1/data?q=%E6%88%AA%E6%AD%A2%E6%97%A5')).data.facts.length,1);assert.equal((await call(owner,'/api/projects/1/data?q=不应出现')).data.facts.length,0);
const prototypeLogin=await fetch(`http://127.0.0.1:${server.address().port}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'__proto__'})});assert.equal(prototypeLogin.status,401);const forged=await fetch(`http://127.0.0.1:${server.address().port}/api/projects`,{headers:{'X-User':'1'}});assert.equal(forged.status,401);const noCsrf=await call(owner,'/api/projects/1/candidates',{subject:'x'}, {'x-csrf-token':''});assert.equal(noCsrf.status,403);
// Duplicate titles must not make provenance ambiguous, even after a later approval.
const sourceA=(await call(member,'/api/projects/1/sources',{title:'同名溯源（合成）',content:'原文甲'})).data;
const sourceB=(await call(member,'/api/projects/1/sources',{title:'同名溯源（合成）',content:'原文乙'})).data;
const proposalA=(await candidate(member,{subject:'精确溯源',source_id:sourceA.id,expected_version:0,value:'第一版'})).data;
assert.equal((await call(owner,`/api/projects/1/candidates/${proposalA.id}/approve`,{})).status,200);
const fact=(await call(owner,'/api/projects/1/facts?q=精确溯源')).data.facts[0];
const proofPath=`/api/projects/1/facts/${fact.id}/provenance`;
const proofA=await call(viewer,proofPath+'?version=1');assert.equal(proofA.status,200);
assert.deepEqual(proofA.data.source,{id:sourceA.id,title:'同名溯源（合成）',content:'原文甲'});
assert.equal(proofA.data.revision.value,'第一版');assert.equal(proofA.data.candidate.id,proposalA.id);
assert.equal(proofA.data.revision.approved_by,1);assert.equal(proofA.data.candidate.proposed_by,2);
const proposalB=(await candidate(member,{subject:'精确溯源',source_id:sourceB.id,expected_version:1,value:'第二版'})).data;
assert.equal((await call(owner,`/api/projects/1/candidates/${proposalB.id}/approve`,{})).status,200);
assert.deepEqual((await call(viewer,proofPath+'?version=1')).data,proofA.data,'pinned provenance survives a newer approval');
const currentProof=await call(owner,proofPath);assert.equal(currentProof.status,200);
assert.equal(currentProof.data.revision.version,2);assert.equal(currentProof.data.source.id,sourceB.id);assert.equal(currentProof.data.source.content,'原文乙');
assert.equal((await call(other,proofPath+'?version=1')).status,403);
assert.equal((await call(other,`/api/projects/2/facts/${fact.id}/provenance`)).status,404);
assert.equal((await call(owner,proofPath+'?version=99')).status,404);
for(const suffix of ['?version=0','?version=-1','?version=1&version=2','?version=1.5'])assert.equal((await call(owner,proofPath+suffix)).status,400);
assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${proofPath}`)).status,401);

// An actual HTTP client reads a pinned version while another actor advances it.
const {readContext}=require('../scripts/context-client');
const baseURL=`http://127.0.0.1:${server.address().port}`;
let advanced=false,clientCookie;
const concurrentFetch=async(url,options)=>{
  const response=await fetch(url,options);
  if(new URL(url).pathname==='/api/login')clientCookie=response.headers.get('set-cookie').split(';')[0];
  if(!advanced&&new URL(url).pathname==='/api/projects/1/facts'){
    const next=(await candidate(member,{subject:'精确溯源',source_id:sourceA.id,expected_version:2,value:'第三版'})).data;
    assert.equal((await call(owner,`/api/projects/1/candidates/${next.id}/approve`,{})).status,200);advanced=true;
  }
  return response;
};
const context=await readContext({baseURL,query:'精确溯源',fetchImpl:concurrentFetch});
assert.ok(advanced);assert.equal(context.facts.length,1);assert.equal(context.facts[0].version,2);
assert.equal(context.facts[0].value,'第二版');assert.equal(context.facts[0].source.id,sourceB.id);assert.equal(context.sourceTextIsUntrusted,true);
assert.equal((await call(owner,proofPath)).data.revision.version,3);
assert.equal((await fetch(baseURL+'/api/projects',{headers:{cookie:clientCookie}})).status,401,'client session is logged out');
assert.equal((await readContext({baseURL,query:'不存在的上下文'})).facts.length,0);
const bounded=await readContext({baseURL,limit:1});assert.equal(bounded.facts.length,1);assert.equal(bounded.truncated,true);assert.equal(bounded.nextAfter,bounded.facts[0].id);
await assert.rejects(()=>readContext({baseURL,username:'other',password:'demo-other'}),e=>e.status===403);
let failedCookie;
await assert.rejects(()=>readContext({baseURL,query:'精确溯源',fetchImpl:async(url,options)=>{
  if(new URL(url).pathname.endsWith('/provenance'))return new Response(JSON.stringify({error:'synthetic proof outage'}),{status:503});
  const response=await fetch(url,options);if(new URL(url).pathname==='/api/login')failedCookie=response.headers.get('set-cookie').split(';')[0];return response;
}}),e=>e.status===503);
assert.equal((await fetch(baseURL+'/api/projects',{headers:{cookie:failedCookie}})).status,401,'failed read also logs out');
await assert.rejects(()=>readContext({baseURL,query:'精确溯源',fetchImpl:async(url,options)=>{
  const response=await fetch(url,options);
  if(new URL(url).pathname.endsWith('/provenance')){const proof=await response.json();proof.revision.version=99;return new Response(JSON.stringify(proof),{status:200})}
  return response;
}}),e=>e.code==='PROVENANCE_MISMATCH');

await require('./context-scenarios')({baseURL,call,owner,member,viewer,other});
// Valid supplementary characters and line breaks must survive both storage and client provenance.
const unicodeBody={title:'合成编码😀来源',content:'中文与😀保留\n第二行文字'};
const unicodeSource=await call(member,'/api/projects/1/sources',unicodeBody,{'Idempotency-Key':'unicode-valid-source'});assert.equal(unicodeSource.status,200);
assert.equal(unicodeSource.data.title,unicodeBody.title);assert.equal(unicodeSource.data.content,unicodeBody.content);
assert.deepEqual(await call(member,'/api/projects/1/sources',unicodeBody,{'Idempotency-Key':'unicode-valid-source'}),unicodeSource);
const unicodeCandidate=await candidate(member,{subject:'编码往返😀',predicate:'测试😀',value:'中文😀\n第二行',source_id:unicodeSource.data.id,expected_version:0});assert.equal(unicodeCandidate.status,200);await choose(unicodeCandidate.data.id);
const unicodeContext=await readContext({baseURL,query:'编码往返😀'});assert.equal(unicodeContext.facts.length,1);assert.equal(unicodeContext.facts[0].value,'中文😀\n第二行');assert.equal(unicodeContext.facts[0].source.content,unicodeBody.content);
// Legacy API query truncation must never manufacture half an emoji.
const longSubject='界'.repeat(99),longPredicate='界'.repeat(98);
const boundaryCandidate=await candidate(member,{subject:longSubject,predicate:longPredicate,value:'😀尾',source_id:unicodeSource.data.id,expected_version:0});assert.equal(boundaryCandidate.status,200);await choose(boundaryCandidate.data.id);
const longQuery=longSubject+' '+longPredicate+' '+'😀尾';assert.equal(longQuery.indexOf('😀'),199);
for(const endpoint of ['facts','data']){const r=await call(viewer,`/api/projects/1/${endpoint}?q=${encodeURIComponent(longQuery)}`);assert.equal(r.status,200);assert.ok(r.data.facts.some(f=>f.subject===longSubject),'truncated query remains a valid prefix')}
const boundarySource=await call(member,'/api/projects/1/sources',{title:'界'.repeat(149),content:'合成边界来源'});assert.equal(boundarySource.status,200);
const sourceSearch=await call(viewer,`/api/projects/1/sources?q=${encodeURIComponent('界'.repeat(149)+'😀尾')}`);assert.equal(sourceSearch.status,200);assert.ok(sourceSearch.data.sources.some(s=>s.id===boundarySource.data.id));


await require('./context-budget')({baseURL,call,owner,member});

// Run the reviewer's full story through a real separate Node process.
const {stdout:storyOutput}=await require('node:util').promisify(require('node:child_process').execFile)(process.execPath,['scripts/demo-story.js'],{env:{...process.env,MEMZ_DEMO_BASE_URL:baseURL},timeout:30000});
const story=JSON.parse(storyOutput);assert.equal(story.synthetic,true);assert.equal(story.steps.length,7);assert.equal(story.context.facts[0].value,'15号');assert.equal(story.context.facts[0].version,2);assert.equal(story.provenanceV1.value,'20号');assert.ok(!storyOutput.includes('sid='));assert.ok(!storyOutput.includes('demo-owner'));
const narrative=require('../scripts/demo-story').markdown(story);assert.ok(narrative.includes('独立客户端实际得到的上下文'));assert.ok(narrative.includes(story.subject));
assert.equal(story.comparison.baseline,'synthetic-last-received-proposal');
assert.deepEqual(story.comparison.messages.map(m=>m.value),['20号','15号','25号','30号']);
assert.deepEqual(story.comparison.rows.map(r=>r.latestReceived.value),['20号','20号','15号','25号','30号']);
assert.deepEqual(story.comparison.rows.map(r=>r.current&&[r.current.value,r.current.version]),[null,['20号',1],['15号',2],['15号',2],['15号',2]]);
assert.equal(story.comparison.rows[1].current.sourceId,story.provenanceV1.source.id);
assert.equal(story.comparison.rows[4].current.sourceId,story.context.facts[0].source.id);
assert.ok(narrative.includes('不是外部聊天产品或模型实测'));
console.log('Synthetic reviewer rehearsal result:',JSON.stringify(story));
await require('./proposal-process')({baseURL,call,owner,member,viewer});
await require('./mcp-process')({baseURL,call,owner,member,viewer});
await require('./candidate-source')({call,owner,member,viewer,other});

});
