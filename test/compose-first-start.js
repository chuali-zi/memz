// Opt-in real Docker/Compose regression; intentionally NOT a *.test.js file.
// Only fresh synthetic, portless services and this random project's volumes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const ROOT=path.resolve(__dirname,'..');
const elapsed=start=>Math.round(performance.now()-start);
const fixed=(code,stage)=>Object.assign(new Error(code),{code,stage});
function reasonCodes(text){
  const known={'permission denied':'PERMISSION_DENIED','not a directory':'MOUNT_TYPE_MISMATCH',
    'is a directory':'MOUNT_FILE_IS_DIRECTORY','no such file or directory':'PATH_NOT_FOUND',
    'unhealthy':'UNHEALTHY','exited':'CONTAINER_EXITED','connection refused':'CONNECTION_REFUSED',
    'syntax error':'INIT_SYNTAX_ERROR'};
  return [...new Set(Object.entries(known).filter(([textPart])=>text.toLowerCase().includes(textPart)).map(([,code])=>code))];
}
async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--execute'){
    process.stdout.write('{"ok":false,"code":"COMPOSE_FIRST_START_OPT_IN_REQUIRED"}\n');process.exitCode=1;return;
  }
  const started=performance.now(),workDeadline=started+29000,totalDeadline=started+39000;
  const project='memz-first-start-'+crypto.randomBytes(8).toString('hex');
  const reportDirectory=path.join(ROOT,'artifacts/compose-first-start');fs.mkdirSync(reportDirectory,{recursive:true});
  const reportPath=path.join(reportDirectory,project+'.json');
  const fixture=fs.mkdtempSync(path.join(path.dirname(ROOT),'.memz-first-start-'));
  fs.mkdirSync(path.join(fixture,'docker-config'),{mode:0o700});
  // The client uses no inherited values, dotenv, context or registry credentials.
  // This private config is temporary; no existing Docker configuration changes.
  const env={DOCKER_CONFIG:path.join(fixture,'docker-config'),COMPOSE_DISABLE_ENV_FILE:'1'};
  const configPath=path.join(fixture,'compose.json'),active=new Set();
  const report={schema:'memz-compose-first-start-v1',ok:false,project,node:process.version,
    fixture:{synthetic:true,gateSeconds:4,portsPublished:false,networkMode:'none',pullPolicy:'never'},
    runnerSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    composeSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,'compose.yml'))).digest('hex'),
    stages:[],observations:[],cleanup:{passed:false}};
  let docker,compose,creationAttempted=false,failure;
  const kill=(child,signal)=>{try{process.kill(-child.pid,signal)}catch{}};
  const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  const watchdog=setTimeout(()=>{
    for(const child of active)kill(child,'SIGKILL');
    report.failure=report.failure||{code:'TOTAL_DEADLINE',stage:'total_deadline'};
    report.deadlineExceeded=true;report.elapsedMs=elapsed(started);report.fixtureDirectory=fixture;
    try{save()}catch{}
    process.stdout.write(JSON.stringify({ok:false,code:'TOTAL_DEADLINE',reportPath})+'\n');process.exit(1);
  },39000);
  async function command(args,stage,{cleanup=false,limit=8000}={}){
    const remaining=(cleanup?totalDeadline:workDeadline)-performance.now()-300;
    if(remaining<=0)throw fixed('FIXTURE_DEADLINE',stage);
    const entry={stage,startedMs:elapsed(started)};report.stages.push(entry);
    return new Promise((resolve,reject)=>{
      const child=spawn(docker,args,{cwd:fixture,env,stdio:['ignore','pipe','pipe'],detached:true});active.add(child);
      let out='',err='',bytes=0,problem,killTimer;
      const stop=code=>{if(problem)return;problem=code;kill(child,'SIGTERM');killTimer=setTimeout(()=>kill(child,'SIGKILL'),200)};
      const timer=setTimeout(()=>stop('COMMAND_DEADLINE'),Math.min(limit,remaining));
      const collect=(target,chunk)=>{bytes+=chunk.length;if(bytes>65536){stop('COMMAND_OUTPUT_LIMIT');return target}return target+chunk.toString('utf8')};
      child.stdout.on('data',chunk=>{out=collect(out,chunk)});child.stderr.on('data',chunk=>{err=collect(err,chunk)});
      child.once('error',()=>{problem=problem||'COMMAND_SPAWN_FAILED'});
      child.once('close',(code,signal)=>{
        clearTimeout(timer);clearTimeout(killTimer);active.delete(child);
        Object.assign(entry,{elapsedMs:elapsed(started)-entry.startedMs,exitCode:code,signal,
          outcome:problem||(code===0?'OK':'EXIT_NONZERO'),reasonCodes:reasonCodes(err)});
        if(problem)reject(fixed(problem,stage));else resolve({code,out,err});
      });
    });
  }
  const base=['--host=unix:///var/run/docker.sock'];
  const requireOK=(value,stage)=>{if(value.code!==0)throw fixed('COMMAND_FAILED',stage);return value};
  async function resources(kind,cleanup=false){
    const args=kind==='containers'?['ps','-a','-q']: [kind==='volumes'?'volume':'network','ls','-q'];
    const result=requireOK(await command([...base,...args,'--filter','label=com.docker.compose.project='+project],
      (cleanup?'cleanup_absence_':'preflight_absence_')+kind,{cleanup,limit:2000}),kind);
    return result.out.trim().split(/\s+/).filter(Boolean);
  }
  async function ownedContainer(service){
    const result=requireOK(await command([...compose,'ps','-q',service],service+'_container'),service+'_container');
    const id=result.out.trim();if(!/^[a-f0-9]{12,64}$/.test(id))throw fixed('OWNED_CONTAINER_MISSING',service);
    const owner=requireOK(await command([...base,'inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',id],service+'_ownership'),service+'_ownership');
    if(owner.out.trim()!==project)throw fixed('OWNERSHIP_MISMATCH',service);return id;
  }
  async function observe(service){
    const id=await ownedContainer(service);
    const health=requireOK(await command([...base,'inspect','--format','{{.State.Health.Status}}',id],service+'_health'),service+'_health');
    const tcp=await command([...base,'exec',id,'pg_isready','-h','127.0.0.1','-U','postgres','-d','memz'],service+'_tcp',{limit:2500});
    const gate=requireOK(await command([...base,'exec',id,'psql','-h','/var/run/postgresql','-U','postgres','-d','memz','-Atc',
      "SELECT to_regclass('public.synthetic_init_gate') IS NOT NULL"],service+'_gate',{limit:2500}),service+'_gate');
    const row={case:service,observedMs:elapsed(started),health:health.out.trim(),tcpExitCode:tcp.code,
      tcpReady:tcp.code===0,initComplete:gate.out.trim()==='t'};
    if(!['t','f'].includes(gate.out.trim()))throw fixed('INVALID_GATE_RECEIPT',service);
    report.observations.push(row);return row;
  }
  try{
    docker=['/usr/bin/docker','/bin/docker','/usr/local/bin/docker'].find(file=>{try{fs.accessSync(file,fs.constants.X_OK);return true}catch{return false}});
    if(!docker)throw fixed('DOCKER_REQUIRED','preflight');
    for(const kind of ['containers','volumes','networks'])if((await resources(kind)).length)throw fixed('PROJECT_ALREADY_EXISTS','preflight');
    const image=requireOK(await command([...base,'image','inspect','postgres:16','--format','{{.Id}}'],'cached_image'),'cached_image');
    if(!/^sha256:[a-f0-9]{64}$/.test(image.out.trim()))throw fixed('CACHED_PG16_REQUIRED','cached_image');report.imageId=image.out.trim();
    const version=requireOK(await command([...base,'compose','version','--short'],'compose_version'),'compose_version');report.composeVersion=version.out.trim();
    const normalized=requireOK(await command([...base,'compose','--env-file','/dev/null','-p',project,'-f',path.join(ROOT,'compose.yml'),'config','--no-interpolate','--no-env-resolution','--format','json'],'production_config'),'production_config');
    let production;try{production=JSON.parse(normalized.out).services.db}catch{throw fixed('INVALID_NORMALIZED_CONFIG','production_config')}
    const expected=['CMD','pg_isready','-h','127.0.0.1','-U','postgres','-d','memz'],health=production.healthcheck;
    if(production.image!=='postgres:16'||JSON.stringify(health?.test)!==JSON.stringify(expected)||health.disable===true||
      health.interval!=='2s'||health.timeout!=='3s'||health.retries!==30)throw fixed('UNSUPPORTED_PRODUCTION_CONFIG','production_config');
    report.productionHealthcheck={test:health.test,interval:health.interval,timeout:health.timeout,retries:health.retries};
    const gatePath=path.join(fixture,'01-gate.sql');fs.writeFileSync(gatePath,
      'SELECT pg_sleep(4);\nCREATE TABLE public.synthetic_init_gate(done boolean NOT NULL);\nINSERT INTO public.synthetic_init_gate VALUES (true);\n');fs.chmodSync(gatePath,0o644);
    const service=(volume,test)=>({image:'postgres:16',pull_policy:'never',network_mode:'none',
      environment:{POSTGRES_USER:'postgres',POSTGRES_PASSWORD:'synthetic_first_start_only',POSTGRES_DB:'memz'},
      volumes:[volume+':/var/lib/postgresql/data',gatePath+':/docker-entrypoint-initdb.d/01-gate.sql:ro'],
      healthcheck:{...report.productionHealthcheck,test}});
    fs.writeFileSync(configPath,JSON.stringify({services:{
      original:service('original_data',['CMD-SHELL','pg_isready -U postgres -d memz']),
      current:service('current_data',production.healthcheck.test)},volumes:{original_data:{},current_data:{}}}));
    compose=[...base,'compose','--env-file','/dev/null','-p',project,'-f',configPath];
    creationAttempted=true;
    requireOK(await command([...compose,'up','-d','--wait','--wait-timeout','12','--pull','never','original'],'original_wait',{limit:15000}),'original_wait');
    const original=await observe('original');
    if(original.health!=='healthy'||original.tcpReady||original.initComplete)throw fixed('ORIGINAL_EARLY_HEALTH_NOT_REPRODUCED','original_observation');
    requireOK(await command([...compose,'up','-d','--wait','--wait-timeout','12','--pull','never','current'],'current_wait',{limit:15000}),'current_wait');
    const current=await observe('current');
    if(current.health!=='healthy'||!current.tcpReady||!current.initComplete)throw fixed('PRODUCTION_TCP_HEALTH_NOT_READY','current_observation');
    const settled=await observe('original');
    if(!settled.tcpReady||!settled.initComplete)throw fixed('ORIGINAL_FINAL_STARTUP_NOT_READY','original_final');
  }catch(error){failure={code:error?.code||'FIXTURE_FAILURE',stage:error?.stage||'fixture'};report.failure=failure}
  finally{
    const cleanupFailures=[];
    if(creationAttempted)try{
      const result=await command([...compose,'down','--volumes','--remove-orphans','--timeout','2'],'cleanup_down',{cleanup:true,limit:5000});
      if(result.code!==0)cleanupFailures.push('cleanup_down');
    }catch{cleanupFailures.push('cleanup_down')}
    const remaining={};
    if(docker)for(const kind of ['containers','volumes','networks'])try{remaining[kind]=(await resources(kind,true)).length;if(remaining[kind])cleanupFailures.push(kind)}catch{remaining[kind]=null;cleanupFailures.push(kind)}
    if(!cleanupFailures.length)try{fs.rmSync(fixture,{recursive:true,force:true})}catch{cleanupFailures.push('fixture_directory')}
    report.cleanup={passed:cleanupFailures.length===0,failures:cleanupFailures,remaining};
    if(!report.cleanup.passed)report.fixtureDirectory=fixture;
    if(failure)report.failure=failure;
    else if(cleanupFailures.length)report.failure={code:'CLEANUP_FAILED',stage:'cleanup'};
    report.ok=!report.failure;report.elapsedMs=elapsed(started);clearTimeout(watchdog);save();
    process.stdout.write(JSON.stringify({ok:report.ok,code:report.ok?'COMPOSE_FIRST_START_PASSED':report.failure.code,
      stage:report.failure?.stage,elapsedMs:report.elapsedMs,reportPath})+'\n');
    if(!report.ok)process.exitCode=1;
  }
}
if(require.main===module)main().catch(()=>{process.stdout.write('{"ok":false,"code":"FIXTURE_SETUP_FAILED","stage":"fixture_setup_or_report"}\n');process.exitCode=1});
