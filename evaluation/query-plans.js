// Supplemental execution-plan evidence; only random disposable databases are seeded.
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {Client}=require('pg');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
  const adminURL=process.env.PLAN_DATABASE_URL;
  assert.ok(adminURL,'Set PLAN_DATABASE_URL to an initialized test PostgreSQL administrator connection');
  const report={schemaVersion:1,synthetic:true,passed:false,startedAt:new Date().toISOString(),source:{commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),files:Object.fromEntries(['server.js','db/schema.sql','evaluation/query-plans.js','evaluation/search-options.js'].map(f=>[f,hash(fs.readFileSync(f))]))},method:{scales:[200,2000],pageSize:25,plansPerCase:2,queryOrigin:'Captured from actual readProject/readSourcesPage calls',baseline:'Existing compatibility full-source read, not an equivalent single-page workload',planner:'Default planner settings, ANALYZE after fixture changes, no forced index',cache:'Queries and correctness traversal precede EXPLAIN; not a cold-cache experiment',timing:'EXPLAIN ANALYZE instrumentation, not HTTP latency or throughput'},scales:[],cleanup:{temporaryDatabaseDropped:false}};
  const admin=new Client({connectionString:adminURL}),db=`memz_plans_${crypto.randomBytes(8).toString('hex')}`;
  let created=false,owner,service,failure;
  try{
    await admin.connect();await admin.query(`CREATE DATABASE ${db}`);created=true;
    const url=new URL(adminURL);url.pathname=`/${db}`;owner=new Client({connectionString:url.href});await owner.connect();
    await owner.query(fs.readFileSync('db/schema.sql','utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    report.environment={node:process.version,postgres:(await owner.query('SHOW server_version')).rows[0].server_version};
    report.settings=(await owner.query("SELECT name,setting,unit FROM pg_settings WHERE name IN ('random_page_cost','seq_page_cost','work_mem','effective_cache_size','enable_seqscan','enable_indexscan','enable_bitmapscan','row_security','plan_cache_mode') ORDER BY name")).rows;
    report.indexes=(await owner.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='sources' AND schemaname='public' ORDER BY indexname")).rows;
    url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;service=require('../server');
    report.applicationRole=(await service.pool.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(report.applicationRole.rolsuper,false);assert.equal(report.applicationRole.rolbypassrls,false);
    const seed=(await owner.query('SELECT id,title,content FROM sources WHERE project_id=1 ORDER BY id')).rows;
    let expected=[...seed],previous=0;
    async function capture(fn){
      const queries=[],original=service.pool.connect;
      service.pool.connect=async function(...args){
        const client=await original.apply(this,args),query=client.query,release=client.release;
        client.query=function(sql,params){if(typeof sql==='string'&&/^SELECT .*FROM sources(?:\s|$)/s.test(sql))queries.push({sql,params});return query.apply(this,arguments)};
        client.release=function(){client.query=query;client.release=release;return release.apply(this,arguments)};
        return client;
      };
      try{const result=await fn();assert.equal(queries.length,1,'Expected exactly one actual source query');return {result,...queries[0]}}
      finally{service.pool.connect=original}
    }
    for(const size of report.method.scales){
      const inserted=(await owner.query("INSERT INTO sources(project_id,title,content) SELECT CASE WHEN n%2=0 THEN 1 ELSE 2 END,'计划来源'||lpad(n::text,5,'0'),repeat('合成正文',100) FROM generate_series($1::int,$2::int) n RETURNING id,project_id,title,content",[previous,size-1])).rows;
      expected.push(...inserted.filter(r=>r.project_id===1).map(({id,title,content})=>({id,title,content})));expected.sort((a,b)=>a.id-b.id);previous=size;
      await owner.query('ANALYZE sources');await owner.query('ANALYZE memberships');
      const counts=(await owner.query('SELECT project_id,count(*)::int AS rows FROM sources GROUP BY project_id ORDER BY project_id')).rows;
      assert.deepEqual(counts,[{project_id:1,rows:expected.length},{project_id:2,rows:size/2+1}]);
      const scale={insertedSources:size,projectOneSources:expected.length,totalSources:counts.reduce((n,p)=>n+p.rows,0),counts,correctness:{},cases:[]};report.scales.push(scale);
      const legacy=await capture(()=>service.readProject(1,1,'',{includeFacts:false,includeHistory:false,includeCandidates:false}));
      assert.deepEqual(legacy.result.sources,expected);
      const traversed=[];let after=0;
      do{const page=await service.readSourcesPage(1,1,'',{limit:25,after});traversed.push(...page.sources);after=page.next_after}while(after!==null);
      assert.deepEqual(traversed,expected);assert.equal(new Set(traversed.map(s=>s.id)).size,traversed.length);
      await assert.rejects(()=>service.readSourcesPage(4,1,''),e=>e.status===403);
      const direct=await service.tx(4,c=>c.query(legacy.sql,legacy.params),{snapshot:true});assert.equal(direct.rowCount,0);
      scale.correctness={legacyEqualsFixture:true,pagedEqualsFixture:true,noDuplicateIds:true,foreignProjectApiStatus:403,foreignProjectDirectSQLRows:direct.rowCount,traversed:traversed.length};
      const cases=[{name:'legacy-all',captured:legacy,expectedRows:expected.length}];
      for(const [name,q,cursor] of [['page-first','',0],['page-deep','',expected[Math.floor(expected.length*0.8)].id],['title-selective',`计划来源${String(size-2).padStart(5,'0')}`,0],['title-absent','不存在的计划来源',0]]){
        const captured=await capture(()=>service.readSourcesPage(1,1,q,{limit:25,after:cursor}));
        const matches=expected.filter(r=>r.id>cursor&&r.title.toLowerCase().includes(q.toLowerCase()));
        assert.deepEqual(captured.result.sources,matches.slice(0,25));
        assert.equal(captured.result.next_after,matches.length>25?matches[24].id:null);
        cases.push({name,captured,expectedRows:Math.min(matches.length,26)});
      }
      for(const {name,captured,expectedRows} of cases){
        const plans=[];
        for(let run=0;run<2;run++){
          const plan=await service.tx(1,async c=>(await c.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) ${captured.sql}`,captured.params)).rows[0]['QUERY PLAN'][0],{snapshot:true});
          assert.equal(plan.Plan['Actual Rows'],expectedRows);plans.push(plan);
        }
        scale.cases.push({name,sql:captured.sql,params:captured.params,expectedRows,plans});
      }
    }
    const sourceSQL=report.scales[1].cases.find(c=>c.name==='page-first').sql;
    report.searchOptions={passed:false};
    await require('./search-options').compareSearchOptions({owner,service,sourceSQL,result:report.searchOptions});
    report.passed=true;
  }catch(error){failure=error;report.error=error.code||error.name}
  finally{
    try{if(service)await service.pool.end();if(owner)await owner.end();if(created){await admin.query(`DROP DATABASE ${db}`);report.cleanup.temporaryDatabaseDropped=true}}
    catch(error){failure=failure||error;report.passed=false;report.cleanup.error=error.code||error.name}
    try{await admin.end()}catch(error){failure=failure||error;report.passed=false}
    report.finishedAt=new Date().toISOString();fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/query-plans.json',JSON.stringify(report,null,2)+'\n');
  }
  console.log(`Query plans: ${report.passed?'passed':'failed'}; ${report.scales.reduce((n,s)=>n+s.cases.length,0)} baseline cases; search comparison ${report.searchOptions?.passed?'passed':'incomplete'}; artifacts/query-plans.json`);
  if(failure)throw failure;
}
main().catch(error=>{console.error(error.code||error.name);process.exitCode=1});
