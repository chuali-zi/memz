// Synthetic transport/representation ablation; no models or answer-quality claims.
// The supplied administrator database is never seeded: all writes use a random child DB.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {Client}=require('pg');
const {readContext}=require('../scripts/context-client');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const arms=['individual','batch','snapshot'].flatMap(provenanceMode=>['inline','deduplicated'].map(sourceMode=>({name:`${provenanceMode}_${sourceMode}`,provenanceMode,sourceMode})));
const scenarios=[{name:'shared_full',query:'实验共享'}, {name:'unique_full',query:'实验独立'}, {name:'shared_budget',query:'实验共享',maxOutputBytes:16000}];
const repeats=20,warmups=2;
const expand=context=>context.facts.map(fact=>{
  if(context.schemaVersion===1)return fact;
  const {sourceId,...rest}=fact;
  const source=context.sources.find(s=>s.id===sourceId);assert.ok(source);
  return {...rest,source};
});
async function main(){
  const adminURL=process.env.CONTEXT_EVALUATION_DATABASE_URL;
  assert.ok(adminURL,'Set CONTEXT_EVALUATION_DATABASE_URL to an initialized test administrator connection.');
  const output=path.resolve(process.env.CONTEXT_EVALUATION_OUTPUT||'artifacts/context-optimization.json');
  assert.ok(!fs.existsSync(output),'Choose a fresh CONTEXT_EVALUATION_OUTPUT; reports are not overwritten.');
  const report={schemaVersion:1,status:'running',synthetic:true,startedAt:new Date().toISOString(),
    source:{commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
      files:Object.fromEntries(['server.js','scripts/context-client.js','scripts/context-snapshot.js','scripts/search-query.js','db/schema.sql','evaluation/context-optimization.js'].map(f=>[f,hash(fs.readFileSync(f))]))},
    environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,postgres:null},
    protocol:{warmups,repeats,concurrency:1,armOrder:'deterministic round-robin rotation by repetition; no tuning',factCountPerScenario:25,budgetUnit:'utf8-json-bytes-including-final-newline',
      timing:'login + current facts and immutable provenance (snapshot combines the data reads) + serialization validation + logout; response bodies measured by clone in every arm',
      scope:'local HTTP/context assembly only; excludes model prefill, generation and judge',modelCalls:0,modelInputTokens:null,modelOutputTokens:null,modelCost:null,answerQuality:null},
    ingestion:{sourceWrites:[],candidateAndApproval:[],maintenance:[]},runs:[],summary:[],checks:{},cleanup:{temporaryDatabaseDropped:false}};
  const admin=new Client({connectionString:adminURL}),db=`memz_context_eval_${crypto.randomBytes(8).toString('hex')}`;
  let created=false,owner,pool,server,failed;
  try{
    await admin.connect();report.environment.postgres=(await admin.query('SHOW server_version')).rows[0].server_version;
    assert.equal((await admin.query("SELECT 1 FROM pg_roles WHERE rolname='memz_app'")).rowCount,1);
    await admin.query(`CREATE DATABASE ${db}`);created=true;
    const url=new URL(adminURL);url.pathname=`/${db}`;owner=new Client({connectionString:url.href});await owner.connect();
    await owner.query(fs.readFileSync('db/schema.sql','utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    const size=async()=>Number((await owner.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
    report.ingestion.databaseBytesBefore=await size();
    url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;
    const service=require('../server');pool=service.pool;
    const {tx,decide}=service;
    async function source(title,content){
      const start=performance.now();const id=await tx(1,async c=>(await c.query('INSERT INTO sources(project_id,title,content) VALUES(1,$1,$2) RETURNING id',[title,content])).rows[0].id);
      report.ingestion.sourceWrites.push({latencyMs:performance.now()-start,contentBytes:Buffer.byteLength(content)});return id;
    }
    async function propose(subject,predicate,value,sourceId,version=0,decision='approve',maintenance=false){
      const start=performance.now();
      try{
        await tx(1,async c=>{
          const id=(await c.query('INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by) VALUES(1,$1,$2,$3,$4,$5,1) RETURNING id',[subject,predicate,value,sourceId,version])).rows[0].id;
          if(decision)await decide(c,1,1,id,decision);
        });
        report.ingestion[maintenance?'maintenance':'candidateAndApproval'].push({latencyMs:performance.now()-start,status:decision||'pending'});
      }catch(error){
        report.ingestion.maintenance.push({latencyMs:performance.now()-start,status:'conflict',httpStatus:error.status});throw error;
      }
    }
    const shared=await source('共享依据（合成）','这是合成来源，不包含真实用户信息。'.repeat(180));
    for(let i=0;i<25;i++){
      await propose('实验共享',`字段${i}`,`已批准值${i}`,shared);
      const unique=await source(`独立依据${i}（合成）`,(`第${i}项的合成来源。`).repeat(180));
      await propose('实验独立',`字段${i}`,`已批准值${i}`,unique);
    }
    const old=await source('过时版本（合成）','旧批准截止日为20号。');
    const current=await source('当前版本（合成）','新批准截止日为15号。');
    await propose('实验冲突','截止日','20号',old);
    await propose('实验冲突','截止日','15号',current,1,'approve',true);
    await propose('实验冲突','截止日','30号',old,2,'reject',true);
    await propose('实验冲突','截止日','40号',old,2,null,true);
    await assert.rejects(()=>propose('实验冲突','截止日','25号',old,1,'approve',true),e=>e.status===409);
    report.ingestion.databaseBytesAfter=await size();
    report.ingestion.measurement='Application-role source writes and candidate+approval transactions; schema initialization excluded; database size is page-allocation proxy, not per-index marginal storage.';
    server=await new Promise(resolve=>{const s=service.app.listen(0,'127.0.0.1',()=>resolve(s))});
    const baseURL=`http://127.0.0.1:${server.address().port}`;
    for(const arm of arms){
      const result=await readContext({baseURL,query:'实验冲突',...arm});const facts=expand(result);
      assert.equal(facts.length,1);assert.equal(facts[0].value,'15号');assert.equal(facts[0].version,2);assert.equal(facts[0].source.id,current);
    }
    report.checks.currentApprovedVersionIgnoresOldRejectedPending=true;
    for(const scenario of scenarios){
      const expected=expand(await readContext({baseURL,query:scenario.query}));assert.equal(expected.length,25);
      for(let repetition=-warmups;repetition<repeats;repetition++){
        const offset=(repetition+warmups)%arms.length,order=[...arms.slice(offset),...arms.slice(0,offset)];
        for(const arm of order){
          let requests=0,responseBytes=0;
          const fetchImpl=async(...args)=>{requests++;const response=await fetch(...args);responseBytes+=(await response.clone().arrayBuffer()).byteLength;return response};
          const start=performance.now();
          const context=await readContext({baseURL,...scenario,...arm,fetchImpl});
          const serialized=JSON.stringify(context,null,2)+'\n',latencyMs=performance.now()-start,facts=expand(context);
          assert.ok(facts.length>0);assert.deepEqual(facts,expected.slice(0,facts.length));
          assert.equal(context.sourceTextIsUntrusted,true);
          if(scenario.maxOutputBytes)assert.ok(Buffer.byteLength(serialized)<=scenario.maxOutputBytes);
          else assert.equal(facts.length,25);
          if(repetition>=0)report.runs.push({scenario:scenario.name,arm:arm.name,repetition,latencyMs,requests,responseBytes,contextBytes:Buffer.byteLength(serialized),facts:facts.length,sourceCopies:context.schemaVersion===1?facts.length:context.sources.length,contextSha256:hash(serialized)});
        }
      }
      // Verify continuation reconstructs the same full facts for each budgeted representation.
      if(scenario.maxOutputBytes)for(const arm of arms){
        const facts=[];let after=0,pages=0;
        do{const page=await readContext({baseURL,...scenario,...arm,after});facts.push(...expand(page));after=page.nextAfter;assert.ok(++pages<=25)}while(after!==null);
        assert.deepEqual(facts,expected);
      }
    }
    for(const scenario of scenarios)for(const arm of arms){
      const rows=report.runs.filter(r=>r.scenario===scenario.name&&r.arm===arm.name);
      report.summary.push({scenario:scenario.name,arm:arm.name,n:rows.length,latencyP50Ms:percentile(rows.map(r=>r.latencyMs),.5),latencyP95Ms:percentile(rows.map(r=>r.latencyMs),.95),
        requests:rows[0].requests,responseBytes:rows[0].responseBytes,contextBytes:rows[0].contextBytes,facts:rows[0].facts,sourceCopies:rows[0].sourceCopies});
      for(const row of rows)for(const key of ['requests','responseBytes','contextBytes','facts','sourceCopies','contextSha256'])assert.equal(row[key],rows[0][key],`determinism: ${key}`);
    }
    report.checks.sameFullFactsAndExactSources=true;report.checks.budgetPrefixAndContinuation=true;report.checks.deterministicContextHashes=true;
    report.status='passed';
  }catch(error){failed=error;report.status='failed';report.error={name:error.name,code:error.code||null};}
  finally{
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});
    if(pool)await pool.end();if(owner)await owner.end();
    try{if(created){await admin.query(`DROP DATABASE ${db}`);report.cleanup.temporaryDatabaseDropped=true}}catch(error){failed=failed||error;report.status='failed';report.cleanup.errorCode=error.code||'CLEANUP_FAILED'}
    await admin.end();report.finishedAt=new Date().toISOString();fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  }
  console.log(JSON.stringify({status:report.status,output,summary:report.summary,checks:report.checks,cleanup:report.cleanup},null,2));
  if(failed)throw new Error('Context evaluation failed; inspect its sanitized report.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
