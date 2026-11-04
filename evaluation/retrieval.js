// Run against a disposable database; never seed the supplied administrator DB.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {Client}=require('pg');
const fixtureBytes=fs.readFileSync('evaluation/retrieval-cases.json');
const fixture=JSON.parse(fixtureBytes);
const checksum=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const repeats=10,warmups=2;
const fillerCount=process.env.EVALUATION_FILLER_COUNT===undefined?fixture.fillerCount:Number(process.env.EVALUATION_FILLER_COUNT);
if(!Number.isInteger(fillerCount)||fillerCount<200||fillerCount>5000)throw new Error('EVALUATION_FILLER_COUNT must be an integer from 200 to 5000.');
const tuple=f=>[f.subject,f.predicate,f.value];
const ordered=rows=>rows.map(tuple).map(JSON.stringify).sort();
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
async function main(){
  if(!process.env.EVALUATION_DATABASE_URL)throw new Error('Set EVALUATION_DATABASE_URL to an initialized test PostgreSQL administrator connection.');
  const admin=new Client({connectionString:process.env.EVALUATION_DATABASE_URL});
  await admin.connect();
  const db=`memz_eval_${crypto.randomBytes(8).toString('hex')}`;
  let owner,pool,server,created=false;
  try{
    assert.equal((await admin.query("SELECT 1 FROM pg_roles WHERE rolname='memz_app'")).rowCount,1,'Initialize the demo schema once to create memz_app');
    await admin.query(`CREATE DATABASE ${db}`);created=true;
    const url=new URL(process.env.EVALUATION_DATABASE_URL);url.pathname=`/${db}`;
    owner=new Client({connectionString:url.href});await owner.connect();
    await owner.query(fs.readFileSync('db/schema.sql','utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    url.username='memz_app';url.password='memz_demo_only';
    process.env.DATABASE_URL=url.href;
    const service=require('../server');pool=service.pool;
    const {tx,decide}=service;
    const known={seed:fixture.seed};
    async function propose(f,{user=1,project=1,version=0,decision='approve',source=2}={}){
      return tx(user,async c=>{
        const r=await c.query(`INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[project,f.subject,f.predicate,f.value,source,version,user]);
        if(decision)await decide(c,user,project,r.rows[0].id,decision);
      });
    }
    for(const f of fixture.facts){
      if(f.previous)await propose({...f,value:f.previous});
      await propose(f,{version:f.previous?1:0});known[f.key]=f;
    }
    for(let i=0;i<fillerCount;i++){
      const f={subject:`评测条目${String(i).padStart(4,'0')}`,predicate:'描述',value:`合成记忆 ${i}`};
      await propose(f);known[`filler-${i}`]=f;
    }
    await propose({subject:'评测待审',predicate:'状态',value:'待审专用词'},{decision:null});
    await propose({subject:'评测驳回',predicate:'状态',value:'驳回专用词'},{decision:'reject'});
    await tx(1,c=>c.query("INSERT INTO sources(project_id,title,content) VALUES(1,'合成来源','来源正文专用词')"));
    const allProject1=Object.values(known);
    known.isolated=fixture.isolated;
    await propose(known.isolated,{user:4,project:2,source:4});
    server=await new Promise(resolve=>{const s=service.app.listen(0,'127.0.0.1',()=>resolve(s))});
    const base=`http://127.0.0.1:${server.address().port}`;
    const cookies={};
    for(const user of ['owner','viewer','other']){
      const r=await fetch(`${base}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:user,password:`demo-${user}`})});
      assert.equal(r.status,200);cookies[user]=r.headers.get('set-cookie').split(';')[0];await r.json();
    }
    const contextResponse=await fetch(`${base}/api/projects/1/data?include_facts=false`,{headers:{cookie:cookies.owner}});
    assert.equal(contextResponse.status,200);
    const contextRaw=await contextResponse.text(),context=JSON.parse(contextRaw);
    const contextScale={aggregateBytes:Buffer.byteLength(contextRaw),sections:Object.fromEntries(['sources','candidates','history','audit'].map(key=>[key,{rows:context[key].length,jsonArrayBytes:Buffer.byteLength(JSON.stringify(context[key]))}]))};
    async function readHistoryMeasurement(path){
      const response=await fetch(`${base}/api/projects/1/${path}`,{headers:{cookie:cookies.owner}});
      assert.equal(response.status,200);const raw=await response.text();return {body:JSON.parse(raw),bytes:Buffer.byteLength(raw)};
    }
    const reduced=await readHistoryMeasurement('data?include_facts=false&include_history=false');
    const firstHistory=await readHistoryMeasurement('history?limit=25');
    const {history:allHistory,...contextRest}=context;assert.deepEqual(reduced.body,contextRest);
    assert.deepEqual(firstHistory.body.history.map(({id,...row})=>row),allHistory.slice(0,25));
    assert.ok(firstHistory.body.history.length<=25);
    contextScale.withoutHistoryBytes=reduced.bytes;contextScale.historyFirstPageBytes=firstHistory.bytes;
    contextScale.historyFirstPageRows=firstHistory.body.history.length;
    contextScale.initialCombinedBytes=reduced.bytes+firstHistory.bytes;
    const candidateContext=await readHistoryMeasurement('data?include_facts=false&include_history=false&include_candidates=false');
    const firstCandidates=await readHistoryMeasurement('candidates?limit=25');
    const {candidates:allCandidates,...remainingContext}=reduced.body;
    assert.deepEqual(candidateContext.body,remainingContext);
    assert.deepEqual(firstCandidates.body.candidates,allCandidates.slice(0,25));
    assert.ok(firstCandidates.body.candidates.length<=25);
    const candidateScale={contextBytes:candidateContext.bytes,firstPageBytes:firstCandidates.bytes,firstPageRows:firstCandidates.body.candidates.length,
      contextWithHistoryAndCandidateBytes:candidateContext.bytes+firstHistory.bytes+firstCandidates.bytes};
    async function pagedFacts(item){
      const facts=[],seen=new Set();let after=0,pages=0,totalBytes=0,firstPageBytes,maxRows=0,status;
      while(true){
        const response=await fetch(`${base}/api/projects/${item.project||1}/facts?q=${encodeURIComponent(item.query)}&limit=50&after=${after}`,{headers:{cookie:cookies[item.user||'owner']}});
        const raw=await response.text(),body=JSON.parse(raw),bytes=Buffer.byteLength(raw);status=response.status;
        pages++;totalBytes+=bytes;if(pages===1)firstPageBytes=bytes;
        assert.equal(status,item.status||200);
        if(status!==200)break;
        assert.deepEqual(Object.keys(body).sort(),['facts','next_after','role']);
        assert.ok(body.facts.length<=50);maxRows=Math.max(maxRows,body.facts.length);
        for(const fact of body.facts){assert.ok(fact.id>after);assert.ok(!seen.has(fact.id));seen.add(fact.id);after=fact.id;facts.push(fact)}
        if(body.next_after===null)break;
        assert.ok(body.facts.length>0);assert.equal(body.next_after,after);assert.ok(pages<200);
      }
      return {facts,summary:{status,pages,firstPageBytes,totalBytes,maxRows,factsCount:facts.length}};
    }
    const results=[];
    for(const item of fixture.cases){
      const expected=item.expected==='all-project-1'?allProject1:(item.expected||[]).map(key=>{assert.ok(known[key],`Unknown expected key ${key}`);return known[key]});
      const samples=[],byteSamples=[];let actualStatus,actualRows,returnedRows,passed=true,error;
      for(let i=0;i<warmups+repeats;i++){
        const start=performance.now();
        const r=await fetch(`${base}/api/projects/${item.project||1}/data?q=${encodeURIComponent(item.query)}`,{headers:{cookie:cookies[item.user||'owner']}});
        const raw=await r.text(),body=JSON.parse(raw);const elapsed=performance.now()-start;
        if(i>=warmups){samples.push(elapsed);byteSamples.push(Buffer.byteLength(raw))}
        returnedRows=Object.fromEntries(['facts','sources','candidates','history','audit'].map(key=>[key,Array.isArray(body[key])?body[key].length:0]));
        actualStatus=r.status;actualRows=Array.isArray(body.facts)?body.facts:[];
        try{assert.equal(r.status,item.status||200);if(r.status===200)assert.deepEqual(ordered(actualRows),ordered(expected))}
        catch(e){passed=false;error=e.message}
      }
      let paged;
      try{
        const result=await pagedFacts(item);paged=result.summary;
        if(result.summary.status===200)assert.deepEqual(ordered(result.facts),ordered(expected));
      }catch(e){passed=false;error=e.message;paged={...paged,error:e.message}}
      results.push({name:item.name,query:item.query,user:item.user||'owner',project:item.project||1,passed,
        expectedStatus:item.status||200,actualStatus,paged,returnedRows,responseBytes:{min:Math.min(...byteSamples),max:Math.max(...byteSamples)},expected:expected.map(tuple),actual:actualRows.map(tuple),
        latencyMs:{samples:samples.length,rawSamples:samples,median:percentile(samples,0.5),p95:percentile(samples,0.95),min:Math.min(...samples),max:Math.max(...samples)},...(error?{error}:{})});
    }
    const counts={};for(const table of ['facts','revisions','candidates','sources'])counts[table]=Number((await owner.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
    const sourceCount=process.env.EVALUATION_SOURCE_COUNT===undefined?200:Number(process.env.EVALUATION_SOURCE_COUNT);
    assert.ok(Number.isInteger(sourceCount)&&sourceCount>=25&&sourceCount<=1000,'EVALUATION_SOURCE_COUNT must be an integer from 25 to 1000');
    // Separate source-growth scenario after the fixed retrieval dataset was measured.
    await tx(1,c=>c.query("INSERT INTO sources(project_id,title,content) SELECT 1,'规模来源'||lpad(n::text,4,'0'),repeat('测',4000) FROM generate_series(1,$1::int) n",[sourceCount]));
    const sourcesFull=await readHistoryMeasurement('data?include_facts=false&include_history=false&include_candidates=false');
    const sourcesOmitted=await readHistoryMeasurement('data?include_facts=false&include_history=false&include_candidates=false&include_sources=false');
    const {sources:expectedSources,...sourceRest}=sourcesFull.body;assert.deepEqual(sourcesOmitted.body,sourceRest);
    const sourceRows=[];let sourceAfter=0,sourcePages=0,sourceFirstBytes;
    do{
      const page=await readHistoryMeasurement(`sources?limit=25&after=${sourceAfter}`);sourcePages++;
      if(sourcePages===1)sourceFirstBytes=page.bytes;
      assert.ok(page.body.sources.length<=25);
      for(const row of page.body.sources){assert.ok(row.id>sourceAfter);sourceAfter=row.id;sourceRows.push(row)}
      if(page.body.next_after===null)break;
      assert.equal(page.body.next_after,sourceAfter);assert.ok(sourcePages<100);
    }while(true);
    assert.deepEqual(sourceRows,expectedSources);
    const sourceScale={scenario:'additional synthetic sources after retrieval cases',addedSources:sourceCount,charactersPerAddedBody:4000,projectSources:sourceRows.length,pages:sourcePages,
      aggregateBytes:sourcesFull.bytes,withoutSourcesBytes:sourcesOmitted.bytes,firstPageBytes:sourceFirstBytes,initialCombinedBytes:sourcesOmitted.bytes+sourceFirstBytes};
    const report={schemaVersion:2,dataset:fixture.dataset,fillerCount,synthetic:true,generatedAt:new Date().toISOString(),
      source:{gitCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
        datasetSha256:checksum(fixtureBytes),serverSha256:checksum(fs.readFileSync('server.js')),idempotencySha256:checksum(fs.readFileSync('idempotency.js')),runnerSha256:checksum(fs.readFileSync(__filename))},
      environment:{node:process.version,postgres:(await owner.query('SHOW server_version')).rows[0].server_version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model},
      method:{transport:'HTTP localhost including full project response JSON parsing',concurrency:1,warmupsPerCase:warmups,measuredRequestsPerCase:repeats,
        percentile:'nearest rank',note:'Legacy aggregate timings only. Paged endpoint is traversed once per case for correctness and JSON byte counts; no timing comparison or production/load claims.'},
      counts,contextScale,candidateScale,sourceScale,passed:results.every(r=>r.passed),passedCases:results.filter(r=>r.passed).length,totalCases:results.length,cases:results};
    fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/retrieval-report.json',JSON.stringify(report,null,2)+'\n');
    console.log(`Retrieval evaluation: ${report.passedCases}/${report.totalCases} cases passed; ${counts.facts} current facts. Report: artifacts/retrieval-report.json`);
    assert.ok(report.passed,'Retrieval evaluation failed; inspect the report');
  }finally{
    if(server)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    if(pool)await pool.end();if(owner)await owner.end();
    if(created)await admin.query(`DROP DATABASE ${db}`);
    await admin.end();
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
