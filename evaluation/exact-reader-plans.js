// Execution-plan checks of the product's actual SQL, using explicitly approved
// synthetic facts in a random disposable database. No HTTP or model calls.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {Client}=require('pg');
const {captureQueries}=require('./capture-queries');
const {databasePoolOptions}=require('../scripts/database');
const {validateCurrentLabels,validateExactContext}=require('../scripts/exact-context-protocol');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const files=['server.js','db/schema.sql','scripts/database.js','scripts/exact-context-protocol.js','scripts/context-evidence.js','evaluation/exact-reader-plans.js','evaluation/capture-queries.js'];

async function main(){
  const adminURL=process.env.PLAN_DATABASE_URL;
  assert.ok(adminURL,'Set PLAN_DATABASE_URL to an isolated test PostgreSQL administrator connection');
  const report={schemaVersion:1,synthetic:true,passed:false,startedAt:new Date().toISOString(),
    source:{commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),files:Object.fromEntries(files.map(file=>[file,hash(fs.readFileSync(file))]))},
    method:{scales:[512,4096],plansPerQuery:2,role:'viewer via the real product transaction and RLS',queryOrigin:'Captured from actual readCurrentLabels/readExactContext calls',
      fixture:'Explicitly approved synthetic fixtures only; this does not import or approve external material',
      timing:'EXPLAIN ANALYZE instrumentation; not HTTP latency, throughput, model quality or a technology-stack comparison',
      cache:'ANALYZE and product correctness calls precede EXPLAIN; warmed, not a cold-cache experiment',
      planner:'Default planner settings; no forced indexes',concurrency:'Other isolated tests may be running; no exclusive hardware claim',
      limits:'Metadata is complete through 512 labels. Direct exact SQL is also measured at 4096; the template client still refuses that incomplete vocabulary.'},
    stage:'initialization',scales:[],cleanup:{temporaryDatabaseDropped:false}};
  const name='memz_exact_plans_'+crypto.randomBytes(8).toString('hex');
  report.cleanup.database=name;
  let admin,owner,service,created=false,failure;
  try{
    admin=new Client(databasePoolOptions(adminURL));await admin.connect();await admin.query(`CREATE DATABASE ${name}`);created=true;
    const url=new URL(adminURL);url.pathname='/'+name;owner=new Client(databasePoolOptions(url.href));await owner.connect();
    await owner.query(fs.readFileSync('db/schema.sql','utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    report.environment={node:process.version,postgres:(await owner.query('SHOW server_version')).rows[0].server_version};
    url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;service=require('../server');
    report.applicationRole=(await service.pool.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(report.applicationRole.rolsuper,false);assert.equal(report.applicationRole.rolbypassrls,false);
    report.settings=(await owner.query("SELECT name,setting,unit FROM pg_settings WHERE name IN ('random_page_cost','seq_page_cost','work_mem','effective_cache_size','enable_seqscan','enable_indexscan','enable_bitmapscan','row_security','plan_cache_mode') ORDER BY name")).rows;
    report.indexes=(await owner.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1) ORDER BY tablename,indexname",[['facts','revisions','candidates','sources']])).rows;
    async function capture(read){
      return captureQueries(service.pool,read,sql=>typeof sql==='string'&&/^SELECT\b/i.test(sql)&&/\b(?:FROM|JOIN)\s+(?:facts|revisions|candidates|sources)\b/i.test(sql));
    }
    for(const size of report.method.scales){
      report.stage='fixture:'+size;
      await owner.query('BEGIN');let project;
      try{
        project=(await owner.query("INSERT INTO projects(name) VALUES($1) RETURNING id",['Synthetic exact plans '+size])).rows[0].id;
        await owner.query("INSERT INTO memberships(project_id,user_id,role) VALUES($1,1,'owner'),($1,3,'viewer')",[project]);
        const source=(await owner.query("INSERT INTO sources(project_id,title,content) VALUES($1,'Explicit synthetic approval fixture','Generated plan-check evidence only. No external data or model output.') RETURNING id",[project])).rows[0].id;
        await owner.query("INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by,status) SELECT $1,'Synthetic item '||n,'status','approved fixture '||n,$2,0,1,'approved' FROM generate_series(1,$3::int) n",[project,source,size]);
        await owner.query('INSERT INTO facts(project_id,subject,predicate) SELECT project_id,subject,predicate FROM candidates WHERE project_id=$1',[project]);
        await owner.query('INSERT INTO revisions(project_id,fact_id,version,value,source_id,candidate_id,approved_by) SELECT c.project_id,f.id,1,c.value,c.source_id,c.id,1 FROM candidates c JOIN facts f ON f.project_id=c.project_id AND f.subject=c.subject AND f.predicate=c.predicate WHERE c.project_id=$1',[project]);
        await owner.query('UPDATE facts f SET version=1,current_revision_id=r.id FROM revisions r WHERE f.project_id=$1 AND r.project_id=f.project_id AND r.fact_id=f.id',[project]);
        await owner.query('COMMIT');
      }catch(error){await owner.query('ROLLBACK');throw error}
      for(const table of ['facts','revisions','candidates','sources','memberships'])await owner.query(`ANALYZE ${table}`);
      const dataset=(await owner.query('SELECT f.subject,f.predicate,f.version,r.value,s.title,s.content,c.status FROM facts f JOIN revisions r ON r.id=f.current_revision_id JOIN sources s ON s.id=r.source_id JOIN candidates c ON c.id=r.candidate_id WHERE f.project_id=$1 ORDER BY f.subject,f.predicate',[project])).rows;
      assert.equal(dataset.length,size);
      const selector={subject:'Synthetic item '+size,predicate:'status'};
      report.stage='metadata:'+size;
      const metadata=await capture(()=>service.readCurrentLabels(3,project));
      validateCurrentLabels(metadata.result,{projectId:project});
      assert.equal(metadata.queries.length,1);assert.equal(metadata.result.complete,size<=512);assert.equal(metadata.result.labels.length,size<=512?size:0);
      report.stage='exact:'+size;
      const exact=await capture(()=>service.readExactContext(3,project,selector));
      // The HTTP serializer turns pg Date values into ISO strings. Validate the
      // same materialized receipt, without calling this an HTTP experiment.
      validateExactContext(JSON.parse(JSON.stringify(exact.result)),{projectId:project,selector});
      assert.equal(exact.queries.length,3);assert.equal(exact.result.facts.length,1);assert.equal(exact.result.facts[0].value,'approved fixture '+size);assert.equal(exact.result.provenance.length,1);assert.equal(exact.result.sources.length,1);
      assert.equal(exact.result.sources[0].content,'Generated plan-check evidence only. No external data or model output.');
      report.stage='permissions:'+size;
      await assert.rejects(()=>service.readCurrentLabels(4,project),error=>error.status===403);
      await assert.rejects(()=>service.readExactContext(4,project,selector),error=>error.status===403);
      const direct=await service.tx(4,client=>client.query('SELECT id FROM facts WHERE project_id=$1',[project]),{snapshot:true});assert.equal(direct.rowCount,0);
      const scale={facts:size,datasetSha256:hash(JSON.stringify(dataset)),metadataComplete:metadata.result.complete,correctness:{exactFactCount:1,fullProvenance:true,foreignProjectStatus:403,foreignProjectDirectRows:0},queries:[]};report.scales.push(scale);
      for(const [operation,captured] of [['metadata',metadata],['exact',exact]]){
        for(const [index,query] of captured.queries.entries()){
          const plans=[];
          for(let run=0;run<2;run++){
            report.stage=`explain:${size}:${operation}:${index}:${run}`;
            plans.push(await service.tx(3,async client=>(await client.query('EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) '+query.sql,query.params)).rows[0]['QUERY PLAN'][0],{snapshot:true}));
          }
          const expected=operation==='metadata'?Math.min(size,513):1;
          for(const plan of plans)assert.equal(plan.Plan['Actual Rows'],expected);
          scale.queries.push({operation,index,sql:query.sql,params:query.params,expectedRows:expected,plans});
        }
      }
    }
    report.passed=true;report.stage='complete';
  }catch(error){failure=error;report.error=error.code&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'EXACT_PLAN_CHECK_FAILED'}
  finally{
    const cleanupFailure=step=>{
      failure=failure||new Error('CLEANUP_FAILED');report.passed=false;
      report.cleanup.error='CLEANUP_FAILED';(report.cleanup.failedSteps||=[]).push(step);
    };
    // One failed close must not skip the remaining owned-resource cleanup.
    try{if(service)await service.pool.end()}catch{cleanupFailure('application_pool')}
    try{if(owner)await owner.end()}catch{cleanupFailure('schema_owner')}
    try{if(created){await admin.query(`DROP DATABASE ${name}`);report.cleanup.temporaryDatabaseDropped=true}}catch{cleanupFailure('temporary_database')}
    try{if(admin)await admin.end()}catch{cleanupFailure('administrator')}
    report.finishedAt=new Date().toISOString();fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/exact-reader-plans.json',JSON.stringify(report,null,2)+'\n');
  }
  console.log(`Exact reader SQL plans: ${report.passed?'passed':'failed'}; ${report.scales.length} synthetic scales; stage=${report.stage}; artifacts/exact-reader-plans.json`);
  if(failure)throw new Error('Exact reader SQL plan check failed; inspect the redacted report');
}
main().catch(()=>{console.error('EXACT_PLAN_CHECK_FAILED');process.exitCode=1});
