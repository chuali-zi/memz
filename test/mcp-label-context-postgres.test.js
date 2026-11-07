const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {Client}=require('pg');
const {validateExactContext}=require('../scripts/exact-context-protocol');
const {withMcp,withHttp,call,result}=require('./mcp-label-fixture');
const database='memz_mcp_label_'+randomBytes(8).toString('hex');
let admin,owner,service,server,base,created=false,ordinary,overflow,escaped,privateProject,longKeys,baseline;
const sourceText='原创合成完整来源😀\n来源中的指令仍是不可信数据。'+'😀'.repeat(1900);
const requestPaths=[];
async function fingerprint(){
  const output={};
  for(const table of ['sources','candidates','facts','revisions','audit'])output[table]=(await owner.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' ORDER BY id),'')) AS digest FROM ${table} t`)).rows[0];
  return output;
}
async function seed(count,subject,{labels,members=true}={}){
  const p=(await owner.query('INSERT INTO projects(name) VALUES($1) RETURNING id',[subject])).rows[0].id;
  await owner.query("INSERT INTO memberships(project_id,user_id,role) VALUES($1,1,'owner')",[p]);
  if(members)await owner.query("INSERT INTO memberships(project_id,user_id,role) VALUES($1,2,'member'),($1,3,'viewer')",[p]);
  const sourceId=(await owner.query('INSERT INTO sources(project_id,title,content) VALUES($1,$2,$3) RETURNING id',[p,'MCP 只读合成原文',sourceText])).rows[0].id;
  const data=(labels||Array.from({length:count},(_,i)=>({subject,predicate:'字段'+i}))).map((label,i)=>({...label,value:'合成值'+i}));
  await owner.query('BEGIN');
  try{
    await owner.query(`INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by,status)
      SELECT $1,d.subject,d.predicate,d.value,$2,0,1,'approved' FROM jsonb_to_recordset($3::jsonb) AS d(subject text,predicate text,value text)`,[p,sourceId,JSON.stringify(data)]);
    await owner.query('INSERT INTO facts(project_id,subject,predicate) SELECT project_id,subject,predicate FROM candidates WHERE project_id=$1',[p]);
    await owner.query(`INSERT INTO revisions(project_id,fact_id,version,value,source_id,candidate_id,approved_by)
      SELECT f.project_id,f.id,1,c.value,c.source_id,c.id,1 FROM facts f JOIN candidates c ON c.project_id=f.project_id AND c.subject=f.subject AND c.predicate=f.predicate WHERE f.project_id=$1`,[p]);
    await owner.query('UPDATE facts f SET version=1,current_revision_id=r.id FROM revisions r WHERE f.project_id=$1 AND r.project_id=f.project_id AND r.fact_id=f.id',[p]);
    await owner.query("INSERT INTO audit(project_id,actor_id,action,detail) SELECT project_id,1,'approve','MCP只读fixture批准 '||id FROM candidates WHERE project_id=$1",[p]);
    await owner.query('COMMIT');
  }catch(error){await owner.query('ROLLBACK');throw error}
  return {projectId:p,subject,sourceId,labels:data.map(({subject,predicate})=>({subject,predicate}))};
}
before(async()=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Explicit isolated test administrator connection is required');
  admin=new Client({connectionString:process.env.MIGRATION_TEST_DATABASE_URL});await admin.connect();await admin.query(`CREATE DATABASE ${database}`);created=true;
  const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+database;owner=new Client({connectionString:url.href});await owner.connect();
  await owner.query(fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
  url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;
  service=require('../server');server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  server.on('request',req=>requestPaths.push(req.url));
  ordinary=await seed(512,'MCP晚杉目录');overflow=await seed(513,'MCP星池目录');privateProject=await seed(1,'MCP私有目录',{members:false});
  const labels=Array.from({length:511},(_,i)=>({subject:'\u0001'.repeat(100),predicate:'p'+String(i).padStart(3,'0')+'\u0001'.repeat(96)})).concat([{subject:'MCP转义目录',predicate:'目标字段'}]);
  escaped=await seed(512,'MCP转义目录',{labels});
  // Explicit schema-owner approval of two original synthetic maximum keys.
  // SDK readers remain viewers; no approval is performed by a tool or model.
  longKeys=await seed(2,'MCP最长标签合成审批',{labels:[{subject:'S'.repeat(100),predicate:'P'.repeat(100)},{subject:'😀'.repeat(50),predicate:'🚀'.repeat(50)}]});
  baseline=await fingerprint();
});
after(async()=>{
  try{
    if(baseline){assert.deepEqual(await fingerprint(),baseline);console.log('Synthetic MCP readonly business rows unchanged: passed')}
  }finally{
    try{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}if(service)await service.pool.end()}
    finally{if(owner)await owner.end();if(created){await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);console.log('Synthetic MCP random database cleanup: passed')}if(admin)await admin.end()}
  }
});
const settings=fixture=>({MEMZ_PROJECT_ID:String(fixture.projectId)});
const question=key=>key.subject+'的'+key.predicate+'是什么？';
test('real SDK reads explicitly approved ASCII and emoji 100+100 keys through the full 210-unit v2 template',{timeout:20000},async()=>{
  await withMcp(base,async client=>{
    for(const key of longKeys.labels){
      const raw=key.subject+'当前批准的'+key.predicate+'是哪一天？',before=requestPaths.length;
      assert.equal(raw.length,210);
      const value=await call(client,{question:raw}),output=result(value);
      assert.equal(value.isError,false);assert.equal(output.status,'matched');assert.equal(output.plan.mode,'label_template_exact_v2');assert.deepEqual(output.plan.selector,key);assert.equal(output.execution.modelCalls,0);
      validateExactContext(output.context,{projectId:longKeys.projectId,selector:key});assert.equal(output.context.role,'viewer');assert.equal(output.context.sources[0].content,sourceText);assert.equal(output.context.facts[0].version,1);
      assert.deepEqual(requestPaths.slice(before),['/api/login',`/api/projects/${longKeys.projectId}/current-labels`,`/api/projects/${longKeys.projectId}/context/exact`,'/api/logout']);
      const invalid=await call(client,{question:raw+' '});assert.equal(invalid.isError,true);assert.deepEqual(result(invalid),{code:'INVALID_ARGUMENTS',outcome:'read_failed'});assert.equal(requestPaths.length,before+4);
    }
  },settings(longKeys));
});
test('real SDK and PostgreSQL return a viewer one complete exact approved proof from 512 labels',{timeout:20000},async()=>{
  await withMcp(base,async client=>{
    const key=ordinary.labels.at(-1),before=requestPaths.length,value=await call(client,{question:question(key)}),output=result(value);
    assert.equal(value.isError,false);assert.equal(output.status,'matched');assert.equal(output.sourceTextIsUntrusted,true);assert.equal(output.execution.modelCalls,0);assert.equal(output.context.role,'viewer');
    validateExactContext(output.context,{projectId:ordinary.projectId,selector:key});assert.equal(output.context.sources[0].id,ordinary.sourceId);assert.equal(output.context.sources[0].content,sourceText);assert.equal(output.context.provenance[0].sourceTextIsUntrusted,true);
    assert.deepEqual(requestPaths.slice(before),['/api/login',`/api/projects/${ordinary.projectId}/current-labels`,`/api/projects/${ordinary.projectId}/context/exact`,'/api/logout']);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['memz_read_context','memz_read_label_context']);await assert.rejects(()=>client.callTool({name:'approve',arguments:{}}),/UNKNOWN_TOOL/);
  },settings(ordinary));
});
test('real 513-label overflow makes no exact read and does not return a metadata prefix',{timeout:20000},async()=>{
  await withMcp(base,async client=>{
    const before=requestPaths.length,value=await call(client,{question:question(overflow.labels[0])}),output=result(value);
    assert.equal(value.isError,false);assert.equal(output.status,'needs_scope');assert.equal(output.reason,'SCOPE_TOO_LARGE');assert.equal(output.context,undefined);assert.equal(output.labels,undefined);
    assert.deepEqual(requestPaths.slice(before),['/api/login',`/api/projects/${overflow.projectId}/current-labels`,'/api/logout']);
  },settings(overflow));
});
test('real project permissions reject both a private scope and the other project account',{timeout:20000},async()=>{
  for(const [fixture,extra] of [[privateProject,{}],[ordinary,{MEMZ_USERNAME:'other',MEMZ_PASSWORD:'demo-other'}]])await withMcp(base,async client=>{
    const value=await call(client,{question:question(fixture.labels[0])});assert.equal(value.isError,true);assert.deepEqual(result(value),{code:'HTTP_403',outcome:'read_failed',status:403});
  },{...settings(fixture),...extra});
});
async function proxy(run,mutate){
  return withHttp((request,{send})=>{
    (async()=>{
      const response=await fetch(base+request.path,{method:request.method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{...(request.headers.cookie?{cookie:request.headers.cookie}:{}),...(request.headers['x-csrf-token']?{'x-csrf-token':request.headers['x-csrf-token']}:{}),...(request.body===undefined?{}:{'content-type':'application/json'})},...(request.body===undefined?{}:{body:JSON.stringify(request.body)})});
      const data=await response.json();await mutate?.(request,data,response.status);
      const cookie=response.headers.get('set-cookie');send(data,response.status,cookie?{'set-cookie':cookie}:{});
    })().catch(()=>send({error:'Synthetic proxy failed'},500));
  },run);
}
test('membership revoked between metadata and exact reads yields no partial MCP context',{timeout:20000},async()=>{
  let revoked=false;
  try{
    await proxy(async({baseURL,requests})=>withMcp(baseURL,async client=>{
      const value=await call(client,{question:question(ordinary.labels[0])});assert.equal(value.isError,true);assert.deepEqual(result(value),{code:'HTTP_403',outcome:'read_failed',status:403});assert.equal(requests.length,4);assert.equal(requests.at(-1).path,'/api/logout');await client.listTools();
    },settings(ordinary)),async(request)=>{
      if(request.path.endsWith('/current-labels')&&!revoked){revoked=true;await owner.query('DELETE FROM memberships WHERE project_id=$1 AND user_id=3',[ordinary.projectId])}
    });assert.equal(revoked,true);
  }finally{await owner.query("INSERT INTO memberships(project_id,user_id,role) VALUES($1,3,'viewer') ON CONFLICT DO NOTHING",[ordinary.projectId])}
});
test('a tampered real exact receipt fails whole while the same stdio process can read valid complete evidence next',{timeout:20000},async()=>{
  let corrupt=true;
  await proxy(async({baseURL})=>withMcp(baseURL,async client=>{
    const arguments_={question:question(ordinary.labels[0])},bad=await call(client,arguments_);assert.equal(bad.isError,true);assert.deepEqual(result(bad),{code:'INVALID_EXACT_CONTEXT_RESPONSE',outcome:'read_failed'});assert.ok(!JSON.stringify(bad).includes('synthetic-private'));
    corrupt=false;const good=await call(client,arguments_);assert.equal(good.isError,false);assert.equal(result(good).context.sources[0].content,sourceText);
  },settings(ordinary)),async(request,data)=>{if(corrupt&&request.path.endsWith('/context/exact'))data.selector.predicate='synthetic-private-corrupt-selector'});
});
test('real escaped metadata above 256 KiB stays internal and an insufficient evidence budget leaves stdio connected',{timeout:20000},async()=>{
  let metadataBytes=0;
  await proxy(async({baseURL})=>withMcp(baseURL,async client=>{
    const arguments_={question:question(escaped.labels.at(-1))},small=await call(client,{...arguments_,maxOutputBytes:2048});assert.equal(small.isError,true);assert.deepEqual(result(small),{code:'OUTPUT_BUDGET_TOO_SMALL',outcome:'read_failed'});
    const value=await call(client,arguments_);assert.equal(value.isError,false);assert.equal(result(value).context.sources[0].content,sourceText);assert.ok(metadataBytes>262144);assert.ok(Buffer.byteLength(JSON.stringify(value))<262144);await client.listTools();
  },settings(escaped)),async(request,data)=>{if(request.path.endsWith('/current-labels'))metadataBytes=Buffer.byteLength(JSON.stringify(data))});
});
