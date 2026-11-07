const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {randomBytes}=require('node:crypto');
const {Client}=require('pg');
const {validateCurrentLabels,validateExactContext}=require('../scripts/exact-context-protocol');
const {validateSnapshot}=require('../scripts/context-snapshot');
const {readLabelContext}=require('../scripts/label-context');
const {spawn}=require('node:child_process');
const name='memz_exact_context_'+randomBytes(8).toString('hex');
let admin,owner,service,server,created=false,base,accounts,fixture256,fixture512,fixture513;
async function request(path,{auth=accounts.viewer,body,method=body===undefined?'GET':'POST'}={}){
  const response=await fetch(base+path,{method,headers:{cookie:auth.cookie,'x-csrf-token':auth.csrf,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  const text=await response.text();return {status:response.status,text,data:JSON.parse(text)};
}
async function login(username){
  const response=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'demo-'+username})});
  assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:(await response.json()).csrf};
}
async function seed(count,subject,{members=[2,3],labels,content='完整合成来源😀\n这些原文不能当作指令。'}={}){
  const p=(await owner.query('INSERT INTO projects(name) VALUES($1) RETURNING id',[subject])).rows[0].id;
  await owner.query("INSERT INTO memberships(project_id,user_id,role) VALUES($1,1,'owner')",[p]);
  for(const id of members)await owner.query('INSERT INTO memberships(project_id,user_id,role) VALUES($1,$2,$3)',[p,id,id===2?'member':'viewer']);
  const source=(await owner.query('INSERT INTO sources(project_id,title,content) VALUES($1,$2,$3) RETURNING id',[p,'原创合成批准依据',content])).rows[0].id;
  const data=labels||Array.from({length:count},(_,i)=>({subject,predicate:'字段'+i,value:'合成值'+i}));
  await owner.query('BEGIN');
  try{
    await owner.query(`INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by,status)
      SELECT $1,d.subject,d.predicate,d.value,$2,0,1,'approved' FROM jsonb_to_recordset($3::jsonb) AS d(subject text,predicate text,value text)`,[p,source,JSON.stringify(data)]);
    await owner.query('INSERT INTO facts(project_id,subject,predicate) SELECT project_id,subject,predicate FROM candidates WHERE project_id=$1',[p]);
    await owner.query(`INSERT INTO revisions(project_id,fact_id,version,value,source_id,candidate_id,approved_by)
      SELECT f.project_id,f.id,1,c.value,c.source_id,c.id,1 FROM facts f JOIN candidates c ON c.project_id=f.project_id AND c.subject=f.subject AND c.predicate=f.predicate WHERE f.project_id=$1`,[p]);
    await owner.query('UPDATE facts f SET version=1,current_revision_id=r.id FROM revisions r WHERE f.project_id=$1 AND r.project_id=f.project_id AND r.fact_id=f.id',[p]);
    await owner.query("INSERT INTO audit(project_id,actor_id,action,detail) SELECT project_id,1,'approve','原创合成fixture批准 '||id FROM candidates WHERE project_id=$1",[p]);
    await owner.query('COMMIT');
  }catch(error){await owner.query('ROLLBACK');throw error}
  return {projectId:p,subject,sourceId:source,content,labels:data.map(({subject,predicate})=>({subject,predicate}))};
}
before(async()=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use a dedicated isolated test administrator connection');
  admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});await admin.connect();await admin.query(`CREATE DATABASE ${name}`);created=true;
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;owner=new Client({connectionString:url.href});await owner.connect();
  await owner.query(fs.readFileSync(require('node:path').join(__dirname,'../db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
  url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;
  service=require('../server');server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  accounts={};for(const username of ['owner','member','viewer','other'])accounts[username]=await login(username);
  fixture256=await seed(256,'昼桥目录');fixture512=await seed(512,'晚杉目录');fixture513=await seed(513,'星池目录');
});
after(async()=>{
  try{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}if(service)await service.pool.end()}
  finally{if(owner)await owner.end();if(created){await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);console.log('Synthetic exact HTTP database cleanup: passed')}if(admin)await admin.end()}
});
function intercept(handler){
  const connect=service.pool.connect;
  service.pool.connect=async function(...args){
    if(args.length)return connect.apply(this,args);
    const client=await connect.call(this),query=client.query,release=client.release;
    client.query=async function(...parameters){return handler({client,sql:parameters[0],parameters,query:(...input)=>query.apply(client,input),run:()=>query.apply(client,parameters)})};
    client.release=function(...parameters){client.query=query;client.release=release;return release.apply(client,parameters)};
    return client;
  };
  return ()=>{service.pool.connect=connect};
}
const exact=(fixture,selector,options={})=>request(`/api/projects/${fixture.projectId}/context/exact`,{...options,body:{selector}});
test('real label metadata supports complete 256/512 scopes and a 513-row overflow without a prefix',async()=>{
  for(const fixture of [fixture256,fixture512]){
    const response=await request(`/api/projects/${fixture.projectId}/current-labels`);assert.equal(response.status,200);
    validateCurrentLabels(response.data,{projectId:fixture.projectId});assert.equal(response.data.complete,true);assert.deepEqual(response.data.labels,fixture.labels);
    assert.ok(Buffer.byteLength(response.text)<=1048576);assert.equal(Object.hasOwn(response.data,'value'),false);assert.equal(Object.hasOwn(response.data,'sources'),false);
    const selected=fixture.labels.at(-1),proof=await exact(fixture,selected);assert.equal(proof.status,200);validateExactContext(proof.data,{projectId:fixture.projectId,selector:selected});
    assert.equal(proof.data.facts.length,1);assert.equal(proof.data.facts[0].predicate,selected.predicate);assert.equal(proof.data.sources[0].content,fixture.content);
  }
  const overflow=await request(`/api/projects/${fixture513.projectId}/current-labels`);assert.equal(overflow.status,200);
  validateCurrentLabels(overflow.data,{projectId:fixture513.projectId});assert.equal(overflow.data.complete,false);assert.deepEqual(overflow.data.labels,[]);assert.ok(!overflow.text.includes(fixture513.subject));
});
test('metadata SQL reads keys only under real RR and ignores pending, rejected, zero-version, source and value text',async()=>{
  const p=fixture256.projectId;
  await owner.query("INSERT INTO facts(project_id,subject,predicate) VALUES($1,'零版本占位','未批准')",[p]);
  const candidate=await request(`/api/projects/${p}/candidates`,{auth:accounts.owner,body:{subject:'待审标签',predicate:'未批准',value:'合成值',source_id:fixture256.sourceId,expected_version:0}});assert.equal(candidate.status,200);
  const rejected=await request(`/api/projects/${p}/candidates`,{auth:accounts.owner,body:{subject:'驳回标签',predicate:'未批准',value:'合成值',source_id:fixture256.sourceId,expected_version:0}});assert.equal(rejected.status,200);
  assert.equal((await request(`/api/projects/${p}/candidates/${rejected.data.id}/reject`,{auth:accounts.owner,body:{}})).status,200);
  const revision=(await owner.query('SELECT r.id,r.value FROM revisions r WHERE project_id=$1 ORDER BY id LIMIT 1',[p])).rows[0];
  await owner.query("UPDATE sources SET content=repeat('PRIVATE_SOURCE_SENTINEL',1000) WHERE id=$1",[fixture256.sourceId]);
  await owner.query("UPDATE revisions SET value=repeat('PRIVATE_VALUE_SENTINEL',10000) WHERE id=$1",[revision.id]);
  const sql=[];const restore=intercept(async query=>{sql.push(query.sql);return query.run()});
  try{
    const response=await request(`/api/projects/${p}/current-labels`);assert.equal(response.status,200);assert.equal(response.data.labels.length,256);assert.equal(response.data.complete,true);
    assert.ok(!response.text.includes('PRIVATE_'));assert.ok(!response.text.includes('待审标签'));assert.ok(!response.text.includes('驳回标签'));assert.ok(!response.text.includes('零版本占位'));
    assert.ok(sql.some(text=>text==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    assert.equal(sql.filter(text=>text.includes('FROM facts')).length,1);
    for(const text of sql)assert.doesNotMatch(text,/\b(value|sources|revisions|candidates|content|current_revision_id)\b/i);
  }finally{
    restore();await owner.query('UPDATE sources SET content=$1 WHERE id=$2',[fixture256.content,fixture256.sourceId]);await owner.query('UPDATE revisions SET value=$1 WHERE id=$2',[revision.value,revision.id]);
  }
});
test('real app roles retain RLS and exact project isolation, including zero-match authorized selectors',async()=>{
  const selector=fixture256.labels[0],p=fixture256.projectId;
  for(const auth of [accounts.owner,accounts.member,accounts.viewer]){
    assert.equal((await request(`/api/projects/${p}/current-labels`,{auth})).status,200);
    assert.equal((await exact(fixture256,selector,{auth})).status,200);
  }
  assert.equal((await request(`/api/projects/${p}/current-labels`,{auth:accounts.other})).status,403);
  assert.equal((await exact(fixture256,selector,{auth:accounts.other})).status,403);
  const another=await seed(1,'私有夜帆',{members:[4]});
  assert.equal((await request(`/api/projects/${another.projectId}/current-labels`)).status,403);
  const crossed=await exact(fixture256,another.labels[0]);assert.equal(crossed.status,200);validateExactContext(crossed.data,{projectId:p,selector:another.labels[0]});assert.deepEqual(crossed.data.facts,[]);assert.deepEqual(crossed.data.sources,[]);
  assert.equal((await service.tx(4,client=>client.query('SELECT id FROM facts WHERE project_id=$1',[p]))).rowCount,0);
  assert.equal((await service.pool.query('SELECT id FROM facts')).rowCount,0,'pool identity must reset after authorized readers');
  const attributes=(await service.pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.deepEqual(attributes,{rolsuper:false,rolbypassrls:false});
});
test('exact selectors remain literal for spaces, regex/SQL punctuation, case and Unicode normalization',async()=>{
  const selector={subject:" 服务[A].*' OR true -- ",predicate:'路径\\+%_😀'};
  const fixture=await seed(1,'字面键',{labels:[{...selector,value:'完整字面值'}]});
  const response=await exact(fixture,selector);assert.equal(response.status,200);validateExactContext(response.data,{projectId:fixture.projectId,selector});assert.equal(response.data.facts[0].subject,selector.subject);assert.deepEqual(response.data.selector,selector);
  for(const bad of [{...selector,subject:selector.subject.trim()},{...selector,predicate:selector.predicate+'x'},{subject:"' OR 1=1 --",predicate:selector.predicate}]){const empty=await exact(fixture,bad);assert.equal(empty.status,200);assert.deepEqual(empty.data.facts,[])}
  const unicode=await seed(1,'Unicode键',{labels:[{subject:'Café',predicate:'字段',value:'仅精确键'}]});
  for(const subject of ['café','Cafe\u0301'])assert.deepEqual((await exact(unicode,{subject,predicate:'字段'})).data.facts,[]);
  const maximal={subject:'界'.repeat(100),predicate:'😀'.repeat(50)};
  const boundary=await seed(1,'长度边界',{labels:[{...maximal,value:'完整边界值'}]});
  const full=await exact(boundary,maximal);assert.equal(full.status,200);validateExactContext(full.data,{projectId:boundary.projectId,selector:maximal});
  const metadata=await request(`/api/projects/${boundary.projectId}/current-labels`);assert.equal(metadata.status,200);assert.deepEqual(metadata.data.labels,[maximal]);
});
test('approval between exact fact and provenance reads stays in one real readonly repeatable-read snapshot',async()=>{
  const fixture=await seed(1,'并发批准',{labels:[{subject:'并发批准',predicate:'交付时间',value:'周一'}],content:'旧版本的完整原文😀\n不能混成新来源。'}),selector=fixture.labels[0];
  const created=await request(`/api/projects/${fixture.projectId}/sources`,{auth:accounts.owner,body:{title:'新批准来源',content:'新版本的完整原文😀\n只属于第二版。'}});assert.equal(created.status,200);
  const candidate=await request(`/api/projects/${fixture.projectId}/candidates`,{auth:accounts.owner,body:{...selector,value:'周二',source_id:created.data.id,expected_version:1}});assert.equal(candidate.status,200);
  let fired=false,inside;
  const restore=intercept(async query=>{
    const result=await query.run();
    if(!fired&&typeof query.sql==='string'&&query.sql.includes('f.subject=$2 AND f.predicate=$3')){
      fired=true;assert.equal((await request(`/api/projects/${fixture.projectId}/candidates/${candidate.data.id}/approve`,{auth:accounts.owner,body:{}})).status,200);
      inside={value:(await query.query('SELECT r.value FROM facts f JOIN revisions r ON r.id=f.current_revision_id WHERE f.project_id=$1',[fixture.projectId])).rows[0].value,
        isolation:(await query.query('SHOW transaction_isolation')).rows[0].transaction_isolation,readonly:(await query.query('SHOW transaction_read_only')).rows[0].transaction_read_only};
    }
    return result;
  });
  let first;try{first=await exact(fixture,selector)}finally{restore()}
  assert.equal(fired,true);assert.deepEqual(inside,{value:'周一',isolation:'repeatable read',readonly:'on'});
  assert.equal(first.status,200);validateExactContext(first.data,{projectId:fixture.projectId,selector});assert.equal(first.data.facts[0].version,1);assert.equal(first.data.sources[0].content,fixture.content);
  const second=await exact(fixture,selector);assert.equal(second.status,200);assert.equal(second.data.facts[0].version,2);assert.equal(second.data.facts[0].value,'周二');assert.equal(second.data.sources[0].content,'新版本的完整原文😀\n只属于第二版。');
});
test('actual dangling current pointers and corrupt approved proof data fail integrity instead of becoming empty results',async()=>{
  const fixture=await seed(1,'坏数据探针'),selector=fixture.labels[0],p=fixture.projectId;
  const record=(await owner.query('SELECT id,current_revision_id FROM facts WHERE project_id=$1',[p])).rows[0];
  await owner.query('ALTER TABLE facts DROP CONSTRAINT facts_current_revision_fk');
  try{
    await owner.query('UPDATE facts SET current_revision_id=2147483000 WHERE id=$1',[record.id]);
    const broken=await exact(fixture,selector);assert.equal(broken.status,500);assert.deepEqual(broken.data,{error:'请求无法处理'});
  }finally{
    await owner.query('UPDATE facts SET current_revision_id=$1 WHERE id=$2',[record.current_revision_id,record.id]);
    await owner.query('ALTER TABLE facts ADD CONSTRAINT facts_current_revision_fk FOREIGN KEY(project_id,id,version,current_revision_id) REFERENCES revisions(project_id,fact_id,version,id)');
  }
  const candidate=(await owner.query('SELECT candidate_id FROM revisions WHERE id=$1',[record.current_revision_id])).rows[0].candidate_id;
  for(const sql of ["UPDATE candidates SET status='pending' WHERE id=$1","UPDATE candidates SET status='rejected' WHERE id=$1",'UPDATE candidates SET expected_version=99 WHERE id=$1']){
    try{await owner.query(sql,[candidate]);assert.equal((await exact(fixture,selector)).status,500)}
    finally{await owner.query("UPDATE candidates SET status='approved',expected_version=0 WHERE id=$1",[candidate])}
  }
  for(const length of [4001,1048577]){
    try{
      await owner.query("UPDATE sources SET content=repeat('x',$2) WHERE id=$1",[fixture.sourceId,length]);
      const response=await exact(fixture,selector);assert.equal(response.status,500);assert.ok(Buffer.byteLength(response.text)<1048576);assert.deepEqual(response.data,{error:'请求无法处理'});
    }finally{await owner.query('UPDATE sources SET content=$1 WHERE id=$2',[fixture.content,fixture.sourceId])}
  }
});
test('invalid metadata labels are rejected whole and never truncated into a valid selector',async()=>{
  const fixture=await seed(1,'非法标签'),selector=fixture.labels[0];
  try{
    await owner.query('UPDATE facts SET subject=$1 WHERE project_id=$2',['x'.repeat(100000),fixture.projectId]);
    const response=await request(`/api/projects/${fixture.projectId}/current-labels`);assert.equal(response.status,500);assert.deepEqual(response.data,{error:'请求无法处理'});
  }finally{await owner.query('UPDATE facts SET subject=$1 WHERE project_id=$2',[selector.subject,fixture.projectId])}
});
test('legacy snapshot headers and payloads remain valid after sharing evidence assembly',async()=>{
  const response=await request(`/api/projects/${fixture256.projectId}/context?q=&limit=25`);assert.equal(response.status,200);
  validateSnapshot(response.data,{projectId:fixture256.projectId,query:'',limit:25,after:0,search:null});assert.equal(response.data.facts.length,25);assert.equal(response.data.next_after,response.data.facts.at(-1).id);assert.equal(Object.hasOwn(response.data,'selector'),false);
});
function recordedFetch(){
  const paths=[];
  return {paths,fetchImpl:async(url,options)=>{paths.push(new URL(url).pathname);return fetch(url,options)}};
}
function v2Options(fixture,question,extra={}){return {baseURL:base,projectId:fixture.projectId,question,protocol:'metadata_exact_v2',...extra}}
test('opt-in v2 client reads real complete 256/512 projects in four requests while default v1 still refuses the scope',async()=>{
  for(const fixture of [fixture256,fixture512]){
    const selector=fixture.labels.at(-1),question=selector.subject+'的'+selector.predicate+'是什么？',f=recordedFetch();
    const result=await readLabelContext(v2Options(fixture,question,{fetchImpl:f.fetchImpl}));
    assert.equal(result.status,'matched');assert.equal(result.schema,'memz-label-context-v2');assert.equal(result.execution.modelCalls,0);assert.deepEqual(result.context.selector,selector);
    validateExactContext(result.context,{projectId:fixture.projectId,selector});assert.equal(result.context.sources[0].content,fixture.content);assert.equal(result.context.provenance.length,1);assert.equal(f.paths.length,4);
    assert.deepEqual(f.paths,['/api/login',`/api/projects/${fixture.projectId}/current-labels`,`/api/projects/${fixture.projectId}/context/exact`,'/api/logout']);
  }
  const old=await readLabelContext({baseURL:base,projectId:fixture256.projectId,question:fixture256.subject+'的字段255是什么？'});
  assert.equal(old.schema,'memz-label-context-v1');assert.equal(old.status,'needs_scope');assert.equal(old.reason,'SCOPE_TOO_LARGE');
  const f=recordedFetch(),overflow=await readLabelContext(v2Options(fixture513,fixture513.subject+'的字段0是什么？',{fetchImpl:f.fetchImpl}));
  assert.equal(overflow.status,'needs_scope');assert.equal(overflow.reason,'SCOPE_TOO_LARGE');assert.equal(overflow.context,undefined);assert.equal(f.paths.length,3);
});
test('v2 client does not cross scopes or bypass project permission revoked between its two real reads',async()=>{
  const scoped=recordedFetch(),otherQuestion=fixture512.subject+'的字段0是什么？';
  const unknown=await readLabelContext(v2Options(fixture256,otherQuestion,{fetchImpl:scoped.fetchImpl}));assert.equal(unknown.status,'needs_scope');assert.equal(unknown.context,undefined);assert.equal(scoped.paths.length,3);
  await assert.rejects(()=>readLabelContext(v2Options(fixture256,fixture256.subject+'的字段0是什么？',{username:'other',password:'demo-other'})),{code:'HTTP_403'});
  const fixture=await seed(1,'中途撤权'),selector=fixture.labels[0],paths=[];let revoked=false;
  try{
    await assert.rejects(()=>readLabelContext(v2Options(fixture,selector.subject+'的字段0是什么？',{fetchImpl:async(url,options)=>{
      const path=new URL(url).pathname;paths.push(path);const response=await fetch(url,options);
      if(path.endsWith('/current-labels')&&!revoked){await response.clone().json();revoked=true;await owner.query('DELETE FROM memberships WHERE project_id=$1 AND user_id=3',[fixture.projectId])}
      return response;
    }})),error=>error.code==='HTTP_403'&&error.status===403&&error.message==='HTTP_403'&&error.context===undefined);
    assert.equal(revoked,true);assert.equal(paths.length,4);assert.equal(paths.at(-1),'/api/logout');
  }finally{await owner.query("INSERT INTO memberships(project_id,user_id,role) VALUES($1,3,'viewer') ON CONFLICT DO NOTHING",[fixture.projectId])}
});
test('v2 reads a newly approved version after metadata without pretending both real reads share a snapshot',async()=>{
  const fixture=await seed(1,'客户端新批准'),selector=fixture.labels[0],newSource=await request(`/api/projects/${fixture.projectId}/sources`,{auth:accounts.owner,body:{title:'第二次读取的新依据',content:'新版本完整原文😀\n只能引用此来源。'}});
  const candidate=await request(`/api/projects/${fixture.projectId}/candidates`,{auth:accounts.owner,body:{...selector,value:'新批准值',source_id:newSource.data.id,expected_version:1}});
  let changed=false;
  const result=await readLabelContext(v2Options(fixture,selector.subject+'的字段0是什么？',{fetchImpl:async(url,options)=>{
    const response=await fetch(url,options);
    if(new URL(url).pathname.endsWith('/current-labels')&&!changed){await response.clone().json();changed=true;assert.equal((await request(`/api/projects/${fixture.projectId}/candidates/${candidate.data.id}/approve`,{auth:accounts.owner,body:{}})).status,200)}
    return response;
  }}));
  assert.equal(changed,true);assert.equal(result.status,'matched');assert.equal(result.context.facts[0].version,2);assert.equal(result.context.facts[0].value,'新批准值');assert.equal(result.context.sources[0].content,'新版本完整原文😀\n只能引用此来源。');assert.match(result.consistency,/separate/);
});
test('v2 client rejects a tampered selector in a real PostgreSQL response and still logs out',async()=>{
  const selector=fixture256.labels[0],paths=[];
  await assert.rejects(()=>readLabelContext(v2Options(fixture256,selector.subject+'的字段0是什么？',{fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname;paths.push(path);const response=await fetch(url,options);
    if(path.endsWith('/context/exact')){const wire=await response.json();wire.selector.predicate='synthetic-private-mismatch';return Response.json(wire)}
    return response;
  }})),error=>error.code==='INVALID_EXACT_CONTEXT_RESPONSE'&&error.message==='INVALID_EXACT_CONTEXT_RESPONSE'&&!Object.hasOwn(error,'context'));
  assert.equal(paths.length,4);assert.equal(paths.at(-1),'/api/logout');
});
test('v2 deadline aborts an actual HTTP request blocked by a real PostgreSQL lock',async()=>{
  const fixture=await seed(1,'真实期限探针');let closed=false,entered=false,pid,lockObserved=false;
  const observe=(req,res)=>{if(req.url===`/api/projects/${fixture.projectId}/current-labels`){entered=true;res.once('close',()=>{closed=true})}};
  const restore=intercept(async query=>{
    if(typeof query.sql==='string'&&query.sql.includes('octet_length(subject)')&&query.parameters[1]?.[0]===fixture.projectId)pid=query.client.processID;
    return query.run();
  });
  server.on('request',observe);await owner.query('BEGIN');await owner.query('LOCK TABLE facts IN ACCESS EXCLUSIVE MODE');
  try{
    const rejection=assert.rejects(readLabelContext(v2Options(fixture,fixture.subject+'的字段0是什么？',{timeoutMs:5000,totalTimeoutMs:2000})),{code:'TOTAL_TIMEOUT'});
    const observationDeadline=Date.now()+1800;
    while(!lockObserved&&Date.now()<observationDeadline){
      await owner.query('SELECT pg_stat_clear_snapshot()');
      const observed=await owner.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()",[pid||0]);
      lockObserved=entered&&observed.rows[0]?.wait_event_type==='Lock';
      if(!lockObserved)await new Promise(resolve=>setTimeout(resolve,10));
    }
    await rejection;
    assert.equal(entered,true,'metadata must actually reach the server before its deadline');assert.equal(lockObserved,true,'the real backend must be observed waiting on this fixture lock');
    const until=Date.now()+2000;while(!closed&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(closed,true,'the client must close the HTTP transport instead of merely abandoning its promise');
  }finally{await owner.query('ROLLBACK');restore();server.removeListener('request',observe)}
  assert.equal((await service.tx(3,client=>client.query('SELECT 1 AS value'))).rows[0].value,1);
});
test('the explicit v2 stdin CLI reads a real 512-label project with full provenance and no implicit v1 fallback',async()=>{
  const selector=fixture512.labels.at(-1),question=selector.subject+'的'+selector.predicate+'是什么？';
  const child=spawn(process.execPath,['scripts/label-context.js','--stdin'],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,MEMZ_BASE_URL:base,MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',MEMZ_LABEL_PROTOCOL:'snapshot_filter_v1'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.stdin.on('error',()=>{});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);child.stdin.end(JSON.stringify({projectId:fixture512.projectId,question,protocol:'metadata_exact_v2'}));
  const code=await new Promise(resolve=>child.once('close',resolve));clearTimeout(timer);
  assert.equal(code,0);assert.equal(stderr,'');const result=JSON.parse(stdout);assert.equal(result.schema,'memz-label-context-v2');assert.equal(result.status,'matched');assert.equal(result.context.provenance.length,1);assert.equal(result.context.sources[0].content,fixture512.content);assert.equal(result.execution.modelCalls,0);assert.ok(!stdout.includes('sid='));assert.ok(!stdout.includes('demo-viewer'));
});
