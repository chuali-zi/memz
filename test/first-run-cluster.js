// Opt-in fresh-install integration. Never use existing Compose projects/volumes.
// The schema is byte-for-byte original; an extra, explicitly recorded observer
// checks role absence before the official entrypoint runs that schema.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),WORK_MS=180000,CLEANUP_MS=60000,TOTAL_MS=240000;
const MAX_BYTES=8*1024*1024,CLEANUP_RESERVE=128*1024,MAX_HTTP=64,MAX_HTTP_BYTES=1024*1024,MAX_BODY=65536;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
const check=(condition,code)=>{if(!condition)throw fail(code)};
const files=['compose.yml','db/schema.sql','server.js','scripts/database.js','scripts/session-store.js','scripts/http-server.js','scripts/server-lifecycle.js','scripts/check-setup.js','scripts/setup-catalog.js','scripts/health-probes.js','scripts/context-client.js','scripts/read-session.js','scripts/context-snapshot.js','scripts/search-query.js','scripts/demo-story.js','test/first-run-cluster.js','docs/first-run-cluster.md'];
function sourceState(){const git=(...args)=>execFileSync('git',args,{cwd:ROOT,env:{PATH:process.env.PATH,GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',timeout:2000,maxBuffer:524288}).trim();return {head:git('rev-parse','HEAD'),dirty:!!git('status','--porcelain'),files:Object.fromEntries(files.map(file=>[file,hash(fs.readFileSync(path.join(ROOT,file)))]))}}
async function main(){
  check(process.argv.length===3&&process.argv[2]==='--execute','FIRST_RUN_CLUSTER_OPT_IN_REQUIRED');
  const project='memz-fresh-'+crypto.randomBytes(8).toString('hex'),started=Date.now(),workEnd=started+WORK_MS,totalEnd=started+TOTAL_MS;
  const output=path.resolve(process.env.FIRST_RUN_CLUSTER_OUTPUT||path.join(ROOT,'artifacts/first-run-cluster',project));
  fs.mkdirSync(output,{recursive:true,mode:0o700});check(!fs.existsSync(path.join(output,'report.json')),'FRESH_OUTPUT_REQUIRED');
  const report={schema:'memz-first-run-cluster-v1',passed:false,synthetic:true,project,startedAt:new Date(started).toISOString(),source:{},runtime:{node:process.version},
    method:{scope:'Fresh cached PostgreSQL cluster, actual official initialization, doctor CLI, application CLI, original context/demo modules over actual HTTP. No browser, MCP, external model, install, image pull or production identity claim.',
      modifications:'Derived production Compose service: unique project/volume, internal bridge, dynamic loopback publication, exact schema copy and extra read-only pre-schema observer writing a scalar /tmp marker. Not an unchanged invocation of compose.yml.',
      bytes:'Command arguments/stdin/stdout/stderr, application CLI output and HTTP request/response bodies. Excludes mounted schema/file IO, server-internal PG traffic, HTTP headers/wire, Docker daemon traffic, heap and JSON serialization overhead. After-materialization accounting is not a hard allocation bound.',
      source:'HEAD/dirty plus explicitly listed file hashes; not an independent full repository provenance proof. HTTP wrapper buffers bounded bodies before original client validation; no performance claim.'},
    limits:{workMs:WORK_MS,cleanupMs:CLEANUP_MS,totalMs:TOTAL_MS,applicationBytes:MAX_BYTES,cleanupReserve:CLEANUP_RESERVE,http:MAX_HTTP,httpBodyBytes:MAX_HTTP_BYTES,singleResponseBytes:MAX_BODY},stages:[],http:[],checks:{},cleanup:{},modelCalls:0};
  let cleaning=false,cleanupEnd=totalEnd,workBytes=0,cleanupBytes=0,httpBytes=0,fatal=null,creationAttempted=false,creationAcknowledged=false,docker,compose,cli,applicationURL,base,fixture,stage='preflight',saved=false;
  const commands=new Set(),controllers=new Set();const owned={container:null,volume:project+'_data',network:project+'_default'};
  report.resources=owned;
  const remaining=()=>Math.max(0,(cleaning?cleanupEnd:workEnd)-Date.now());
  function charge(bytes){check(Number.isSafeInteger(bytes)&&bytes>=0,'INVALID_BYTE_COUNT');if(cleaning){cleanupBytes+=bytes;if(cleanupBytes>CLEANUP_RESERVE)fatal||='CLEANUP_BYTE_LIMIT'}else{workBytes+=bytes;check(workBytes<=MAX_BYTES-CLEANUP_RESERVE,'WORK_BYTE_LIMIT')}}
  async function bounded(start,ms,code,cancel=()=>{}){if(remaining()<=0){try{cancel()}catch{}throw fail(cleaning?'CLEANUP_DEADLINE':'WORK_DEADLINE')}let timer;try{return await Promise.race([start(),new Promise((_,reject)=>{timer=setTimeout(()=>{try{cancel()}catch{}reject(fail(code))},Math.min(ms,remaining()))})])}finally{clearTimeout(timer)}}
  const kill=(child,signal)=>{try{process.kill(-child.pid,signal)}catch{}};
  const dockerEnv={COMPOSE_DISABLE_ENV_FILE:'1'};
  function save(){if(saved)return;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});saved=true}
  const watchdog=setTimeout(()=>{
    for(const controller of controllers)controller.abort();for(const child of commands)kill(child,'SIGKILL');if(cli?.exitCode===null)cli.kill('SIGKILL');
    report.failure||='TOTAL_DEADLINE';report.failureStage||=stage;report.cleanup.deadlineExceeded=true;report.cleanup.resourceStatus='UNKNOWN';report.cleanup.activeCommands=commands.size;report.cleanup.creationAttempted=creationAttempted;report.cleanup.creationAcknowledged=creationAcknowledged;report.retainedFixture=fixture;
    report.accounting={workBytes,cleanupBytes,totalBytes:workBytes+cleanupBytes,httpBodyBytes:httpBytes};report.durationMs=Date.now()-started;report.finishedAt=new Date().toISOString();try{save()}catch{}
    console.log(JSON.stringify({passed:false,failure:report.failure,failureStage:report.failureStage,cleanup:report.cleanup,output}));process.exit(1);
  },Math.max(1,totalEnd-Date.now()));
  async function command(binary,args,name,{timeout=10000,env=dockerEnv}={}){
    check(remaining()>0,cleaning?'CLEANUP_DEADLINE':'WORK_DEADLINE');charge(Buffer.byteLength(JSON.stringify(args)));
    const row={name,exitCode:null,signal:null,outputBytes:0};report.stages.push(row);
    return new Promise((resolve,reject)=>{
      const child=spawn(binary,args,{cwd:fixture,env,stdio:['ignore','pipe','pipe'],detached:true});commands.add(child);let stdout='',problem=null,escalation,closeLimit,settled=false;
      let closedResolve;child.ownedClose=new Promise(resolve=>{closedResolve=resolve});
      const settle=(code,signal,observed)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(escalation);clearTimeout(closeLimit);row.exitCode=code;row.signal=signal;row.closeObserved=observed;
        if(!observed){row.outcome='PROCESS_CLOSE_UNCERTAIN';fatal||='PROCESS_CLOSE_UNCERTAIN';child.stdout.destroy();child.stderr.destroy();child.unref()}
        if(problem||!observed)reject(fail(problem||'PROCESS_CLOSE_UNCERTAIN'));else if(code!==0)reject(fail('COMMAND_FAILED'));else resolve(stdout)};
      const stop=code=>{if(closeLimit)return;problem||=code;row.outcome=problem;kill(child,'SIGTERM');escalation=setTimeout(()=>kill(child,'SIGKILL'),200);closeLimit=setTimeout(()=>settle(null,null,false),700)};
      const timer=setTimeout(()=>stop('COMMAND_TIMEOUT'),Math.min(timeout,remaining()));
      child.stdout.on('data',bytes=>{try{row.outputBytes+=bytes.length;charge(bytes.length);if(row.outputBytes>MAX_BODY)return stop('COMMAND_OUTPUT_LIMIT');stdout+=bytes.toString('utf8')}catch{stop('WORK_BYTE_LIMIT')}});
      child.stderr.on('data',bytes=>{try{row.outputBytes+=bytes.length;charge(bytes.length);if(row.outputBytes>MAX_BODY)stop('COMMAND_OUTPUT_LIMIT')}catch{stop('WORK_BYTE_LIMIT')}});
      child.once('error',()=>{problem||='COMMAND_SPAWN_FAILED'});child.once('close',(code,signal)=>{commands.delete(child);closedResolve();settle(code,signal,true)});
    });
  }
  const dbArgs=['--host=unix:///var/run/docker.sock'];
  const dc=(args,name,options)=>command(docker,[...dbArgs,...args],name,options);
  const cc=(args,name,options)=>command(docker,[...compose,...args],name,options);
  async function resources(kind){const args=kind==='containers'?['ps','-aq']:[kind==='volumes'?'volume':'network','ls','-q'];return (await dc([...args,'--filter','label=com.docker.compose.project='+project],'list_'+kind,{timeout:3000})).trim().split(/\s+/).filter(Boolean)}
  async function assertOwner(kind,id){const field=kind==='container'?'{{index .Config.Labels "com.docker.compose.project"}}':'{{index .Labels "com.docker.compose.project"}}';const args=kind==='container'?['inspect']: [kind,'inspect'];check((await dc([...args,'--format',field,id],'owner_'+kind,{timeout:3000})).trim()===project,'RESOURCE_OWNERSHIP_MISMATCH')}
  async function namedResources(kind){const name=kind==='volume'?owned.volume:owned.network;return (await dc([kind,'ls','--filter','name='+name,'--format','{{.Name}}'],'names_'+kind,{timeout:3000})).trim().split('\n').filter(Boolean)}
  async function exactContainers(){return (await dc(['ps','-a','--filter','name='+project,'--format','{{.ID}} {{.Names}}'],'exact_containers',{timeout:3000})).trim().split('\n').filter(Boolean)}
  async function exactAbsent(){check(!(await exactContainers()).some(row=>row.includes(project)),'OWNED_CONTAINER_REMAINS');if(owned.container)check(!(await dc(['ps','-aq','--filter','id='+owned.container],'exact_container_id',{timeout:3000})).trim(),'OWNED_CONTAINER_ID_REMAINS');for(const [kind,name] of [['volume',owned.volume],['network',owned.network]])check(!(await namedResources(kind)).includes(name),'OWNED_NAMED_RESOURCE_REMAINS')}
  async function sql(text){return (await dc(['exec','-e','PGOPTIONS=-c statement_timeout=5000 -c lock_timeout=2000',owned.container,'psql','-X','-h','/var/run/postgresql','-U','postgres','-d','memz','-v','ON_ERROR_STOP=1','-Atc',text],'scalar_sql',{timeout:6000})).trim()}
  async function counts(){return JSON.parse(await sql("SELECT json_build_object('projects',(SELECT count(*) FROM public.projects),'memberships',(SELECT count(*) FROM public.memberships),'sources',(SELECT count(*) FROM public.sources),'facts',(SELECT count(*) FROM public.facts),'candidates',(SELECT count(*) FROM public.candidates),'revisions',(SELECT count(*) FROM public.revisions),'audit',(SELECT count(*) FROM public.audit),'idempotency_requests',(SELECT count(*) FROM public.idempotency_requests))"))}
  async function stopCLI(){if(!cli)return;if(cli.exitCode===null&&cli.signalCode===null)cli.kill('SIGTERM');try{await bounded(()=>cli.ownedExit,22000,'CLI_DRAIN_TIMEOUT',()=>cli.kill('SIGKILL'))}catch{report.cli.forced=true;cli.kill('SIGKILL');await bounded(()=>cli.ownedExit,2000,'CLI_KILL_TIMEOUT')}check(report.cli.closeObserved&&report.cli.exitCode===0&&!report.cli.forced&&report.cli.signal===null,'CLI_NOT_NORMAL_EXIT')}
  const nativeFetch=globalThis.fetch;
  async function measuredFetch(input,options={}){
    const u=new URL(input instanceof URL?input.href:input);check(u.origin===base&&!u.username&&!u.password,'NONLOCAL_HTTP_TARGET');check(report.http.length<MAX_HTTP,'HTTP_LIMIT');
    const requestBytes=options.body===undefined?0:Buffer.byteLength(options.body);check(requestBytes<=4096,'HTTP_REQUEST_LIMIT');check(httpBytes+requestBytes<=MAX_HTTP_BYTES,'HTTP_BODY_LIMIT');charge(requestBytes);httpBytes+=requestBytes;
    const row={method:options.method||'GET',path:u.pathname,status:null,requestBytes,responseBytes:0};report.http.push(row);
    const controller=new AbortController();controllers.add(controller);const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(10000,remaining())));let reader;
    try{check(remaining()>0,'WORK_DEADLINE');const response=await nativeFetch(u,{...options,redirect:'error',signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal});row.status=response.status;reader=response.body?.getReader();const chunks=[];let size=0;
      if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;row.responseBytes=size;charge(value.length);httpBytes+=value.length;if(size>MAX_BODY||httpBytes>MAX_HTTP_BYTES){controller.abort();throw fail('HTTP_BODY_LIMIT')}chunks.push(Buffer.from(value))}
      return new Response(Buffer.concat(chunks,size),{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(error){controller.abort();throw error}finally{clearTimeout(timer);if(reader)try{await reader.cancel()}catch{}controllers.delete(controller)}
  }
  try{
    report.source.before=sourceState();fixture=fs.mkdtempSync(path.join('/tmp',project+'-'));fs.chmodSync(fixture,0o700);fs.mkdirSync(path.join(fixture,'docker-config'),{mode:0o700});dockerEnv.DOCKER_CONFIG=path.join(fixture,'docker-config');
    docker=['/usr/bin/docker','/bin/docker','/usr/local/bin/docker'].find(file=>{try{fs.accessSync(file,fs.constants.X_OK);return true}catch{return false}});check(docker,'DOCKER_REQUIRED');
    for(const kind of ['containers','volumes','networks'])check((await resources(kind)).length===0,'PROJECT_ALREADY_EXISTS');
    await exactAbsent();report.checks.preflightNoProjectOrExactResources=true;
    // No pull, daemon/context switch, .env loading, registry config or init logs.
    const image=(await dc(['image','inspect','postgres:16','--format','{{.Id}}'],'cached_image')).trim();check(/^sha256:[a-f0-9]{64}$/.test(image),'CACHED_IMAGE_REQUIRED');report.runtime.postgresImage=image;
    report.runtime.compose=(await dc(['compose','version','--short'],'compose_version')).trim();
    const normalized=JSON.parse(await dc(['compose','--env-file','/dev/null','-p',project,'-f',path.join(ROOT,'compose.yml'),'config','--no-interpolate','--no-env-resolution','--format','json'],'production_config'));
    const service=normalized.services?.db;check(service?.image==='postgres:16'&&JSON.stringify(service.healthcheck?.test)===JSON.stringify(['CMD','pg_isready','-h','127.0.0.1','-U','postgres','-d','memz']),'UNSUPPORTED_COMPOSE');
    check(Object.keys(normalized.services).length===1&&service.volumes?.length===2&&service.environment?.POSTGRES_DB==='memz'&&service.environment?.POSTGRES_PASSWORD==='postgres_demo_only','UNSUPPORTED_COMPOSE');
    check(service.volumes.some(v=>v.type==='volume'&&v.target==='/var/lib/postgresql/data')&&service.volumes.some(v=>v.type==='bind'&&v.source===path.join(ROOT,'db/schema.sql')&&v.target==='/docker-entrypoint-initdb.d/01-schema.sql'&&v.read_only===true),'UNSUPPORTED_SCHEMA_MOUNT');
    const schema=fs.readFileSync(path.join(ROOT,'db/schema.sql'));check(schema.includes(Buffer.from('CREATE ROLE memz_app ')),'SCHEMA_ROLE_REQUIRED');const schemaPath=path.join(fixture,'01-schema.sql');fs.writeFileSync(schemaPath,schema,{mode:0o644});fs.chmodSync(schemaPath,0o644);check(hash(fs.readFileSync(schemaPath))===hash(schema),'SCHEMA_COPY_CHANGED');report.checks.schema={sha256:hash(schema),roleDeclarationPreserved:true,bytes:schema.length};
    const observerPath=path.join(fixture,'00-observe.sh');fs.writeFileSync(observerPath,"#!/bin/sh\nset -eu\ncount=$(PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=2000' psql -X -v ON_ERROR_STOP=1 -U postgres -d memz -Atc \"SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname='memz_app'\")\ntest \"$count\" = 0\nprintf '0\\n' > /tmp/memz-fresh-role-absent\n",{mode:0o755});fs.chmodSync(observerPath,0o755);report.checks.observer={sha256:hash(fs.readFileSync(observerPath)),separateExecutable:true,readOnlyCatalogQuery:true};
    const config={services:{db:{image:service.image,pull_policy:'never',environment:service.environment,healthcheck:service.healthcheck,ports:[{target:5432,published:'0',host_ip:'127.0.0.1',protocol:'tcp'}],volumes:[{type:'volume',source:'data',target:'/var/lib/postgresql/data'},{type:'bind',source:observerPath,target:'/docker-entrypoint-initdb.d/00-observe.sh',read_only:true},{type:'bind',source:schemaPath,target:'/docker-entrypoint-initdb.d/01-schema.sql',read_only:true}]}},volumes:{data:{name:owned.volume}},networks:{default:{name:owned.network,internal:true}}};
    const configPath=path.join(fixture,'compose.json');fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600});compose=[...dbArgs,'compose','--env-file','/dev/null','-p',project,'-f',configPath];
    stage='fresh-initialization';creationAttempted=true;await cc(['up','-d','--wait','--wait-timeout','70','--pull','never'],'compose_up',{timeout:75000});creationAcknowledged=true;
    const ids=await resources('containers');check(ids.length===1,'CONTAINER_COUNT');owned.container=ids[0];check(/^[a-f0-9]{12,64}$/.test(owned.container),'INVALID_CONTAINER_ID');
    for(const [kind,id] of [['container',owned.container],['volume',owned.volume],['network',owned.network]])await assertOwner(kind,id);
    const inspect=JSON.parse(await dc(['inspect','--format','{"image":{{json .Image}},"health":{{json .State.Health.Status}},"ports":{{json .NetworkSettings.Ports}}}',owned.container],'owned_container_metadata'));
    const ports=inspect.ports?.['5432/tcp'];check(ports?.length===1&&ports[0].HostIp==='127.0.0.1'&&/^\d+$/.test(ports[0].HostPort),'LOOPBACK_PUBLICATION_REQUIRED');
    check(inspect.image===image&&inspect.health==='healthy','IMAGE_OR_HEALTH_MISMATCH');const pgPort=Number(ports[0].HostPort);check(pgPort>0&&pgPort<65536,'INVALID_DATABASE_PORT');report.runtime.databasePort=pgPort;
    check((await dc(['network','inspect','--format','{{.Internal}}',owned.network],'internal_network')).trim()==='true','INTERNAL_NETWORK_REQUIRED');
    check((await dc(['exec',owned.container,'cat','/tmp/memz-fresh-role-absent'],'fresh_role_marker')).trim()==='0','FRESH_ROLE_OBSERVER_FAILED');report.checks.roleAbsentBeforeOriginalSchema=true;
    check(await sql("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname='memz_app' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole")==='1','APP_ROLE_NOT_CREATED');
    check(await sql("SELECT count(*) FROM public.memberships WHERE active IS TRUE")==='4','ACTIVE_MEMBERSHIPS_NOT_INITIALIZED');
    report.database={before:await counts()};check(JSON.stringify(report.database.before)===JSON.stringify({projects:2,memberships:4,sources:4,facts:1,candidates:1,revisions:1,audit:1,idempotency_requests:0}),'SEED_COUNTS_MISMATCH');
    applicationURL='postgres://memz_app:memz_demo_only@127.0.0.1:'+pgPort+'/memz';
    stage='doctor-cli';const doctor=JSON.parse(await command(process.execPath,[path.join(ROOT,'scripts/check-setup.js')],'doctor',{env:{PATH:process.env.PATH,DATABASE_URL:applicationURL},timeout:18000}));check(doctor.ok&&doctor.code==='BASIC_CHECKS_PASSED','DOCTOR_NOT_READY');report.checks.doctor={ok:doctor.ok,code:doctor.code};
    stage='application-cli';cli=spawn(process.execPath,[path.join(ROOT,'server.js')],{cwd:ROOT,env:{PATH:process.env.PATH,DATABASE_URL:applicationURL,PORT:'0'},stdio:['ignore','pipe','pipe']});report.cli={pid:cli.pid,exitCode:null,signal:null,forced:false,stdoutBytes:0,stderrBytes:0};
    cli.ownedExit=new Promise(resolve=>cli.once('close',(code,signal)=>{report.cli.exitCode=code;report.cli.signal=signal;report.cli.closeObserved=true;resolve()}));
    const ready=new Promise((resolve,reject)=>{let out='';cli.once('error',()=>reject(fail('CLI_SPAWN_FAILED')));cli.once('close',()=>reject(fail('CLI_CLOSED_BEFORE_READY')));cli.stdout.on('data',bytes=>{try{charge(bytes.length);report.cli.stdoutBytes+=bytes.length;check(report.cli.stdoutBytes<=8192,'CLI_OUTPUT_LIMIT');out+=bytes.toString('utf8');const match=out.match(/^Memz http:\/\/127\.0\.0\.1:(\d+)$/m);if(match)resolve(Number(match[1]))}catch{fatal='CLI_OUTPUT_LIMIT';reject(fail(fatal))}});cli.stderr.on('data',bytes=>{try{charge(bytes.length);report.cli.stderrBytes+=bytes.length;check(report.cli.stderrBytes<=8192,'CLI_OUTPUT_LIMIT')}catch{fatal='CLI_OUTPUT_LIMIT';reject(fail(fatal))}})});
    const port=await bounded(()=>ready,12000,'CLI_START_TIMEOUT',()=>cli.kill('SIGTERM'));check(port>0&&port<65536,'INVALID_APPLICATION_PORT');base='http://127.0.0.1:'+port;report.runtime.applicationPort=port;globalThis.fetch=measuredFetch;
    stage='health';for(const [route,expected] of [['live','alive'],['ready','ready']]){const response=await measuredFetch(base+'/health/'+route),body=await response.json();check(response.status===200&&body.status===expected,'HEALTH_NOT_READY')}report.checks.health=true;
    stage='original-context';const {readContext}=require('../scripts/context-client');const initial=await readContext({baseURL:base,query:'项目',limit:1,maxOutputBytes:4096});check(initial.facts.length===1&&initial.facts[0].value==='20号'&&initial.facts[0].version===1,'INITIAL_CONTEXT_MISMATCH');report.checks.originalContext={facts:1,value:'20号',version:1,fullProvenance:true};
    stage='original-demo';const {runDemoStory}=require('../scripts/demo-story');const story=await runDemoStory({baseURL:base});check(story.steps.length===7&&story.context.facts[0].value==='15号'&&story.context.facts[0].version===2&&story.provenanceV1.value==='20号','DEMO_STORY_MISMATCH');report.checks.demo={steps:story.steps.map(s=>({name:s.name,...(s.status?{status:s.status}:{}),...(s.viewerWriteStatus?{viewerWriteStatus:s.viewerWriteStatus,otherProjectReadStatus:s.otherProjectReadStatus}:{} )})),currentValue:'15号',version:2,oldValue:'20号'};
    report.database.after=await counts();check(JSON.stringify(report.database.after)===JSON.stringify({projects:2,memberships:4,sources:7,facts:2,candidates:5,revisions:3,audit:11,idempotency_requests:7}),'DEMO_COUNTS_MISMATCH');
    report.source.after=sourceState();check(JSON.stringify(report.source.before)===JSON.stringify(report.source.after),'SOURCE_CHANGED_DURING_RUN');report.checks.selectedSourcesUnchanged=true;
  }catch(error){report.failure=/^[A-Z][A-Z_0-9]*$/.test(error.code||'')?error.code:'FIRST_RUN_CLUSTER_FAILED';report.failureStage=stage}
  finally{
    globalThis.fetch=nativeFetch;stage='cleanup';cleaning=true;cleanupEnd=Math.min(totalEnd,Date.now()+CLEANUP_MS);for(const controller of controllers)controller.abort();const failures=[];
    const clean=async(name,fn)=>{try{await fn();report.cleanup[name]=true}catch{report.cleanup[name]=false;failures.push(name)}};
    await clean('cliClosed',()=>stopCLI());
    await clean('commandsSettled',async()=>{for(const child of commands)kill(child,'SIGKILL');await bounded(()=>Promise.all([...commands].map(child=>child.ownedClose)),1500,'COMMAND_CLOSE_UNCERTAIN')});
    if(creationAttempted)await clean('composeDown',async()=>{
      // Only this project's service; no prune or --remove-orphans. A timed-out
      // up may still have created resources, so ownership is checked by labels.
      const ids=await resources('containers');for(const id of ids)await assertOwner('container',id);
      for(const [kind,name] of [['volume',owned.volume],['network',owned.network]])if((await namedResources(kind)).includes(name))await assertOwner(kind,name);
      await cc(['down','--volumes','--timeout','2'],'compose_down',{timeout:20000});
    });
    if(docker){await clean('labelsAbsent',async()=>{for(const kind of ['containers','volumes','networks'])check((await resources(kind)).length===0,'PROJECT_RESOURCES_REMAIN')});await clean('exactNamesAbsent',exactAbsent)}
    const uncertainCreation=creationAttempted&&!creationAcknowledged;
    if(!failures.length&&!uncertainCreation)await clean('fixtureRemoved',async()=>{if(fixture)fs.rmSync(fixture,{recursive:true,force:true})});
    for(const child of commands)kill(child,'SIGKILL');if(cli?.exitCode===null)cli.kill('SIGKILL');
    report.cleanup.failedStages=failures;report.cleanup.activeCommands=commands.size;report.cleanup.creationAttempted=creationAttempted;report.cleanup.creationAcknowledged=creationAcknowledged;report.cleanup.creationOutcome=creationAttempted?(creationAcknowledged?'ACKNOWLEDGED':'UNCERTAIN'):'NOT_ATTEMPTED';report.cleanup.currentResourceChecksAbsent=report.cleanup.labelsAbsent===true&&report.cleanup.exactNamesAbsent===true;report.cleanup.resourceStatus=uncertainCreation?'CREATION_OUTCOME_UNKNOWN':!creationAttempted?'NOT_CREATED_BY_RUN':failures.length||commands.size?'CLEANUP_NOT_CONFIRMED':'ABSENT_AT_CHECK';if(failures.length||uncertainCreation){report.retainedFixture=fixture;report.cleanup.fixtureRetained=!!fixture}
    report.accounting={workBytes,cleanupBytes,totalBytes:workBytes+cleanupBytes,httpBodyBytes:httpBytes};report.finishedAt=new Date().toISOString();report.durationMs=Date.now()-started;
    report.fatal=fatal;if(fatal&&!report.failure)report.failure=fatal;report.passed=!report.failure&&!fatal&&!failures.length&&!uncertainCreation&&commands.size===0&&report.durationMs<=TOTAL_MS;
    save();clearTimeout(watchdog);
  }
  console.log(JSON.stringify({passed:report.passed,http:report.http.length,applicationBytes:report.accounting.totalBytes,cleanup:report.cleanup,output}));if(!report.passed)process.exitCode=1;
}
if(require.main===module)main().catch(()=>{console.error('FIRST_RUN_CLUSTER_SETUP_FAILED');process.exitCode=1});
