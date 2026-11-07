// Small original fixtures only. Every test owns a random database and closes it.
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
const {Client,Pool}=require('pg');
const {runTransaction,databasePoolOptions}=require('../scripts/database');
const ROOT=path.resolve(__dirname,'..'),migration=fs.readFileSync(path.join(ROOT,'db/migrations/003-membership-active.sql'),'utf8');
const body="SELECT role FROM public.memberships WHERE project_id=p AND user_id=nullif(pg_catalog.current_setting('app.user_id',true),'')::pg_catalog.int4 AND active IS TRUE";
const tables=['sources','facts','candidates','revisions','audit','idempotency_requests'];
let applicationBytes=0,httpRequests=0,created=0,dropped=0;
function account(value){applicationBytes+=Buffer.byteLength(JSON.stringify(value));assert.ok(applicationBytes<1024*1024,'small synthetic application data budget')}
function connect(url){
  const c=new Client({connectionString:url,connectionTimeoutMillis:3000,statement_timeout:10000,query_timeout:15000});c.on('error',()=>{});
  const query=c.query;c.query=function(sql,params){account(params||[]);return query.call(this,sql,params).then(result=>{account(Array.isArray(result)?result.map(r=>r.rows):result.rows);return result})};return c;
}
async function migrate(c,sql=migration){try{await c.query(sql)}catch(error){await c.query('ROLLBACK');throw error}}
async function fixture(schema,fn){
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'explicit isolated test administrator connection required');
  const admin=connect(process.env.MIGRATION_TEST_DATABASE_URL),name='memz_membership_'+randomBytes(8).toString('hex');let owner,made=false;
  try{
    await admin.connect();await admin.query(`CREATE DATABASE ${name}`);made=true;created++;
    const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;owner=connect(url.href);await owner.connect();
    await owner.query(fs.readFileSync(path.join(ROOT,schema),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    if(schema!=='db/schema.sql')for(const file of ['001-current-revision-integrity.sql','002-create-idempotency.sql'])await migrate(owner,fs.readFileSync(path.join(ROOT,'db/migrations',file),'utf8'));
    await fn(owner,url.href);
  }finally{
    try{if(owner)await owner.end()}finally{try{if(made){await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);dropped++}}finally{await admin.end()}}
  }
}
async function snapshot(c){
  const data={};for(const table of tables)data[table]=(await c.query(`SELECT count(*)::int AS rows,md5(COALESCE(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) AS hash FROM ${table} t`)).rows[0];
  return {data,members:(await c.query('SELECT project_id,user_id,role FROM memberships ORDER BY 1,2')).rows,
    sequences:(await c.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY 1")).rows,
    policies:(await c.query("SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows,
    grants:(await c.query("SELECT table_name,grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' ORDER BY 1,2,3")).rows};
}
async function signature(c){return (await c.query("SELECT oid,proowner,proacl::text AS acl,prosrc,prosecdef,provolatile,proconfig,obj_description(oid,'pg_proc') AS marker FROM pg_proc WHERE oid='public.member_role(integer)'::regprocedure")).rows[0]}
async function field(c){return (await c.query("SELECT a.atttypid::regtype::text AS type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.memberships'::regclass AND a.attname='active' AND NOT a.attisdropped")).rows}
async function withPool(url,fn){const u=new URL(url);u.username='memz_app';u.password='memz_demo_only';const pool=new Pool(databasePoolOptions(u.href));pool.on('error',()=>{});
  pool.on('connect',c=>{const query=c.query;c.query=function(sql,params){account(params||[]);return query.call(this,sql,params).then(result=>{account(result.rows);return result})}});
  try{await fn(pool)}finally{await pool.end()}
}
async function withHTTP(url,fn){
  const u=new URL(url);u.username='memz_app';u.password='memz_demo_only';process.env.DATABASE_URL=u.href;
  // The only HTTP fixture in this isolated test worker imports the app once;
  // meter every application query result as well as the direct owner queries.
  const service=require('../server');service.pool.on('connect',c=>{const query=c.query;c.query=function(sql,params){account(params||[]);return query.call(this,sql,params).then(result=>{account(result.rows);return result})}});
  const server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{
    const base='http://127.0.0.1:'+server.address().port;
    async function call(route,{session,body,method=body===undefined?'GET':'POST',key,status=200}={}){
      const data=body===undefined?undefined:JSON.stringify(body);if(data)applicationBytes+=Buffer.byteLength(data);httpRequests++;
      const response=await fetch(base+route,{method,headers:{...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...(data?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},body:data,signal:AbortSignal.timeout(10000)});
      const text=await response.text();applicationBytes+=Buffer.byteLength(text);assert.ok(applicationBytes<1024*1024);assert.equal(response.status,status);
      return {data:JSON.parse(text),cookie:response.headers.get('set-cookie')?.split(';')[0]};
    }
    const login=async name=>{const r=await call('/api/login',{body:{username:name,password:'demo-'+name}});return {cookie:r.cookie,csrf:r.data.csrf}};
    await fn(call,login);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await service.pool.end()}
}

test('fresh schema activation is default true and actor FK rows survive explicit same-session member/owner revocation',async()=>{
  await fixture('db/schema.sql',async(owner,url)=>{
    assert.deepEqual(await field(owner),[{type:'boolean',attnotnull:true,default_value:'true'}]);const sig=await signature(owner);assert.equal(sig.prosrc,body);assert.equal(sig.marker,'memz:member-role-active-v1');assert.equal(sig.prosecdef,true);assert.equal(sig.provolatile,'s');assert.deepEqual(sig.proconfig,['search_path=public, pg_temp']);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM memberships WHERE active IS TRUE')).rows[0].n,4);
    await owner.query("INSERT INTO memberships(project_id,user_id,role) VALUES(2,2,'member')");
    await withHTTP(url,async(call,login)=>{
      const member=await login('member'),boss=await login('owner'),viewer=await login('viewer');
      const sourceBody={title:'原创撤权依据',content:'只用于合成撤权测试。'},candidateBody={subject:'原创撤权对象',predicate:'状态',value:'明确批准',expected_version:0};
      const source=(await call('/api/projects/1/sources',{session:member,body:sourceBody,key:'revocation-source'})).data;
      candidateBody.source_id=source.id;
      const candidate=(await call('/api/projects/1/candidates',{session:member,body:candidateBody,key:'revocation-candidate'})).data;
      assert.deepEqual((await call(`/api/projects/1/candidates/${candidate.id}/approve`,{session:boss,method:'POST'})).data,{status:'approved',version:1});
      const fact=(await owner.query('SELECT id FROM facts WHERE project_id=1 AND subject=$1',[candidateBody.subject])).rows[0];const before=await snapshot(owner);
      // No FK removal, actor remapping, cascade delete or history rewrite.
      for(const id of [1,2])await assert.rejects(()=>owner.query('DELETE FROM memberships WHERE project_id=1 AND user_id=$1',[id]),e=>e.code==='23503');
      assert.equal((await owner.query('UPDATE memberships SET active=false WHERE project_id=1 AND user_id=2 AND active IS TRUE')).rowCount,1);
      assert.equal((await owner.query('UPDATE memberships SET active=false WHERE project_id=1 AND user_id=2 AND active IS TRUE')).rowCount,0);
      assert.deepEqual((await call('/api/projects',{session:member})).data,[{id:2,name:'独立项目',role:'member'}]);
      for(const route of ['/facts','/history','/sources','/candidates','/audit','/current-labels','/data?include_facts=false&include_history=false&include_sources=false&include_candidates=false&include_audit=false','/context?q=原创撤权对象',`/facts/${fact.id}/provenance`])await call('/api/projects/1'+route,{session:member,status:403});
      await call('/api/projects/2/facts',{session:member});
      // Matching old keys must not bypass current authorization or reveal receipts.
      await call('/api/projects/1/sources',{session:member,body:sourceBody,key:'revocation-source',status:403});
      await call('/api/projects/1/candidates',{session:member,body:candidateBody,key:'revocation-candidate',status:403});
      await withPool(url,async pool=>{
        await runTransaction(pool,2,async c=>{assert.equal((await c.query('SELECT public.member_role(1) AS role')).rows[0].role,null);for(const table of ['projects','memberships',...tables])assert.equal((await c.query(`SELECT * FROM ${table} WHERE ${table==='projects'?'id':'project_id'}=1`)).rowCount,0)},{snapshot:true});
        // Explicit fixed ID avoids conflating nontransactional sequence gaps
        // with the RLS check; neither the denied row nor history may persist.
        await assert.rejects(()=>runTransaction(pool,2,c=>c.query("INSERT INTO sources(id,project_id,title,content) OVERRIDING SYSTEM VALUE VALUES(999999,1,'blocked','blocked')")),e=>e.code==='42501');
        for(const sql of ['UPDATE memberships SET active=true WHERE project_id=1 AND user_id=2','DELETE FROM memberships WHERE project_id=1 AND user_id=2'])await assert.rejects(()=>runTransaction(pool,2,c=>c.query(sql)),e=>e.code==='42501');
      });
      assert.equal((await owner.query('UPDATE memberships SET active=false WHERE project_id=1 AND user_id=1 AND active IS TRUE')).rowCount,1);
      await call('/api/projects/1/facts',{session:boss,status:403});await call(`/api/projects/1/candidates/${candidate.id}/approve`,{session:boss,method:'POST',status:403});assert.deepEqual((await call('/api/projects',{session:boss})).data,[]);
      const proof=(await call(`/api/projects/1/facts/${fact.id}/provenance`,{session:viewer})).data;assert.equal(proof.revision.approved_by,1);assert.equal(proof.candidate.proposed_by,2);assert.equal(proof.source.content,sourceBody.content);
      assert.deepEqual(await snapshot(owner),before,'revocation changes only membership.active, preserving roles/actors/history/receipts');
      await owner.query('UPDATE memberships SET active=true WHERE project_id=1 AND user_id=2');
      assert.deepEqual((await call('/api/projects/1/candidates',{session:member,body:candidateBody,key:'revocation-candidate'})).data,candidate,'explicit reactivation preserves old keyed receipt');
      assert.deepEqual(await snapshot(owner),before);
      for(const session of [member,boss,viewer])await call('/api/logout',{session,method:'POST'});
    });
  });
});

test('legacy 001/002 upgrade preserves data, actor keys, ACL/owner and explicit false through repeated/concurrent 003',async()=>{
  await fixture('test/fixtures/schema-5317607.sql',async(c,url)=>{
    await c.query("INSERT INTO idempotency_requests(project_id,actor_id,operation,request_key,request_hash,response) VALUES(1,1,'sources','kept-receipt',$1,'{\"id\":1}')",['0'.repeat(64)]);
    const before=await snapshot(c),old=await signature(c);assert.deepEqual(await field(c),[]);await migrate(c);
    const next=await signature(c);assert.equal(next.oid,old.oid);assert.equal(next.proowner,old.proowner);assert.equal(next.acl,old.acl);assert.equal(next.prosrc,body);assert.deepEqual(await snapshot(c),before);assert.equal((await c.query('SELECT count(*)::int AS n FROM memberships WHERE active')).rows[0].n,4);
    await c.query('UPDATE memberships SET active=false WHERE project_id=1 AND user_id=1');
    const other=connect(url);await other.connect();try{await Promise.all([migrate(c),migrate(other)])}finally{await other.end()}await migrate(c);
    assert.equal((await c.query('SELECT active FROM memberships WHERE project_id=1 AND user_id=1')).rows[0].active,false);assert.deepEqual(await snapshot(c),before);assert.deepEqual(await signature(c),next);
    await withPool(url,async pool=>{assert.equal(await runTransaction(pool,1,async client=>(await client.query('SELECT public.member_role(1) AS role')).rows[0].role),null);assert.equal(await runTransaction(pool,4,async client=>(await client.query('SELECT public.member_role(2) AS role')).rows[0].role),'owner')});
  });
});

test('003 app denial and real five-second lock timeout roll back without installing active or changing function/history',async()=>{
  await fixture('test/fixtures/schema-5317607.sql',async(c,url)=>{
    const before=await snapshot(c),sig=await signature(c);const app=new URL(url);app.username='memz_app';app.password='memz_demo_only';const denied=connect(app.href);await denied.connect();try{await assert.rejects(()=>migrate(denied),e=>e.code==='42501')}finally{await denied.end()}
    const blocker=connect(url);await blocker.connect();try{await blocker.query('BEGIN; LOCK TABLE memberships IN ACCESS SHARE MODE');await assert.rejects(()=>migrate(c),e=>e.code==='55P03')}finally{await blocker.query('ROLLBACK');await blocker.end()}
    assert.deepEqual(await field(c),[]);assert.deepEqual(await signature(c),sig);assert.deepEqual(await snapshot(c),before);await migrate(c);
  });
});

for(const definition of ['text NOT NULL DEFAULT \'true\'','boolean DEFAULT true','boolean NOT NULL DEFAULT false','boolean GENERATED ALWAYS AS (true) STORED NOT NULL'])test('003 refuses incompatible existing active field atomically: '+definition,async()=>{
  await fixture('test/fixtures/schema-5317607.sql',async(c)=>{
    await c.query('ALTER TABLE memberships ADD COLUMN active '+definition);const before=await snapshot(c),sig=await signature(c),column=await field(c);
    await assert.rejects(()=>migrate(c),e=>e.code==='55000');assert.deepEqual(await field(c),column);assert.deepEqual(await signature(c),sig);assert.deepEqual(await snapshot(c),before);
  });
});

test('failure after ADD COLUMN rolls the field back and preserves prior function, policies and historical rows',async()=>{
  await fixture('test/fixtures/schema-5317607.sql',async c=>{
    await c.query("CREATE FUNCTION synthetic_reject_function_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='synthetic migration failure'; END $$");
    await c.query("CREATE EVENT TRIGGER synthetic_membership_failure ON ddl_command_start WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION synthetic_reject_function_ddl()");
    const before=await snapshot(c),sig=await signature(c);await assert.rejects(()=>migrate(c),e=>e.code==='55000');assert.deepEqual(await field(c),[]);assert.deepEqual(await signature(c),sig);assert.deepEqual(await snapshot(c),before);
    await c.query('DROP EVENT TRIGGER synthetic_membership_failure');await migrate(c);assert.equal((await field(c))[0].attnotnull,true);
  });
});

test('an established repeatable-read snapshot retains its authorized view; the next transaction observes revocation',async()=>{
  await fixture('db/schema.sql',async(c,url)=>{
    await withPool(url,async pool=>{
      await runTransaction(pool,1,async client=>{
        assert.equal((await client.query('SELECT public.member_role(1) AS role')).rows[0].role,'owner');
        await c.query('UPDATE memberships SET active=false WHERE project_id=1 AND user_id=1');
        assert.equal((await client.query('SELECT public.member_role(1) AS role')).rows[0].role,'owner');assert.equal((await client.query('SELECT * FROM facts WHERE project_id=1')).rowCount,1);
      },{snapshot:true});
      assert.equal(await runTransaction(pool,1,async client=>(await client.query('SELECT public.member_role(1) AS role')).rows[0].role),null);
    });
  });
});

after(()=>{assert.equal(created,dropped);assert.ok(applicationBytes<1024*1024);console.log('Synthetic membership resources:',JSON.stringify({applicationBytes,httpRequests,temporaryDatabasesCreated:created,temporaryDatabasesDropped:dropped,modelCalls:0}))});
