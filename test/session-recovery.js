// Opt-in, original synthetic HTTP/Chromium integration. No production hooks.
// The first response loss is deliberately injected AFTER route.fetch sees the
// actual committed result. This is not a network-fault or real-identity claim.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {Client}=require('pg'),{chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..'),WORK_MS=600000,CLEANUP_MS=60000,BYTE_LIMIT=8*1024*1024,CLEANUP_BYTES=65536,MAX_HTTP=64,MAX_BODY=128*1024;
const sourceFiles=['server.js','idempotency.js','db/schema.sql','scripts/database.js','scripts/session-store.js','scripts/server-lifecycle.js','scripts/http-server.js','public/app.js','public/index.html','public/style.css','test/session-recovery.js','package.json','package-lock.json'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const failure=code=>Object.assign(new Error(code),{code});
const check=(condition,code)=>{if(!condition)throw failure(code)};
const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8',env:{PATH:process.env.PATH,GIT_OPTIONAL_LOCKS:'0'}}).trim();
function sourceState(){return {commit:git('rev-parse','HEAD'),workingTreeDirty:!!git('status','--porcelain'),files:Object.fromEntries(sourceFiles.map(file=>[file,hash(fs.readFileSync(path.join(ROOT,file)))]))}}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});promise.catch(()=>{});return {promise,resolve,reject}}
async function main(){
  check(process.env.SESSION_RECOVERY_DATABASE_URL,'SESSION_RECOVERY_DATABASE_URL_REQUIRED');
  const parsed=new URL(process.env.SESSION_RECOVERY_DATABASE_URL);
  check(['postgres:','postgresql:'].includes(parsed.protocol)&&['127.0.0.1','localhost','::1','[::1]'].includes(parsed.hostname),'LOCAL_TEST_DATABASE_REQUIRED');
  const output=path.resolve(process.env.SESSION_RECOVERY_OUTPUT||path.join(ROOT,'artifacts/session-recovery',`run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`));
  fs.mkdirSync(output,{recursive:true,mode:0o700});check(!fs.existsSync(path.join(output,'report.json')),'FRESH_OUTPUT_REQUIRED');
  const started=Date.now(),workEnd=started+WORK_MS,totalEnd=workEnd+CLEANUP_MS,dbName='memz_session_recovery_'+crypto.randomBytes(8).toString('hex');
  const report={schema:'memz-session-recovery-v1',synthetic:true,passed:false,startedAt:new Date(started).toISOString(),ownedDatabase:dbName,source:{before:sourceState()},environment:{node:process.version},
    method:{scenario:'Actual source commit, explicitly synthetic lost HTTP reply, two real CLI processes with fresh memory sessions on one loopback port, same document password-only manual reauthentication and same-key manual replay.',
      scope:'HTTP integration only; fixed public demo identity, no production identity, model, MCP, full UI suite or arbitrary network-fault claim.',transport:'Owned Playwright routing forwards each request exactly once via route.fetch (no redirects/retries), meters actual upstream bytes, then fulfills those bytes to the page. Explicit synthetic loss aborts only after actual upstream 200. Not unmodified native browser transport/cache behavior; native cache has a separate regression.',byteScope:'Parent SQL UTF8/parameter/result.rows JSON, CLI output bytes and HTTP request/response bodies; not file IO, PG wire/server-internal driver traffic, browser-control protocol or heap. Fixed small fixture; accounting after materialization is not a hard allocation bound.'},
    limits:{http:MAX_HTTP,applicationBytes:BYTE_LIMIT,cleanupReserve:CLEANUP_BYTES,responseBodyBytes:MAX_BODY,workMs:WORK_MS,cleanupMs:CLEANUP_MS},http:[],observationFailures:[],processes:[],checks:{},cleanup:{},modelCalls:0};
  let stage='setup',workBytes=0,cleanupBytes=0,cleaning=false,cleanupEnd=totalEnd,fatal=null,admin,owner,dbCreated=false,browserServer,browser,context,page,otherContext,base,firstId,originalKey,initialCookie,initialCsrf;
  const clients=new Set(),processes=new Set(),observations=new Set(),writeKeys=[];
  let navigationCount=0;const loss=deferred();
  const remaining=()=>Math.max(0,(cleaning?cleanupEnd:workEnd)-Date.now());
  const charge=(bytes,cleanup=cleaning,enforce=true)=>{if(cleanup){cleanupBytes+=bytes;if(cleanupBytes>CLEANUP_BYTES){fatal||='CLEANUP_BYTE_LIMIT';if(enforce)throw failure('CLEANUP_BYTE_LIMIT')}}else{workBytes+=bytes;check(workBytes<=BYTE_LIMIT-CLEANUP_BYTES,'WORK_BYTE_LIMIT')}};
  async function bounded(start,ms,code,cancel=()=>{}){
    if(remaining()<=0){try{cancel()}catch{}throw failure(cleaning?'CLEANUP_DEADLINE':'WORK_DEADLINE')}
    let timer;try{return await Promise.race([start(),new Promise((_,reject)=>{timer=setTimeout(()=>{try{cancel()}catch{}reject(failure(code))},Math.min(ms,remaining()))})])}finally{clearTimeout(timer)}
  }
  const destroy=c=>{try{c?.connection?.stream?.destroy()}catch{}};
  async function connect(url){const c=new Client({connectionString:url,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:6000});clients.add(c);c.on('error',()=>{});check(['127.0.0.1','localhost','::1','[::1]'].includes(c.host)&&Number.isInteger(Number(c.port))&&Number(c.port)>0&&Number(c.port)<65536,'LOCAL_RESOLVED_DATABASE_REQUIRED');await bounded(()=>c.connect(),4000,'PG_CONNECT_TIMEOUT',()=>destroy(c));return c}
  async function query(c,sql,params=[],onAck){charge(Buffer.byteLength(sql)+Buffer.byteLength(JSON.stringify(params)));const result=await bounded(()=>c.query(sql,params),7000,'PG_QUERY_TIMEOUT',()=>destroy(c));if(onAck)onAck();charge(Buffer.byteLength(JSON.stringify(Array.isArray(result)?result.map(r=>r.rows):result.rows)));return result}
  async function terminalOwnedQuery(c,sql,params=[],onAck){
    check(cleaning&&(sql==='DROP DATABASE '+dbName+' WITH (FORCE)'||(sql==='SELECT count(*)::int AS n FROM pg_catalog.pg_database WHERE datname=$1'&&params.length===1&&params[0]===dbName)),'UNOWNED_TERMINAL_QUERY');
    // Late output may exhaust the shared cleanup meter. Still execute this
    // known-owned terminal operation, tally actual excess, and fail the run.
    charge(Buffer.byteLength(sql)+Buffer.byteLength(JSON.stringify(params)),true,false);
    const result=await bounded(()=>c.query(sql,params),7000,'PG_TERMINAL_TIMEOUT',()=>destroy(c));if(onAck)onAck();
    charge(Buffer.byteLength(JSON.stringify(result.rows)),true,false);return result;
  }
  async function endClient(c){if(!c)return;try{await bounded(()=>c.end(),1000,'PG_END_TIMEOUT',()=>destroy(c))}finally{destroy(c);clients.delete(c)}}
  async function fingerprint(){const result={};for(const table of ['projects','memberships','sources','facts','candidates','revisions','audit','idempotency_requests'])result[table]=(await query(owner,`SELECT count(*)::int AS rows,md5(COALESCE(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) AS hash FROM ${table} t`)).rows[0];return result}
  function admit(method,route,bodyBytes=0){check(report.http.length<MAX_HTTP,'HTTP_LIMIT');check(bodyBytes<=4096,'HTTP_REQUEST_LIMIT');charge(bodyBytes);const record={id:report.http.length+1,method,path:route,status:null,requestBytes:bodyBytes,responseBytes:0,authentication:['/api/login','/api/logout'].includes(route)};report.http.push(record);return record}
  function receive(record,status,bytes){check(bytes.length<=MAX_BODY,'HTTP_RESPONSE_LIMIT');charge(bytes.length);record.status=status;record.responseBytes=bytes.length}
  async function drainObserved(checkFatal=true){while(observations.size)await bounded(()=>Promise.allSettled([...observations]),10000,'HTTP_OBSERVATION_TIMEOUT');if(checkFatal&&fatal)throw failure(fatal)}
  async function startCLI(port){
    stage='start-cli';check(remaining()>0,'WORK_DEADLINE');
    const child=spawn(process.execPath,[path.join(ROOT,'server.js')],{cwd:ROOT,env:{PATH:process.env.PATH,DATABASE_URL:applicationURL,PORT:String(port)},stdio:['ignore','pipe','pipe']});
    const entry={pid:child.pid,port:null,exitCode:null,signal:null,forced:false,stdoutBytes:0,stderrBytes:0};report.processes.push(entry);processes.add(child);let stdout='',settled=false;
    const exit=new Promise(resolve=>child.once('close',(code,signal)=>{entry.exitCode=code;entry.signal=signal;settled=true;processes.delete(child);resolve(entry)}));child.ownedExit=exit;child.ownedEntry=entry;
    const ready=new Promise((resolve,reject)=>{
      child.once('error',()=>reject(failure('CLI_START_FAILED')));child.once('close',()=>reject(failure('CLI_CLOSED_BEFORE_READY')));
      child.stdout.on('data',bytes=>{try{entry.stdoutBytes+=bytes.length;charge(bytes.length);if(stdout.length<8192)stdout+=bytes.toString();const m=stdout.match(/^Memz http:\/\/127\.0\.0\.1:(\d+)$/m);if(m){entry.port=Number(m[1]);resolve(child)}}catch{fatal||='CLI_OUTPUT_LIMIT';reject(failure(fatal))}});
      child.stderr.on('data',bytes=>{try{entry.stderrBytes+=bytes.length;charge(bytes.length)}catch{fatal||='CLI_OUTPUT_LIMIT';reject(failure(fatal))}});
    });
    try{const live=await bounded(()=>ready,12000,'CLI_START_TIMEOUT',()=>child.kill('SIGTERM'));check(!settled,'CLI_NOT_RUNNING');if(port!==0)check(entry.port===port,'CLI_PORT_CHANGED');return live}catch(error){throw error}
  }
  async function stopCLI(child){
    if(!child)return;
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');try{await bounded(()=>child.ownedExit,22000,'CLI_DRAIN_TIMEOUT')}catch{child.ownedEntry.forced=true;child.kill('SIGKILL');await bounded(()=>child.ownedExit,2000,'CLI_KILL_TIMEOUT')}}
    check(child.ownedEntry.exitCode===0&&!child.ownedEntry.forced&&child.ownedEntry.signal===null,'CLI_NOT_NORMAL_EXIT');
  }
  async function settleLists(){await page.waitForFunction(()=>['facts','history','candidates','sources','audit'].every(id=>document.getElementById(id).getAttribute('aria-busy')==='false'));await drainObserved()}
  async function drafts(){return page.evaluate(()=>({account:acceptedUsername,project:projectId,source:Object.fromEntries(new FormData(document.querySelector('#sourceForm'))),proposal:Object.fromEntries(new FormData(document.querySelector('#proposal'))),selectedSource:document.querySelector('#sourceSelect').value}))}
  async function proof(){return (await query(owner,`SELECT (SELECT count(*)::int FROM sources WHERE id=$1 AND project_id=1) AS sources,
    (SELECT count(*)::int FROM audit WHERE project_id=1 AND actor_id=1 AND action='source' AND detail=$2) AS audit,
    (SELECT count(*)::int FROM idempotency_requests WHERE project_id=1 AND actor_id=1 AND operation='sources' AND request_key=$3 AND (response->>'id')::int=$1) AS receipts`,[firstId,`新增来源 ${firstId}`,originalKey])).rows[0]}
  let applicationURL;
  try{
    admin=await connect(parsed.href);await query(admin,'CREATE DATABASE '+dbName,[],()=>{dbCreated=true});
    const url=new URL(parsed);url.pathname='/'+dbName;owner=await connect(url.href);
    const originalSchema=fs.readFileSync(path.join(ROOT,'db/schema.sql'),'utf8');check((originalSchema.match(/^CREATE ROLE memz_app .*;\r?\n/mg)||[]).length===1,'SCHEMA_ROLE_DECLARATION');const schema=originalSchema.replace(/^CREATE ROLE memz_app .*;\r?\n/m,'');report.databaseSchema={originalSha256:hash(originalSchema),executedSha256:hash(schema),removedExistingRoleDeclarations:1};await query(owner,schema);
    report.database={before:await fingerprint()};url.username='memz_app';url.password='memz_demo_only';applicationURL=url.href;
    const first=await startCLI(0);base='http://127.0.0.1:'+first.ownedEntry.port;report.port=first.ownedEntry.port;
    stage='launch-browser';browserServer=await chromium.launchServer({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,host:'127.0.0.1',timeout:15000,args:['--no-sandbox','--disable-background-networking']});browser=await chromium.connect(browserServer.wsEndpoint(),{timeout:5000});report.environment.chromium=browser.version();
    context=await browser.newContext({viewport:{width:1280,height:900},locale:'zh-CN',timezoneId:'UTC'});page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',()=>{fatal||='BROWSER_PAGE_ERROR'});page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigationCount++});
    let loseNext=false;
    await context.route('**/*',async route=>{
      const request=route.request(),tracked=deferred();observations.add(tracked.promise);let record,response;
      try{
        const u=new URL(request.url());check(u.origin===base&&!u.username&&!u.password,'NONLOCAL_BROWSER_REQUEST');const encoded=request.postDataBuffer();record=admit(request.method(),u.pathname,encoded?.length||0);
        let drop=false;
        if(request.method()==='POST'&&u.pathname==='/api/projects/1/sources'){
          const key=request.headers()['idempotency-key'];check(typeof key==='string'&&key.length>0,'MISSING_CREATION_KEY');writeKeys.push(key);
          if(loseNext){loseNext=false;originalKey=key;drop=true}
        }
        // No CDP response.body side channel: actual upstream bytes are owned
        // before page delivery. Never issue a second request to recover a body.
        check(remaining()>0,'WORK_DEADLINE');record.upstreamAttempts=1;
        response=await route.fetch({timeout:Math.max(1,Math.min(10000,remaining())),maxRedirects:0,maxRetries:0});record.status=response.status();
        check(response.status()<300||response.status()>=400,'UNEXPECTED_UPSTREAM_REDIRECT');
        const bytes=await response.body();receive(record,response.status(),bytes);
        if(drop){check(response.status()===200,'COMMIT_RESPONSE_STATUS');const saved=JSON.parse(bytes.toString('utf8'));check(Number.isSafeInteger(saved.id)&&saved.id>0,'COMMIT_SOURCE_ID');firstId=saved.id;record.syntheticLostReplyAfterServer200=true;await route.abort('failed');loss.resolve();return}
        await route.fulfill({response,body:bytes});
      }catch(error){const code=/^[A-Z][A-Z_0-9]*$/.test(error.code||'')?error.code:'UPSTREAM_TRANSPORT_FAILED';fatal||=code;report.observationFailures.push({requestId:record?.id||null,code});loss.reject(failure(code));try{await route.abort('failed')}catch{}}
      finally{if(response)try{await response.dispose()}catch{fatal||='UPSTREAM_DISPOSE_FAILED';report.observationFailures.push({requestId:record?.id||null,code:'UPSTREAM_DISPOSE_FAILED'})}tracked.resolve();observations.delete(tracked.promise)}
    });
    stage='initial-login';await page.goto(base,{waitUntil:'load',timeout:15000});await page.locator('#loginForm [name=password]').fill('demo-owner');await page.locator('#loginForm button').click();
    await page.waitForFunction(()=>projectId===1&&data?.role==='owner');await settleLists();
    await page.locator('#sourceSelect').selectOption('2');await page.locator('#proposal [name=subject]').fill('Original recovery draft');await page.locator('#proposal [name=value]').fill('Preserve this unsubmitted proposal');
    await page.locator('#addSourceShortcut').click();const sourceBody={title:'session-recovery-'+dbName.slice(-16),content:'Original synthetic source; actual commit with deliberately lost reply.'};
    await page.locator('#sourceForm [name=title]').fill(sourceBody.title);await page.locator('#sourceForm [name=content]').fill(sourceBody.content);
    const before=await drafts();initialCookie=(await context.cookies(base)).find(cookie=>cookie.name==='sid')?.value;initialCsrf=await page.evaluate(()=>csrf);check(initialCookie&&initialCsrf,'INITIAL_AUTH_MISSING');await page.evaluate(()=>{globalThis.__ownedSessionRecoveryMarker='same-original-document'});const firstNavigationCount=navigationCount;
    stage='commit-lost-reply';loseNext=true;await page.locator('#sourceForm button').click();await bounded(()=>loss.promise,12000,'LOSS_INTERCEPTION_TIMEOUT');await page.locator('#sourceFeedback').getByText(/写入结果可能不确定/).waitFor();await page.waitForFunction(()=>document.querySelector('#sourceForm').getAttribute('aria-busy')==='false');await drainObserved();
    check(JSON.stringify(await drafts())===JSON.stringify(before),'DRAFT_CHANGED_AFTER_LOSS');check(JSON.stringify(await proof())===JSON.stringify({sources:1,audit:1,receipts:1}),'COMMIT_NOT_PROVEN');const committed=await fingerprint();report.checks.commitBeforeRestart={sourceId:firstId,source:1,audit:1,receipt:1,syntheticReplyLoss:true};
    stage='stop-first-cli';await stopCLI(first);check(first.ownedEntry.exitCode===0&&!first.ownedEntry.forced,'FIRST_CLI_NOT_NORMAL');
    const second=await startCLI(first.ownedEntry.port);check(first.pid!==second.pid,'CLI_PID_NOT_DISTINCT');report.checks.samePortAndDistinctPids=true;
    stage='old-cookie-401';await page.locator('#sourceForm button').click();await page.locator('#sessionRecovery').waitFor({state:'visible'});await page.waitForFunction(()=>sessionRecoveryRequired===true);await page.waitForFunction(()=>document.querySelector('#sourceForm').getAttribute('aria-busy')==='false');await drainObserved();
    check(writeKeys.length===2&&writeKeys[0]===writeKeys[1],'UNKNOWN_KEY_NOT_PRESERVED_AT_401');check(report.http.filter(r=>r.method==='POST'&&r.path==='/api/projects/1/sources').at(-1).status===401,'OLD_COOKIE_NOT_401');
    check(JSON.stringify(await drafts())===JSON.stringify(before),'DRAFT_OR_SELECTION_CHANGED_AT_401');check((await page.locator('#sessionAccount').textContent()).trim()==='owner','RECOVERY_ACCOUNT_CHANGED');check(await page.locator('#sourceForm button').isDisabled(),'WRITE_NOT_PAUSED');check(await page.locator('#proposal button').isDisabled(),'PROPOSAL_NOT_PAUSED');check(await page.locator('#sessionRecoveryForm [name=password]').inputValue()==='','RECOVERY_PASSWORD_NOT_EMPTY');check(JSON.stringify(await fingerprint())===JSON.stringify(committed),'401_CHANGED_DATABASE');
    report.checks.after401={sameAccount:true,sourceDraftPreserved:true,proposalDraftPreserved:true,selectedSourcePreserved:true,sameKeyRetained:true,writesPaused:true};
    stage='manual-same-account-reauth';await page.locator('#sessionRecoveryForm [name=password]').fill('demo-owner');await page.locator('#sessionRecoveryForm button').click();
    await page.waitForFunction(()=>!sessionRecoveryRequired&&!sessionAccessPending&&data?.role==='owner');await page.waitForFunction(()=>document.querySelector('#sessionRecoveryForm').getAttribute('aria-busy')==='false');await settleLists();
    check(JSON.stringify(await drafts())===JSON.stringify(before),'DRAFT_OR_ACCOUNT_CHANGED_DURING_REAUTH');check(writeKeys.length===2,'REAUTH_AUTOMATICALLY_REPLAYED');check(await page.locator('#sourceForm button').isEnabled(),'WRITE_NOT_UNLOCKED_AFTER_ACCESS');
    const newCookie=(await context.cookies(base)).find(cookie=>cookie.name==='sid')?.value,newCsrf=await page.evaluate(()=>csrf);check(newCookie&&newCookie!==initialCookie&&newCsrf&&newCsrf!==initialCsrf,'SESSION_NOT_REPLACED');
    check(await page.evaluate(()=>globalThis.__ownedSessionRecoveryMarker==='same-original-document'),'PAGE_CONTEXT_REPLACED');check(navigationCount===firstNavigationCount,'BROWSER_RELOADED');check(JSON.stringify(await fingerprint())===JSON.stringify(committed),'REAUTH_CHANGED_DATABASE');report.checks.reauthenticated={sameAcceptedAccount:true,newCookie:true,newCsrf:true,currentProjectAccessConfirmed:true,samePageNoReload:true,noAutomaticReplay:true};
    stage='manual-same-key-replay';await page.locator('#sourceForm button').click();await page.locator('#sourceFeedback').getByText(new RegExp('来源 #'+firstId+' 已保存')).waitFor();await page.waitForFunction(()=>document.querySelector('#sourceForm').getAttribute('aria-busy')==='false');await settleLists();
    check(writeKeys.length===3&&writeKeys.every(key=>key===originalKey),'MANUAL_REPLAY_KEY_CHANGED');check(JSON.stringify(await fingerprint())===JSON.stringify(committed),'REPLAY_DUPLICATED_ROWS');check(JSON.stringify(await proof())===JSON.stringify({sources:1,audit:1,receipts:1}),'REPLAY_COUNT_CHANGED');report.checks.sameKeyReplay={sameKey:true,keySha256:hash(originalKey),sourceId:firstId,source:1,audit:1,receipt:1};
    stage='other-account-control';otherContext=await browser.newContext();
    async function control(method,route,body,csrfValue){const encoded=body===undefined?undefined:JSON.stringify(body),record=admit(method,route,encoded?Buffer.byteLength(encoded):0);const response=await otherContext.request.fetch(base+route,{method,data:body,headers:csrfValue?{'X-CSRF-Token':csrfValue}:{},timeout:10000,maxRedirects:0,maxRetries:0});const bytes=await response.body();receive(record,response.status(),bytes);return {status:response.status(),json:JSON.parse(bytes.toString('utf8'))}}
    const other=await control('POST','/api/login',{username:'other',password:'demo-other'});check(other.status===200&&typeof other.json.csrf==='string','OTHER_LOGIN_FAILED');check((await control('GET','/api/projects/1/facts')).status===403,'OTHER_PROJECT_NOT_DENIED');check((await control('POST','/api/logout',{},other.json.csrf)).status===200,'OTHER_LOGOUT_FAILED');await otherContext.close();otherContext=null;report.checks.otherAccount403=true;
    await drainObserved();report.database.after=await fingerprint();report.database.delta=Object.fromEntries(Object.keys(committed).map(table=>[table,committed[table].rows-report.database.before[table].rows]));check(JSON.stringify(report.database.delta)===JSON.stringify({projects:0,memberships:0,sources:1,facts:0,candidates:0,revisions:0,audit:1,idempotency_requests:1}),'UNEXPECTED_WRITE_DELTA');
    report.source.after=sourceState();check(JSON.stringify(report.source.before)===JSON.stringify(report.source.after),'SOURCE_CHANGED_DURING_RUN');report.checks.sourceUnchangedDuringRun=true;
  }catch(error){report.failure=fatal||(/^[A-Z][A-Z_0-9]*$/.test(error.code||'')?error.code:'SESSION_RECOVERY_FAILED');report.failureStage=stage;}
  finally{
    cleaning=true;cleanupEnd=Math.min(totalEnd,Date.now()+CLEANUP_MS);const failed=[];async function clean(name,fn){try{await fn();report.cleanup[name]=true}catch{report.cleanup[name]=false;failed.push(name)}}
    await clean('otherContextClosed',async()=>{if(otherContext)await bounded(()=>otherContext.close(),2000,'OTHER_CONTEXT_CLOSE_TIMEOUT')});
    await clean('routesDrained',async()=>{if(context)await bounded(()=>context.unrouteAll({behavior:'wait'}),3000,'ROUTE_DRAIN_TIMEOUT')});
    await clean('observationsDrained',()=>drainObserved(false));
    await clean('contextClosed',async()=>{if(context)await bounded(()=>context.close(),3000,'CONTEXT_CLOSE_TIMEOUT')});
    await clean('browserClosed',async()=>{if(browser)await bounded(()=>browser.close(),5000,'BROWSER_CLOSE_TIMEOUT')});
    await clean('browserProcessClosed',async()=>{if(browserServer&&browserServer.process().exitCode===null)try{await bounded(()=>browserServer.close(),3000,'BROWSER_PROCESS_TIMEOUT')}catch{browserServer.process().kill('SIGKILL');throw failure('BROWSER_FORCED_CLOSE')}});
    await clean('cliProcessesClosed',async()=>{for(const child of [...processes])await stopCLI(child)});
    await clean('ownerClosed',()=>endClient(owner));await clean('adminClosed',()=>endClient(admin));
    if(dbCreated)await clean('databaseDropped',async()=>{let c;try{c=await connect(parsed.href);await terminalOwnedQuery(c,'DROP DATABASE '+dbName+' WITH (FORCE)',[],()=>{dbCreated=false});check((await terminalOwnedQuery(c,'SELECT count(*)::int AS n FROM pg_catalog.pg_database WHERE datname=$1',[dbName])).rows[0].n===0,'DATABASE_REMAINS')}finally{await endClient(c)}});
    for(const c of [...clients])await clean('remainingClientClosed',()=>endClient(c));
    report.cleanup.failedStages=failed;report.cleanup.databaseKnownRemaining=dbCreated;report.cleanup.remainingCliProcesses=processes.size;
    report.accounting={workBytes,cleanupBytes,totalBytes:workBytes+cleanupBytes,scope:report.method.byteScope};report.finishedAt=new Date().toISOString();report.durationMs=Date.now()-started;
    if(fatal&&!report.failure){report.failure=fatal;report.failureStage='cleanup'}
    report.passed=!report.failure&&!fatal&&!failed.length&&!dbCreated&&processes.size===0&&report.durationMs<=WORK_MS+CLEANUP_MS;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  console.log(JSON.stringify({passed:report.passed,failure:report.failure||null,failureStage:report.failureStage||null,observationFailures:report.observationFailures,http:report.http.length,totalBytes:report.accounting.totalBytes,cleanup:report.cleanup,output}));if(!report.passed)process.exitCode=1;
}
if(require.main===module)main().catch(()=>{console.error('SESSION_RECOVERY_SETUP_FAILED');process.exitCode=1});
