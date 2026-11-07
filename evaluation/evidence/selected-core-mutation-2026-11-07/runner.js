const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process'),Module=require('node:module');
const MAIN='/workspace/memz',NODE='/workspace/.memz-toolchains/node22/bin/node',PIN='947b416de6ac2327fafc6f54d1c28b61646100bc';
const token=Date.now().toString(36)+'_'+crypto.randomBytes(3).toString('hex'),WT='/workspace/memz-mutation-'+token,OUT='/tmp/memz-mutation-audit-'+token;
const req=Module.createRequire(MAIN+'/package.json'),{Client}=req('pg');
const ADMIN='postgres://postgres:postgres_demo_only@127.0.0.1:55432/memz';
const began=Date.now(),deadline=began+15*60*1000,workDeadline=deadline-60000;
const maxBytes=16*1024*1024,reserve=65536;let accumulatedBytes=0,accumulatedHttp=0;
const report={schema:'memz-selected-core-mutation-v1',pin:PIN,node:execFileSync(NODE,['--version'],{encoding:'utf8'}).trim(),started:new Date(began).toISOString(),worktree:WT,evidence:OUT,models:0,baselines:[],mutants:[],ownedDatabases:[],cleanup:[],limit:{wallMs:900000,runMs:90000,http:100,applicationBytes:maxBytes,cleanupReserve:reserve,scope:'SQL UTF8 + JSON parameters/result.rows + HTTP request/response bodies; measured after materialization, not a hard allocation, wire, or heap bound'}};
fs.mkdirSync(OUT,{mode:0o700});fs.copyFileSync(__filename,OUT+'/runner.js');fs.copyFileSync('/tmp/memz-mutation-preload.js',OUT+'/preload.js');
const write=()=>fs.writeFileSync(OUT+'/summary.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
const git=(...args)=>execFileSync('git',args,{cwd:MAIN,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function boundary(){if(Date.now()>workDeadline)throw new Error('AUDIT_WORK_DEADLINE');if(accumulatedHttp>100||accumulatedBytes>maxBytes-reserve)throw new Error('AUDIT_RESOURCE_LIMIT')}
function client(url){const c=new Client({connectionString:url,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:5000});c.on('error',()=>{});return c}
async function control(c,sql,params=[],ack){const result=await c.query(sql,params);if(ack)ack();accumulatedBytes+=Buffer.byteLength(sql)+Buffer.byteLength(JSON.stringify(params))+Buffer.byteLength(JSON.stringify(Array.isArray(result)?result.map(r=>r.rows):result.rows));return result}
async function drop(database){
  if(!report.ownedDatabases.includes(database))throw new Error('UNOWNED_DATABASE');
  const c=client(ADMIN);try{await c.connect();await c.query('DROP DATABASE IF EXISTS '+database+' WITH (FORCE)');report.cleanup.push({database,dropped:true})}finally{await c.end()}
}
const a1='explicit approval commits exactly once, retains full source and immutable prior revisions, and stale versions do not write';
const a2='concurrent creation replays one pending receipt and competing explicit approvals preserve one fact/version';
const b1='sources: revoke after actual HTTP INSERT rolls back the whole creation; explicit reactivation uses the same key once';
const b2='candidates: revoke after actual HTTP INSERT rolls back the whole creation; explicit reactivation uses the same key once';
const c1='a callback that catches its SQL failure cannot turn an aborted PostgreSQL transaction into a success receipt';
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const groups={A:{file:'test/approval-intent-postgres.test.js',names:[a1,a2]},B:{file:'test/membership-write-revocation-postgres.test.js',names:[b1,b2]},C:{file:'test/database-reliability.test.js',names:[c1]}};
async function command(label,group){
  boundary();const prefix=OUT+'/'+label,env={PATH:path.dirname(NODE)+':/usr/bin:/bin',MIGRATION_TEST_DATABASE_URL:ADMIN,AUDIT_WORKTREE:WT,AUDIT_PREFIX:prefix,AUDIT_BYTE_ALLOWANCE:String(maxBytes-reserve-accumulatedBytes),AUDIT_HTTP_ALLOWANCE:String(100-accumulatedHttp)};
  const entry={label,group,selectedTests:groups[group].names,target:groups[group].file,filtering:'Only listed names execute; all other tests are intentionally not selected/omitted, never counted as passes',syntaxValid:true};let externalDB;
  if(group==='C'){
    externalDB='memz_mutation_'+token.replace(/-/g,'_')+'_'+label.toLowerCase();const admin=client(ADMIN);let owner;
    try{await admin.connect();await control(admin,'CREATE DATABASE '+externalDB,[],()=>report.ownedDatabases.push(externalDB));const url=new URL(ADMIN);url.pathname='/'+externalDB;owner=client(url.href);await owner.connect();await control(owner,fs.readFileSync(WT+'/db/schema.sql','utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));env.MIGRATION_TEST_DATABASE_URL=url.href;url.username='memz_app';url.password='memz_demo_only';env.DATABASE_URL=url.href}
    finally{if(owner)await owner.end();await admin.end()}
  }
  const args=['--require',OUT+'/preload.js','--test','--test-reporter=tap','--test-concurrency=1','--test-name-pattern','^('+groups[group].names.map(escape).join('|')+')$',groups[group].file];entry.command=[NODE,...args];
  const out=fs.openSync(prefix+'.tap','wx',0o600),err=fs.openSync(prefix+'.stderr','wx',0o600);let timedOut=false;
  const result=await new Promise(resolve=>{
    const p=spawn(NODE,args,{cwd:WT,env,stdio:['ignore',out,err],detached:true});
    const timer=setTimeout(()=>{timedOut=true;try{process.kill(-p.pid,'SIGTERM')}catch{}setTimeout(()=>{try{process.kill(-p.pid,'SIGKILL')}catch{}},250).unref()},Math.min(90000,Math.max(1,workDeadline-Date.now())));
    p.once('error',()=>{clearTimeout(timer);resolve({code:null,signal:'SPAWN_ERROR'})});p.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal})});
  });fs.closeSync(out);fs.closeSync(err);
  entry.exit=result;entry.timedOut=timedOut;
  const metrics=fs.readdirSync(OUT).filter(file=>file.startsWith(label+'.')&&/\.\d+\.json$/.test(file)).map(file=>JSON.parse(fs.readFileSync(OUT+'/'+file,'utf8')));
  const bytes=metrics.reduce((n,m)=>n+m.totalApplicationBytes,0),http=metrics.reduce((n,m)=>n+m.httpRequests,0);accumulatedBytes+=bytes;accumulatedHttp+=http;
  entry.metrics={processes:metrics.length,applicationBytes:bytes,httpRequests:http,violations:metrics.flatMap(m=>m.violations),unsupported:metrics.reduce((n,m)=>n+m.unsupported,0)};
  const journal=prefix+'.journal.jsonl',events=fs.existsSync(journal)?fs.readFileSync(journal,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  for(const event of events)if(event.kind==='created'&&!report.ownedDatabases.includes(event.database))report.ownedDatabases.push(event.database);
  const nativeDrops=new Set(events.filter(e=>e.kind==='dropped').map(e=>e.database));
  entry.owned=events.filter(e=>e.kind==='created').map(e=>e.database);entry.nativeDropped=[...nativeDrops];
  for(const db of entry.owned)if(!nativeDrops.has(db))await drop(db);
  if(externalDB)await drop(externalDB);
  const text=fs.readFileSync(prefix+'.tap','utf8');entry.counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(key=>[key,Number(text.match(new RegExp('^# '+key+' (\\d+)','m'))?.[1]||0)]));
  entry.failedNames=[...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1]);entry.assertionFailure=/code: 'ERR_ASSERTION'|code: ERR_ASSERTION/.test(text);entry.hookFailure=/failureType: ['"]hookFailed/.test(text);
  entry.resourcesCleaned=entry.owned.every(db=>nativeDrops.has(db)||report.cleanup.some(row=>row.database===db&&row.dropped))&&(!externalDB||report.cleanup.some(row=>row.database===externalDB&&row.dropped));
  for(const artifact of ['artifacts/engine-approval-intent-resources.json'])if(fs.existsSync(WT+'/'+artifact))fs.copyFileSync(WT+'/'+artifact,prefix+'-'+path.basename(artifact));
  boundary();return entry;
}
const mutants=[
  {id:'M1',group:'A',file:'server.js',from:'if(v!==ca.expected_version)',to:'if(false&&v!==ca.expected_version)',expected:a1},
  {id:'M2',group:'A',file:'idempotency.js',from:'if(previous.request_hash!==hash)',to:'if(false&&previous.request_hash!==hash)',expected:a2},
  {id:'M3',group:'B',file:'db/schema.sql',from:'AND active IS TRUE',to:'AND TRUE',expected:b1},
  {id:'M4',group:'C',file:'scripts/database.js',from:"if(committed?.command!=='COMMIT')",to:"if(false&&committed?.command!=='COMMIT')",expected:c1}
];
(async()=>{
  report.mainBefore=git('status','--porcelain');git('worktree','add','--detach',WT,PIN);fs.symlinkSync(MAIN+'/node_modules',WT+'/node_modules','dir');report.baselineHashes=Object.fromEntries(mutants.map(m=>[m.file,hash(WT+'/'+m.file)]));write();
  for(const group of ['A','B','C']){const entry=await command('baseline_'+group,group);report.baselines.push(entry);write();if(entry.exit.code!==0||entry.counts.pass!==groups[group].names.length||entry.metrics.violations.length||entry.metrics.unsupported||!entry.resourcesCleaned)throw new Error('BASELINE_NOT_GREEN')}
  fs.writeFileSync(OUT+'/BASELINES_GREEN','Three selected baseline groups passed; not the entire suites.\n');console.log('BASELINES_GREEN '+OUT);
  for(const m of mutants){
    boundary();const file=WT+'/'+m.file,original=fs.readFileSync(file,'utf8');if(original.split(m.from).length!==2)throw new Error('MUTATION_OCCURRENCE_NOT_ONE');fs.writeFileSync(file,original.replace(m.from,m.to));
    const entry={id:m.id,file:m.file,beforeSha256:report.baselineHashes[m.file],mutantSha256:hash(file),expression:{from:m.from,to:m.to}};
    try{
      fs.writeFileSync(OUT+'/'+m.id+'.patch',execFileSync('git',['diff','--',m.file],{cwd:WT,encoding:'utf8'}));
      if(m.file.endsWith('.js'))execFileSync(NODE,['--check',file],{stdio:'pipe'});
      Object.assign(entry,await command(m.id,m.group));
      const invalid=entry.timedOut||entry.exit.signal||entry.metrics.violations.length||entry.metrics.unsupported||entry.hookFailure||!entry.resourcesCleaned||entry.counts.cancelled;
      entry.classification=invalid?'INVALID':entry.exit.code===0?'SURVIVED':entry.assertionFailure&&entry.failedNames.includes(m.expected)?'KILLED':'INVALID';
    }finally{execFileSync('git',['restore','--source='+PIN,'--worktree','--',m.file],{cwd:WT});entry.restoredSha256=hash(file);entry.restoreMatches=entry.restoredSha256===entry.beforeSha256;report.mutants.push(entry);write();if(!entry.restoreMatches)throw new Error('RESTORE_HASH_MISMATCH')}
  }
})().catch(error=>{report.failure=error.message;process.exitCode=1}).finally(async()=>{
  // Parent cleanup is native and independent of an exhausted child work meter.
  for(const database of report.ownedDatabases)if(!report.cleanup.some(r=>r.database===database&&r.dropped))try{await drop(database)}catch{report.cleanup.push({database,dropped:false});process.exitCode=1}
  report.applicationBytes=accumulatedBytes;report.httpRequests=accumulatedHttp;report.elapsedMs=Date.now()-began;report.finished=new Date().toISOString();
  try{for(const m of mutants)if(fs.existsSync(WT+'/'+m.file))execFileSync('git',['restore','--source='+PIN,'--worktree','--',m.file],{cwd:WT});report.finalDiff=execFileSync('git',['diff','--name-only'],{cwd:WT,encoding:'utf8'}).trim();git('worktree','remove','--force',WT);report.worktreeRemoved=!fs.existsSync(WT)}catch{report.worktreeRemoved=false;process.exitCode=1}
  report.mainAfter=git('status','--porcelain');report.mainFilesUnchanged=report.mainBefore===report.mainAfter;write();console.log(JSON.stringify({evidence:OUT,baseline:report.baselines.map(x=>[x.group,x.exit.code,x.counts]),mutants:report.mutants.map(x=>[x.id,x.classification,x.failedNames]),httpRequests:report.httpRequests,applicationBytes:report.applicationBytes,elapsedMs:report.elapsedMs,worktreeRemoved:report.worktreeRemoved,mainFilesUnchanged:report.mainFilesUnchanged,failure:report.failure}));
});
