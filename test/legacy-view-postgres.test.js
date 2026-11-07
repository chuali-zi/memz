const {test,before,beforeEach,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomBytes}=require('node:crypto'),{Client}=require('pg');
const {LEGACY_VIEW_MESSAGE}=require('../scripts/legacy-view-budget');
const name='memz_legacy_guard_'+randomBytes(8).toString('hex'),sections=['facts','history','candidates','sources','audit'];
const schema=fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8');
let admin,owner,service,server,base,created=false,dropped=false,cookies={},record,afterGuard,driverJSONBytes=0,businessWriteStatements=0;
const observations=[];
const flags=enabled=>'?'+sections.map(key=>'include_'+key+'='+enabled.includes(key)).join('&');
const only=key=>flags([key]);
async function counts(){return (await owner.query('SELECT (SELECT count(*) FROM sources)::int AS sources,(SELECT count(*) FROM facts)::int AS facts,(SELECT count(*) FROM candidates)::int AS candidates,(SELECT count(*) FROM revisions)::int AS revisions,(SELECT count(*) FROM audit)::int AS audit,(SELECT count(*) FROM idempotency_requests)::int AS receipts')).rows[0]}
async function read(query='',user='owner',project=1){
  record=[];const response=await fetch(base+'/api/projects/'+project+'/data'+query,{headers:{cookie:cookies[user]}}),text=await response.text(),queries=record;record=null;
  const result={status:response.status,body:JSON.parse(text),queries,bytes:Buffer.byteLength(text)};
  observations.push({status:result.status,responseBytes:result.bytes,queries:queries.map(({sql,...rest})=>rest)});return result;
}
function scalarOnly(result){assert.ok(result.queries.filter(q=>q.kind==='scalar').length>0);assert.equal(result.queries.filter(q=>q.kind==='body').length,0);for(const q of result.queries.filter(q=>q.kind==='scalar')){assert.deepEqual(q.columns,['rows','bytes','bad']);assert.equal(q.rows,1);assert.ok(q.bytes<128)}}
function declined(result){assert.equal(result.status,422);assert.deepEqual(result.body,{error:LEGACY_VIEW_MESSAGE})}
async function sources(n,content="'tiny'"){await owner.query(`INSERT INTO sources(project_id,title,content) SELECT 1,'原创来源'||n,${content} FROM generate_series(1,$1::int)n`,[n])}
async function facts(n,value="'small'"){
  await owner.query(`INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by,status) SELECT 1,'原创属性'||n,'状态',${value},1,0,1,'approved' FROM generate_series(1,$1::int)n`,[n]);
  await owner.query("INSERT INTO facts(project_id,subject,predicate,version) SELECT 1,'原创属性'||n,'状态',0 FROM generate_series(1,$1::int)n",[n]);
  await owner.query("INSERT INTO revisions(project_id,fact_id,version,value,source_id,candidate_id,approved_by) SELECT 1,f.id,1,c.value,1,c.id,1 FROM candidates c JOIN facts f ON f.project_id=c.project_id AND f.subject=c.subject AND f.predicate=c.predicate WHERE c.subject LIKE '原创属性%'");
  await owner.query("UPDATE facts f SET version=1,current_revision_id=r.id FROM revisions r WHERE r.fact_id=f.id AND f.subject LIKE '原创属性%'");
}
before(async()=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use a dedicated test administrator connection');
  admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});await admin.connect();await admin.query(`CREATE DATABASE ${name}`);created=true;
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;owner=new Client({connectionString:url.href});await owner.connect();await owner.query(schema.replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
  url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;service=require('../server');
  service.pool.on('connect',client=>{const query=client.query;client.query=async function(sql,...args){
    if(typeof sql==='string'&&/^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(sql))businessWriteStatements++;
    const result=await query.call(this,sql,...args);
    if(typeof sql==='string'&&/^SELECT /i.test(sql)){
      const kind=sql.startsWith('SELECT count(*)::int AS rows')?'scalar':sql.startsWith('SELECT role FROM memberships')?'role':sql.includes('set_config(')?'identity':'body';
      const bytes=Buffer.byteLength(JSON.stringify(result.rows));driverJSONBytes+=bytes;assert.ok(driverJSONBytes<=16*1024*1024,'cumulative actual driver rows must stay below the 16MiB fixture budget');
      if(record)record.push({kind,rows:result.rowCount,bytes,columns:result.fields.map(f=>f.name),...(kind==='scalar'?{summary:result.rows[0]}:{}),sql,params:args[0]});
      if(kind==='scalar'&&afterGuard){const hook=afterGuard;afterGuard=null;await hook()}
    }
    return result;
  }});
  server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
  for(const user of ['owner','other']){const response=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:user,password:'demo-'+user})});assert.equal(response.status,200);cookies[user]=response.headers.get('set-cookie').split(';')[0];await response.json()}
});
beforeEach(async()=>{await owner.query('TRUNCATE projects,memberships,sources,facts,candidates,revisions,audit,idempotency_requests RESTART IDENTITY CASCADE');await owner.query(schema.slice(schema.indexOf('INSERT INTO projects(name)')))});
after(async()=>{
  try{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}if(service)await service.pool.end()}
  finally{if(owner)await owner.end();if(created){await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);dropped=true;console.log('Synthetic legacy guard database cleanup: passed')}if(admin)await admin.end();
    console.log('Synthetic legacy guard driver JSON bytes:',driverJSONBytes);assert.ok(driverJSONBytes<=16*1024*1024);assert.equal(businessWriteStatements,0);
    fs.mkdirSync(path.join(__dirname,'../artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../artifacts/engine-legacy-view-resources.json'),JSON.stringify({synthetic:true,modelCalls:0,driverJSONBytes,driverBudgetBytes:16*1024*1024,businessWriteStatements,temporaryDatabaseDropped:dropped,observations},null,2)+'\n');}
});
test('normal HTTP and every include combination preserve internal default values and omission shape',async()=>{
  const before=await counts(),internal=JSON.parse(JSON.stringify(await service.readProject(1,1,''))),response=await read();assert.equal(response.status,200);assert.deepEqual(response.body,internal);
  for(const section of sections){const r=await read(only(section));assert.equal(r.status,200);assert.deepEqual(r.body,{sourceTextIsUntrusted:true,role:internal.role,[section]:internal[section]});assert.equal(r.queries.filter(q=>q.kind==='scalar').length,1);assert.equal(r.queries.filter(q=>q.kind==='body').length,1)}
  const empty=await read(flags([]));assert.equal(empty.status,200);assert.deepEqual(empty.body,{sourceTextIsUntrusted:true,role:'owner'});assert.deepEqual(empty.queries.map(q=>q.kind),['identity','role']);assert.deepEqual(await counts(),before);
});
test('source 512/513 boundary rejects whole HTTP scope but internal full-source baseline remains complete',async()=>{
  await sources(509);const accepted=await read(only('sources'));assert.equal(accepted.status,200);assert.equal(accepted.body.sources.length,512);
  await sources(1);const before=await counts(),rejected=await read(only('sources')+'&httpBounds=false');declined(rejected);scalarOnly(rejected);assert.equal(rejected.queries.find(q=>q.kind==='scalar').summary.rows,513);assert.deepEqual(await counts(),before);
  const internal=await service.readProject(1,1,'',{includeFacts:false,includeHistory:false,includeCandidates:false,includeAudit:false});assert.equal(internal.sources.length,513);
  const omitted=await read(flags(['facts','history','candidates','audit']));assert.equal(omitted.status,200);assert.equal(Object.hasOwn(omitted.body,'sources'),false);
  declined(await read('?q=unknown'));assert.equal((await read(flags([]))).status,200);
});
test('facts, history and candidates each enforce their actual 512/513 result boundary; facts-only q remains compatible',async()=>{
  await facts(511);for(const section of ['facts','history','candidates']){const r=await read(only(section));assert.equal(r.status,200);assert.equal(r.body[section].length,512)}
  await owner.query("INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by,status) VALUES(1,'额外','状态','small',1,0,1,'approved')");
  await owner.query("INSERT INTO facts(project_id,subject,predicate,version) VALUES(1,'额外','状态',0)");
  await owner.query("INSERT INTO revisions(project_id,fact_id,version,value,source_id,candidate_id,approved_by) SELECT 1,f.id,1,c.value,1,c.id,1 FROM facts f JOIN candidates c ON c.subject=f.subject AND c.predicate=f.predicate AND c.project_id=f.project_id WHERE f.subject='额外'");
  await owner.query("UPDATE facts f SET version=1,current_revision_id=r.id FROM revisions r WHERE r.fact_id=f.id AND f.subject='额外'");
  for(const section of ['facts','history','candidates']){const r=await read(only(section));declined(r);scalarOnly(r)}
  const filtered=await read(only('facts')+'&q='+encodeURIComponent('截止日'));assert.equal(filtered.status,200);assert.equal(filtered.body.facts.length,1);
});
test('authorization precedes all size probes and other project data never contributes to this scope',async()=>{
  await sources(510);const forbidden=await read('','other');assert.equal(forbidden.status,403);assert.equal(forbidden.queries.some(q=>q.kind==='scalar'||q.kind==='body'),false);
  const own=await read('','other',2);assert.equal(own.status,200);assert.equal(own.body.sources.length,1);
  const sourceProbe=own.queries.find(q=>q.kind==='scalar'&&q.sql.includes('FROM sources WHERE'));
  assert.deepEqual((await service.tx(4,c=>c.query(sourceProbe.sql,[1]))).rows,[{rows:0,bytes:'0',bad:false}]);
});
test('small corrupt imported fields are rejected by scalar SQL before any body reaches Node; disabled sections stay unread',async()=>{
  await owner.query("UPDATE sources SET title=repeat('X',601) WHERE id=1");const before=await counts();
  for(const section of ['sources','facts','history','candidates']){const r=await read(only(section));declined(r);scalarOnly(r);assert.equal(r.queries.filter(q=>q.kind==='scalar').length,1);assert.equal(r.queries.find(q=>q.kind==='scalar').summary.bad,true)}
  assert.equal((await read(flags([]))).status,200);assert.deepEqual(await counts(),before);
  await owner.query("UPDATE sources SET title='fixture',content=repeat('X',16001) WHERE id=1");const r=await read(only('sources'));declined(r);scalarOnly(r);
  assert.equal((await read(flags(['facts','history','candidates','audit']))).status,200);
  await owner.query("UPDATE facts SET subject=repeat('X',401) WHERE id=1");const badSearch=await read(only('facts')+'&q=absent');declined(badSearch);scalarOnly(badSearch);
});
test('aggregate raw bytes reject before body queries, including repeated projections across multiple enabled sections',async()=>{
  await facts(500,"repeat('值',1000)");const before=await counts(),r=await read();declined(r);scalarOnly(r);assert.deepEqual(await counts(),before);
  assert.ok(r.queries.filter(q=>q.kind==='scalar').length>=3);
  assert.ok(r.queries.filter(q=>q.kind==='scalar').every(q=>q.rows===1));
});
test('escaped JSON rejects as a complete error after bounded driver rows, with no partial successful fields or data writes',async()=>{
  await sources(180,"repeat(chr(1),4000)");const before=await counts(),r=await read(only('sources'));declined(r);assert.equal(r.queries.filter(q=>q.kind==='body').length,1);
  const body=r.queries.find(q=>q.kind==='body');assert.equal(body.rows,183);assert.ok(body.bytes<5*1024*1024);assert.deepEqual(await counts(),before);
});
test('ordinary Unicode resource boundaries preserve content and audit keeps its legacy 100-row window',async()=>{
  await owner.query("UPDATE sources SET title=repeat('😀',75),content=repeat('😀',2000) WHERE id=1");
  await owner.query("INSERT INTO audit(project_id,actor_id,action,detail) SELECT 1,1,'fixture','原创审计'||n FROM generate_series(1,120)n");
  const r=await read();assert.equal(r.status,200);assert.equal(r.body.sources[0].title,'😀'.repeat(75));assert.equal(r.body.sources[0].content,'😀'.repeat(2000));assert.equal(r.body.audit.length,100);
  assert.equal(r.queries.find(q=>q.kind==='scalar'&&q.sql.includes('FROM audit WHERE')).rows,1);assert.equal(r.queries.filter(q=>q.kind==='body').at(-1).rows,100);
});
test('concurrent insert and text growth after metadata checks cannot drift the authorized response snapshot',async()=>{
  await sources(509);let changed=false;
  afterGuard=async()=>{await owner.query('BEGIN');try{await sources(1);await owner.query("UPDATE sources SET title=repeat('X',601) WHERE id=1");await owner.query('COMMIT');changed=true}catch(error){await owner.query('ROLLBACK');throw error}};
  const r=await read(only('sources'));assert.equal(changed,true);assert.equal(r.status,200);assert.equal(r.body.sources.length,512);assert.equal(r.body.sources[0].title,'会议纪要（合成）');
  const next=await read(only('sources'));declined(next);scalarOnly(next);
});
