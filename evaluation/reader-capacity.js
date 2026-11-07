// Bounded current-stack baseline. No models, alternate-stack claims or production data.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {fork,execFileSync}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {Client}=require('pg');
const {databasePoolOptions}=require('../scripts/database');
const {validateSnapshot}=require('../scripts/context-snapshot');
const ROOT=path.resolve(__dirname,'..');
const SEED=42,EXECUTION_MS=90000,CLEANUP_MS=10000,HTTP_MS=8000,MAX_RESPONSE=1048576,MAX_HTTP=299;
const CONCURRENCIES=[1,4,12],PER_LEVEL=80,QUERY='容量基准';
const TABLES=['projects','memberships','sources','facts','candidates','revisions','audit','idempotency_requests'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
function random(seed){let n=seed>>>0;return ()=>((n=(Math.imul(n,1664525)+1013904223)>>>0)/4294967296)}
function dataset(){
  const next=random(SEED),alphabet='abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({length:512},(_,i)=>{
    let content='SYNTHETIC CAPACITY SEED 42 ONLY\n';
    while(content.length<1024)content+=alphabet[Math.floor(next()*alphabet.length)];
    return {project_id:i<256?1:2,subject:QUERY+String(i).padStart(4,'0'),predicate:'状态',
      value:'synthetic-'+Math.floor(next()*0xffffffff).toString(16).padStart(8,'0'),title:'容量来源'+String(i).padStart(4,'0'),
      content,actor_id:i<256?1:4};
  });
}
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
function directClient(url){return new Client({...databasePoolOptions(url),connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:6000})}
async function rowCounts(client){
  const result={};for(const table of TABLES)result[table]=Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);return result;
}
async function initialize(owner,records){
  const json=JSON.stringify(records);
  await owner.query('BEGIN');
  try{
    await owner.query(`INSERT INTO sources(project_id,title,content)
      SELECT project_id,title,content FROM jsonb_to_recordset($1::jsonb) AS r(project_id int,title text,content text)`,[json]);
    await owner.query(`INSERT INTO facts(project_id,subject,predicate)
      SELECT project_id,subject,predicate FROM jsonb_to_recordset($1::jsonb) AS r(project_id int,subject text,predicate text)`,[json]);
    await owner.query(`INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by,status)
      SELECT r.project_id,r.subject,r.predicate,r.value,s.id,0,r.actor_id,'approved'
      FROM jsonb_to_recordset($1::jsonb) AS r(project_id int,subject text,predicate text,value text,title text,actor_id int)
      JOIN sources s ON s.project_id=r.project_id AND s.title=r.title`,[json]);
    await owner.query(`INSERT INTO revisions(project_id,fact_id,version,value,source_id,candidate_id,approved_by)
      SELECT f.project_id,f.id,1,c.value,c.source_id,c.id,c.proposed_by FROM facts f
      JOIN candidates c ON c.project_id=f.project_id AND c.subject=f.subject AND c.predicate=f.predicate
      WHERE starts_with(f.subject,$1)`,[QUERY]);
    await owner.query(`UPDATE facts f SET version=1,current_revision_id=r.id FROM revisions r
      WHERE r.fact_id=f.id AND starts_with(f.subject,$1)`,[QUERY]);
    await owner.query(`INSERT INTO audit(project_id,actor_id,action,detail)
      SELECT project_id,proposed_by,'fixture-approved','Explicit schema-owner synthetic initialization'
      FROM candidates WHERE starts_with(subject,$1)`,[QUERY]);
    await owner.query('COMMIT');
  }catch(error){await owner.query('ROLLBACK').catch(()=>{});throw error}
  await owner.query('ANALYZE');
}

async function main(){
  if(!process.env.CAPACITY_DATABASE_URL)throw fail('CAPACITY_DATABASE_URL_REQUIRED');
  let adminURL;try{adminURL=new URL(process.env.CAPACITY_DATABASE_URL)}catch{throw fail('INVALID_LOCAL_ADMIN_URL')}
  const probe=directClient(adminURL.href);
  if(!['127.0.0.1','localhost','::1','[::1]'].includes(probe.host))throw fail('LOCAL_TEST_POSTGRES_REQUIRED');
  const output=path.resolve(process.env.CAPACITY_OUTPUT||path.join(ROOT,'artifacts/reader-capacity',`run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`));
  fs.mkdirSync(output,{recursive:true});
  for(const file of ['requests.jsonl','resources.jsonl','report.json'])if(fs.existsSync(path.join(output,file)))throw fail('FRESH_OUTPUT_REQUIRED');
  const started=performance.now(),abort=new AbortController(),database='memz_capacity_'+crypto.randomBytes(8).toString('hex');
  const records=dataset(),samples=[],resources=[],controls=new Map(),cookies=new Map(),csrf=new Map();
  const trackedSources=['server.js','idempotency.js','db/schema.sql','scripts/database.js','scripts/session-store.js','scripts/server-lifecycle.js','scripts/context-snapshot.js','scripts/search-query.js','evaluation/reader-capacity.js','evaluation/fixtures/reader-capacity-child.js'];
  const report={schema:'memz-reader-capacity-v1',synthetic:true,status:'running',startedAt:new Date().toISOString(),
    source:{commit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{cwd:ROOT,encoding:'utf8'}).trim(),
      files:Object.fromEntries(trackedSources.map(file=>[file,hash(fs.readFileSync(path.join(ROOT,file)))]))},
    method:{seed:SEED,concurrencies:CONCURRENCIES,measuredPerLevel:PER_LEVEL,closedLoop:true,
      timing:'Direct HTTP, full body consumption, JSON parsing and snapshot validation; login/logout excluded from reader timings and counted separately.',
      workload:'Same seeded sequence of five first/deeper current-snapshot pages at every level, 25 facts and distinct 1KiB sources per page.',
      cache:'Fresh-process first read recorded separately. Fixture creation and ANALYZE have already touched PostgreSQL/OS caches; no cold-cache claim.',
      tail:'80 samples per level: nearest-rank p99 is the observed maximum; not a stable tail estimate or SLO.',
      load:'Closed-loop workers with no think time; coordinated omission limits tail/load interpretation. Not maximum sustainable capacity.',
      resources:'Child-only RSS/cumulative CPU and pool counts sampled at 100ms plus phase boundaries. Sampled maxima are not continuous peaks; PostgreSQL/load-generator memory excluded.',
      comparison:'Current stack only; no alternate stack or disabled-protection control, so neither migration gains nor protection overhead are inferred.',
      rawFiles:{requests:'requests.jsonl',resources:'resources.jsonl'},limits:{executionMs:EXECUTION_MS,cleanupMs:CLEANUP_MS,httpMs:HTTP_MS,maxResponseBytes:MAX_RESPONSE,maxHttpRequests:MAX_HTTP},modelCalls:0},
    environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,
      loadAverageStart:os.loadavg(),noiseNote:process.env.CAPACITY_NOISE_NOTE||'External workload isolation was not independently established.'},
    fixture:{approval:'Original synthetic records explicitly initialized as approved by schema owner, only in a random temporary database; not real data or automatic extraction.',
      generatedRows:records.length,generationSha256:hash(JSON.stringify(records)),sourceBodyBytes:records.reduce((n,r)=>n+Buffer.byteLength(r.content),0)},
    phases:[],checks:{},cleanup:{childExited:false,ownerClosed:false,temporaryDatabaseDropped:false,adminClosed:false}};
  let admin=probe,owner,child,childExit,childExited=false,readyInfo,created=false,httpCount=0,controlId=0,timer,failure,childLogs=0;
  const logResource=value=>{
    const row={receivedAtMs:performance.now()-started,...value};resources.push(row);
    fs.appendFileSync(path.join(output,'resources.jsonl'),JSON.stringify(row)+'\n');
  };
  const check=()=>{if(abort.signal.aborted)throw fail('EXECUTION_DEADLINE')};
  const deadline=()=>{
    abort.abort();child?.kill('SIGTERM');
    for(const client of [owner,admin])client?.connection?.stream?.destroy();
  };
  const control=(command,phase)=>new Promise((resolve,reject)=>{
    check();const id=++controlId;
    const timeout=setTimeout(()=>{controls.delete(id);reject(fail('CHILD_CONTROL_TIMEOUT'))},8000);
    controls.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value)},reject:error=>{clearTimeout(timeout);reject(error)}});
    child.send({id,command,...(phase?{phase}:{})},error=>{if(error){controls.delete(id);clearTimeout(timeout);reject(fail('CHILD_CHANNEL_CLOSED'))}});
  });
  async function request({phase,worker=0,index=0,path:route,method='GET',body,account='viewer',expected=200,expectedPage}){
    check();if(httpCount>=MAX_HTTP)throw fail('HTTP_BUDGET_EXCEEDED');httpCount++;
    const row={id:httpCount,phase,worker,index,method,kind:route.includes('/context?')?'reader':'authentication',expectedStatus:expected,
      startedAtMs:performance.now()-started,status:null,receivedBytes:0,responseSha256:null,bodyComplete:false,valid:false,errorCode:null};
    const digest=crypto.createHash('sha256'),chunks=[],signal=AbortSignal.any([abort.signal,AbortSignal.timeout(HTTP_MS)]);
    try{
      const response=await fetch(readyInfo.baseURL+route,{method,headers:{...(cookies.has(account)?{cookie:cookies.get(account)}:{}),
        ...(csrf.has(account)?{'x-csrf-token':csrf.get(account)}:{}),...(body?{'content-type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{}),signal});
      row.status=response.status;
      const reader=response.body.getReader();
      try{while(true){const {done,value}=await reader.read();if(done)break;row.receivedBytes+=value.byteLength;digest.update(value);
        if(row.receivedBytes>MAX_RESPONSE){await reader.cancel();throw fail('RESPONSE_LIMIT')};chunks.push(value);}}
      finally{reader.releaseLock()}
      row.bodyComplete=true;row.httpCompleteMs=performance.now()-started-row.startedAtMs;
      const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(response.status!==expected)throw fail('UNEXPECTED_HTTP_STATUS');
      if(row.kind==='reader'&&expected===200){
        validateSnapshot(parsed,{projectId:1,query:QUERY,limit:25,after:expectedPage.after,search:null});
        assert.deepEqual(parsed.facts.map(f=>[f.id,f.subject,f.predicate,f.value,f.version,f.sourceId]),expectedPage.facts);
        assert.deepEqual(parsed.sources.map(s=>[s.id,s.title,hash(s.content)]),expectedPage.sources);
        assert.equal(parsed.next_after,expectedPage.nextAfter);
        assert.equal(parsed.role,'viewer');row.facts=parsed.facts.length;row.after=expectedPage.after;
      }else if(row.kind==='reader'&&expected===503){
        if(parsed.error!=='数据库请求超时，请稍后重试')throw fail('UNEXPECTED_ERROR_BODY');
      }else if(row.kind==='reader'&&expected===403){
        if(typeof parsed.error!=='string'||Object.keys(parsed).length!==1)throw fail('UNEXPECTED_ERROR_BODY');
      }else if(route==='/api/login'){
        const cookie=response.headers.get('set-cookie')?.split(';')[0];
        if(typeof parsed.csrf!=='string'||!cookie)throw fail('INVALID_LOGIN_RESPONSE');
        cookies.set(account,cookie);csrf.set(account,parsed.csrf);
      }
      row.valid=true;
    }catch(error){
      row.errorCode=signal.aborted?(abort.signal.aborted?'EXECUTION_DEADLINE':'HTTP_DEADLINE'):
        ['RESPONSE_LIMIT','UNEXPECTED_HTTP_STATUS','UNEXPECTED_ERROR_BODY','INVALID_LOGIN_RESPONSE','INVALID_SNAPSHOT_RESPONSE'].includes(error.code)?error.code:
          error.name==='AssertionError'?'FIXTURE_MISMATCH':error.name==='SyntaxError'?'INVALID_JSON':'HTTP_FAILED';
    }finally{
      row.elapsedMs=performance.now()-started-row.startedAtMs;row.responseSha256=digest.digest('hex');
      samples.push(row);fs.appendFileSync(path.join(output,'requests.jsonl'),JSON.stringify(row)+'\n');
    }
    return row;
  }
  const validate=rows=>{if(rows.some(row=>!row.valid))throw fail('SAMPLE_VALIDATION_FAILED')};
  async function phase(name,concurrency,count,pages,expected=200){
    check();await control('phase',name);
    const entry={name,concurrency,planned:count,startedAtMs:performance.now()-started};report.phases.push(entry);
    const next=random(SEED),sequence=Array.from({length:count},()=>Math.floor(next()*pages.length));let index=0;
    try{
      const workers=await Promise.allSettled(Array.from({length:concurrency},async(_,worker)=>{
        while(index<count&&!abort.signal.aborted){const i=index++,page=pages[sequence[i]];
          await request({phase:name,worker,index:i,path:`/api/projects/1/context?q=${encodeURIComponent(QUERY)}&limit=25&after=${page.after}`,expected,expectedPage:page});}
      }));
      entry.measurementFinishedAtMs=performance.now()-started;
      const rejected=workers.find(worker=>worker.status==='rejected');if(rejected)throw rejected.reason;
      await control('sample');
    }finally{
      entry.finishedAtMs=performance.now()-started;
      entry.measurementFinishedAtMs??=entry.finishedAtMs;
      const rows=samples.filter(row=>row.phase===name),success=rows.filter(row=>row.status===200&&row.valid),elapsed=(entry.measurementFinishedAtMs-entry.startedAtMs)/1000;
      const resourceRows=resources.filter(row=>row.phase===name),first=resourceRows[0],last=resourceRows.at(-1);
      Object.assign(entry,{attempted:rows.length,valid:rows.filter(row=>row.valid).length,httpErrors:rows.filter(row=>row.status>=400).length,
      resources:{samples:resourceRows.length,sampledMaxRssBytes:resourceRows.length?Math.max(...resourceRows.map(r=>r.rssBytes)):null,
        sampledMaxPoolTotal:resourceRows.length?Math.max(...resourceRows.map(r=>r.pool.total)):null,
        sampledMaxPoolWaiting:resourceRows.length?Math.max(...resourceRows.map(r=>r.pool.waiting)):null,
        childCpuUserUs:first&&last?last.cpu.user-first.cpu.user:null,childCpuSystemUs:first&&last?last.cpu.system-first.cpu.system:null},
      statusCounts:rows.reduce((a,r)=>(a[r.status??'transport_error']=(a[r.status??'transport_error']||0)+1,a),{}),
      errorCounts:rows.filter(r=>r.errorCode).reduce((a,r)=>(a[r.errorCode]=(a[r.errorCode]||0)+1,a),{}),
      completionsPerSecond:rows.length/elapsed,valid200PerSecond:success.length/elapsed,
      latencyAllMs:{n:rows.length,p50:percentile(rows.map(r=>r.elapsedMs),.5),p95:percentile(rows.map(r=>r.elapsedMs),.95),p99:percentile(rows.map(r=>r.elapsedMs),.99),max:rows.length?Math.max(...rows.map(r=>r.elapsedMs)):null},
      latencyValid200Ms:{n:success.length,p50:percentile(success.map(r=>r.elapsedMs),.5),p95:percentile(success.map(r=>r.elapsedMs),.95),p99:percentile(success.map(r=>r.elapsedMs),.99)}});
    }
    const completed=samples.filter(row=>row.phase===name);validate(completed);if(completed.length!==count)throw fail('PHASE_INCOMPLETE');
  }
  try{
    timer=setTimeout(deadline,Math.max(1,EXECUTION_MS-(performance.now()-started)));admin.on('error',()=>{});await admin.connect();check();
    report.environment.postgres=(await admin.query('SHOW server_version')).rows[0].server_version;
    report.environment.postgresMaxConnections=Number((await admin.query('SHOW max_connections')).rows[0].max_connections);
    await admin.query(`CREATE DATABASE ${database}`);created=true;check();
    const ownerURL=new URL(adminURL);ownerURL.pathname='/'+database;owner=directClient(ownerURL.href);owner.on('error',()=>{});await owner.connect();
    await owner.query(fs.readFileSync(path.join(ROOT,'db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    report.fixture.builtinCounts=await rowCounts(owner);await initialize(owner,records);check();
    report.fixture.actualTotalCounts=await rowCounts(owner);
    const actual=(await owner.query(`SELECT f.project_id,f.subject,f.predicate,r.value,s.title,s.content,c.proposed_by AS actor_id
      FROM facts f JOIN revisions r ON r.id=f.current_revision_id JOIN sources s ON s.id=r.source_id JOIN candidates c ON c.id=r.candidate_id
      WHERE starts_with(f.subject,$1) ORDER BY f.subject`,[QUERY])).rows;
    assert.deepEqual(actual,records);report.fixture.actualGeneratedDataSha256=hash(JSON.stringify(actual));
    const rows=(await owner.query(`SELECT f.id,f.subject,f.predicate,r.value,f.version,s.id AS source_id,s.title,s.content FROM facts f
      JOIN revisions r ON r.id=f.current_revision_id JOIN sources s ON s.id=r.source_id
      WHERE f.project_id=1 AND starts_with(f.subject,$1) ORDER BY f.id`,[QUERY])).rows;
    assert.equal(rows.length,256);
    const pages=[0,49,99,149,199].map(position=>{
      const after=position===0?0:rows[position].id,selected=rows.filter(row=>row.id>after).slice(0,25);
      return {after,facts:selected.map(r=>[r.id,r.subject,r.predicate,r.value,r.version,r.source_id]),
        sources:selected.map(r=>[r.source_id,r.title,hash(r.content)]),nextAfter:selected.at(-1).id};
    });
    report.fixture.workloadPages=pages.map(({after,facts})=>({after,factIds:facts.map(f=>f[0])}));
    report.environment.otherDatabaseActivityBefore=(await owner.query(`SELECT count(*)::int AS connections,
      count(*) FILTER(WHERE state='active')::int AS active FROM pg_stat_activity WHERE datname IS NOT NULL AND datname<>current_database()`)).rows[0];
    const appURL=new URL('postgres://memz_app:memz_demo_only@127.0.0.1/memz');
    appURL.hostname=probe.host;appURL.port=String(probe.port);appURL.pathname='/'+database;appURL.searchParams.set('sslmode','disable');
    child=fork(path.join(ROOT,'evaluation/fixtures/reader-capacity-child.js'),[],{cwd:ROOT,env:{...process.env,DATABASE_URL:appURL.href},stdio:['ignore','ignore','pipe','ipc']});
    childExit=new Promise(resolve=>child.once('close',()=>{childExited=true;for(const pending of controls.values())pending.reject(fail('CHILD_EXITED'));controls.clear();resolve()}));
    child.stderr.on('data',bytes=>{childLogs+=bytes.length});
    readyInfo=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(fail('CHILD_STARTUP_TIMEOUT')),8000);
      child.once('error',()=>{clearTimeout(timeout);reject(fail('CHILD_STARTUP_FAILED'))});
      child.once('exit',()=>{clearTimeout(timeout);reject(fail('CHILD_STARTUP_FAILED'))});
      child.on('message',message=>{
        if(message.type==='ready'){clearTimeout(timeout);resolve(message)}
        else if(message.type==='resource')logResource(message);
        else if(message.type==='control'){
          if(message.resource)logResource(message.resource);
          const pending=controls.get(message.id);controls.delete(message.id);
          if(pending)message.ok?pending.resolve(message.resource):pending.reject(fail('CHILD_CONTROL_FAILED'));
        }
      });
    });report.environment.applicationLimits=readyInfo.limits;
    for(const account of ['viewer','other'])validate([await request({phase:'login',path:'/api/login',method:'POST',account,body:{username:account,password:'demo-'+account}})]);
    await phase('fresh_process_first_read',1,1,pages);
    for(const concurrency of CONCURRENCIES){await phase('warmup_'+concurrency,concurrency,concurrency,pages);await phase('measured_'+concurrency,concurrency,PER_LEVEL,pages)}
    await control('phase','pool_saturation_setup');const held=await control('hold');assert.equal(held.pool.held,10);
    try{await phase('pool_saturation',6,6,pages,503)}finally{if(!abort.signal.aborted)await control('release')}
    await phase('same_session_recovery',6,12,pages);
    validate([await request({phase:'rls',path:`/api/projects/2/context?q=${encodeURIComponent(QUERY)}&limit=25`,expected:403}),
      await request({phase:'rls',path:`/api/projects/1/context?q=${encodeURIComponent(QUERY)}&limit=25`,account:'other',expected:403})]);
    report.environment.otherDatabaseActivityAfter=(await owner.query(`SELECT count(*)::int AS connections,
      count(*) FILTER(WHERE state='active')::int AS active FROM pg_stat_activity WHERE datname IS NOT NULL AND datname<>current_database()`)).rows[0];
    assert.deepEqual(await rowCounts(owner),report.fixture.actualTotalCounts);
    for(const account of ['viewer','other'])validate([await request({phase:'logout',path:'/api/logout',method:'POST',account})]);
    report.checks={fixtureUnchanged:true,rawRequests:samples.length,httpRequests:httpCount,readerRequests:samples.filter(r=>r.kind==='reader').length,
      unexpectedSamples:samples.filter(r=>!r.valid).length,expected503:samples.filter(r=>r.status===503).length,rls403:samples.filter(r=>r.status===403).length};
    report.status='passed';
  }catch(error){failure=error;report.status='failed';report.errorCode=error.code&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'CAPACITY_RUN_FAILED'}
  finally{
    clearTimeout(timer);report.executionMs=performance.now()-started;abort.abort();
    const cleanupStarted=performance.now();let cleanupTimer,cleanupExpired=false;
    const checkCleanup=()=>{if(cleanupExpired||performance.now()-cleanupStarted>=CLEANUP_MS)throw fail('CLEANUP_DEADLINE')};
    const cleanup=async()=>{
      checkCleanup();
      if(child&&!childExited){child.kill('SIGTERM');let killTimer;try{await Promise.race([childExit,new Promise(resolve=>{killTimer=setTimeout(()=>{child.kill('SIGKILL');childExit.then(resolve)},2000)})])}finally{clearTimeout(killTimer)}}
      checkCleanup();
      report.cleanup.childExited=!child||childExited;
      if(owner){await owner.end();report.cleanup.ownerClosed=true}else report.cleanup.ownerClosed=true;
      checkCleanup();
      if(admin){await admin.end().catch(()=>{});admin=null;checkCleanup()}
      if(created){
        checkCleanup();
        const cleaner=directClient(adminURL.href);cleaner.on('error',()=>{});admin=cleaner;
        checkCleanup();await cleaner.connect();checkCleanup();
        await cleaner.query(`DROP DATABASE ${database} WITH (FORCE)`);checkCleanup();report.cleanup.temporaryDatabaseDropped=true;
        await cleaner.end();checkCleanup();admin=null;
      }
      report.cleanup.adminClosed=true;
    };
    try{await Promise.race([cleanup(),new Promise((_,reject)=>{cleanupTimer=setTimeout(()=>{
      cleanupExpired=true;
      child?.kill('SIGKILL');owner?.connection?.stream?.destroy();admin?.connection?.stream?.destroy();reject(fail('CLEANUP_DEADLINE'));
    },CLEANUP_MS)})]);}
    catch{report.status='failed';report.cleanup.errorCode='CLEANUP_FAILED';failure=failure||fail('CLEANUP_FAILED')}
    finally{clearTimeout(cleanupTimer)}
    report.cleanup.elapsedMs=performance.now()-cleanupStarted;report.environment.loadAverageEnd=os.loadavg();report.environment.childDiagnosticBytes=childLogs;
    report.actualHttpRequests=httpCount;report.rawSampleCount=samples.length;report.finishedAt=new Date().toISOString();
    report.resourceSummary={samples:resources.length,sampledMaxRssBytes:resources.length?Math.max(...resources.map(r=>r.rssBytes)):null,
      sampledMaxPoolTotal:resources.length?Math.max(...resources.map(r=>r.pool.total)):null,sampledMaxPoolWaiting:resources.length?Math.max(...resources.map(r=>r.pool.waiting)):null};
    report.rawFiles={};for(const file of ['requests.jsonl','resources.jsonl']){
      if(!fs.existsSync(path.join(output,file)))fs.writeFileSync(path.join(output,file),'',{flag:'wx'});
      const bytes=fs.readFileSync(path.join(output,file));report.rawFiles[file]={bytes:bytes.length,sha256:hash(bytes)};
    }
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  }
  console.log(JSON.stringify({status:report.status,httpRequests:httpCount,executionMs:report.executionMs,cleanup:report.cleanup,output}));
  if(failure)process.exitCode=1;
}
if(require.main===module)main().catch(()=>{console.error('CAPACITY_SETUP_FAILED');process.exitCode=1});
module.exports={dataset,random,percentile};
