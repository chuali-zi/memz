// Explicit opt-in: node test/browser-http-cache.js (not part of *.test.js).
// Real Express/session routes and native Chromium HTTP cache, with a clearly
// synthetic pool. No route interception: Playwright routing disables caching.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events'),{chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..'),MAX_HTTP=24,MAX_BYTES=512*1024,WORK_MS=240000,CLEANUP_MS=60000;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const failure=code=>Object.assign(new Error(code),{code});
const check=(value,code)=>{if(!value)throw failure(code)};
async function main(){
  const output=path.resolve(process.env.HTTP_CACHE_OUTPUT||path.join(ROOT,'artifacts/browser-http-cache',`run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`));
  fs.mkdirSync(output,{recursive:true,mode:0o700});check(!fs.existsSync(path.join(output,'report.json')),'FRESH_OUTPUT_REQUIRED');
  const watched=['server.js','scripts/database.js','scripts/session-store.js','test/browser-http-cache.js'];
  const sources=()=>Object.fromEntries(watched.map(file=>[file,hash(fs.readFileSync(path.join(ROOT,file)))]));
  const started=Date.now(),workEnd=started+WORK_MS,totalEnd=workEnd+CLEANUP_MS;
  const report={schema:'memz-browser-http-cache-v1',synthetic:true,passed:false,startedAt:new Date(started).toISOString(),source:{before:sources()},environment:{node:process.version},
    method:'Actual Express login/logout/me/project/facts routes; real Chromium native fetch/default and force-cache, explicit EventEmitter pool fixtures. No production database, identity provider, external endpoint or model.',
    limits:{http:MAX_HTTP,applicationBodyBytes:MAX_BYTES,workMs:WORK_MS,cleanupMs:CLEANUP_MS},requests:[],cases:[],assertions:[],cleanup:{},realPostgresQueries:0,modelCalls:0};
  let service,server,browserServer,browser,context,page,revoked=false,fakeQueries=0,bodyBytes=0,cleaning=false,cleanupEnd=totalEnd,fatal=null;
  const sockets=new Set(),remaining=()=>Math.max(0,(cleaning?cleanupEnd:workEnd)-Date.now());
  async function bounded(start,ms,code,cancel=()=>{}){if(remaining()<=0){try{cancel()}catch{}throw failure('PROBE_DEADLINE')}let timer;try{return await Promise.race([start(),new Promise((_,reject)=>{timer=setTimeout(()=>{try{cancel()}catch{}reject(failure(code))},Math.min(ms,remaining()))})])}finally{clearTimeout(timer)}}
  const charge=bytes=>{bodyBytes+=bytes;if(bodyBytes>MAX_BYTES){fatal='BODY_LIMIT';throw failure(fatal)}};
  const observe=(name,valid)=>report.assertions.push({name,passed:!!valid});
  try{
    // Override only this owned test process. An accidental unmocked connection
    // cannot reach the shared PG fixture. No inherited DATABASE_URL is read.
    process.env.DATABASE_URL='postgres://memz_app:memz_demo_only@127.0.0.1:1/memz_cache_test';
    service=require('../server');
    service.pool.connect=async()=>{
      const client=new EventEmitter();client.user=null;client.release=()=>{};
      client.query=async(sql,params=[])=>{
        fakeQueries++;check(fakeQueries<=64,'FAKE_QUERY_LIMIT');
        if(sql.startsWith('BEGIN'))return {command:'BEGIN',rows:[]};
        if(sql==='COMMIT'||sql==='ROLLBACK')return {command:sql,rows:[]};
        if(sql.includes("set_config('app.user_id'")){client.user=Number(params[0]);return {command:'SELECT',rows:[]}};
        if(sql.startsWith('SELECT p.id,p.name,m.role'))return {command:'SELECT',rows:params[0]===1&&!revoked?[{id:1,name:'Original synthetic owner project',role:'owner'}]:params[0]===4?[{id:2,name:'Original synthetic other project',role:'member'}]:[]};
        if(sql.startsWith('SELECT role FROM memberships'))return {command:'SELECT',rows:client.user===1&&!revoked?[{role:'owner'}]:[]};
        if(sql.startsWith('SELECT f.id,f.subject'))return {command:'SELECT',rows:[{id:1,subject:'Original synthetic owner-only subject',predicate:'status',version:1,value:'Original synthetic value',source:'Original synthetic source'}]};
        throw failure('UNEXPECTED_SYNTHETIC_SQL');
      };return client;
    };
    server=http.createServer((request,response)=>{
      if(report.requests.length>=MAX_HTTP){fatal='HTTP_LIMIT';request.destroy();return}
      const row={method:request.method,path:request.url.split('?')[0],status:null,etag:false,cacheControl:null};report.requests.push(row);
      request.on('data',bytes=>{try{charge(bytes.length)}catch{request.destroy()}});
      const write=response.write,end=response.end;
      response.write=function(chunk,...args){if(chunk)charge(Buffer.byteLength(chunk));return write.call(this,chunk,...args)};
      response.end=function(chunk,...args){if(chunk)charge(Buffer.byteLength(chunk));return end.call(this,chunk,...args)};
      response.on('finish',()=>{row.status=response.statusCode;row.etag=response.hasHeader('etag');row.cacheControl=response.getHeader('cache-control')||null});
      service.app(request,response);
    });
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
    await bounded(()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)}),3000,'LISTEN_TIMEOUT');
    const base='http://127.0.0.1:'+server.address().port;
    browserServer=await chromium.launchServer({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),host:'127.0.0.1',headless:true,timeout:15000,args:['--no-sandbox','--disable-background-networking']});
    browser=await chromium.connect(browserServer.wsEndpoint(),{timeout:5000});report.environment.chromium=browser.version();
    context=await browser.newContext();page=await context.newPage();page.on('pageerror',()=>{fatal='BROWSER_PAGE_ERROR'});
    await page.goto(base+'/health/live',{waitUntil:'load',timeout:10000});
    async function call(label,route,options={}){
      const method=options.method||'GET',pathname=route.split('?')[0],count=()=>report.requests.filter(row=>row.method===method&&row.path===pathname).length,before=count();
      const result=await bounded(()=>page.evaluate(async({route,options,timeout})=>{
        const response=await fetch(route,{...options,signal:AbortSignal.timeout(timeout)}),text=await response.text();let value;try{value=JSON.parse(text)}catch{value=null}
        return {status:response.status,value,etag:response.headers.has('etag'),cacheControl:response.headers.get('cache-control')};
      },{route,options,timeout:Math.max(1,Math.min(10000,remaining()))}),11000,'BROWSER_FETCH_TIMEOUT',()=>{page.close().catch(()=>{})});
      const entry={label,status:result.status,serverRequests:count()-before,cacheControl:result.cacheControl,etag:result.etag,isOwnerIdentity:result.value?.name==='负责人',isOwnerProject:Array.isArray(result.value)&&result.value[0]?.id===1,isOtherProject:Array.isArray(result.value)&&result.value[0]?.id===2,ownerFacts:!!result.value?.facts?.length};
      report.cases.push(entry);return {...result,entry};
    }
    async function login(actor){return call('login-'+actor,'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:actor,password:'demo-'+actor})})}
    async function logout(label,auth){return call('logout-'+label,'/api/logout',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':auth.value.csrf},body:'{}'})}
    const owner=await login('owner');observe('initial real session login succeeds',owner.status===200);
    const ownerMe=await call('owner-me-prime','/api/me'),ownerProjects=await call('owner-projects-prime','/api/projects');observe('owner cache fixtures are real authenticated route bodies',ownerMe.entry.isOwnerIdentity&&ownerProjects.entry.isOwnerProject);
    await logout('owner',owner);
    const loggedOutMe=await call('logged-out-me-force','/api/me',{cache:'force-cache'}),loggedOutProjects=await call('logged-out-projects-force','/api/projects',{cache:'force-cache'});
    observe('force-cache after logout reaches session middleware and returns 401',loggedOutMe.status===401&&loggedOutProjects.status===401&&loggedOutMe.entry.serverRequests===1&&loggedOutProjects.entry.serverRequests===1);
    const defaultMe=await call('logged-out-me-default','/api/me'),defaultProjects=await call('logged-out-projects-default','/api/projects');observe('default fetch after logout keeps its original 401 behavior',defaultMe.status===401&&defaultProjects.status===401&&defaultMe.entry.serverRequests===1&&defaultProjects.entry.serverRequests===1);
    const other=await login('other'),otherMe=await call('other-me-force','/api/me',{cache:'force-cache'}),otherProjects=await call('other-projects-force','/api/projects',{cache:'force-cache'});
    observe('force-cache after account switch cannot return old owner bodies',otherMe.status===200&&!otherMe.entry.isOwnerIdentity&&otherProjects.entry.isOtherProject&&otherMe.entry.serverRequests===1&&otherProjects.entry.serverRequests===1);
    const otherMeDefault=await call('other-me-default','/api/me'),otherProjectsDefault=await call('other-projects-default','/api/projects');observe('default fetch after account switch keeps correct identity/project behavior',otherMeDefault.status===200&&!otherMeDefault.entry.isOwnerIdentity&&otherProjectsDefault.entry.isOtherProject&&otherMeDefault.entry.serverRequests===1&&otherProjectsDefault.entry.serverRequests===1);
    await logout('other',other);
    const ownerAgain=await login('owner'),facts=await call('owner-facts-prime','/api/projects/1/facts');observe('facts fixture was initially authorized',facts.status===200&&facts.entry.ownerFacts);
    revoked=true;const forcedFacts=await call('revoked-facts-force','/api/projects/1/facts',{cache:'force-cache'}),defaultFacts=await call('revoked-facts-default','/api/projects/1/facts');
    observe('force-cache after synthetic permission loss reaches the real role gate and returns 403',forcedFacts.status===403&&!forcedFacts.entry.ownerFacts&&forcedFacts.entry.serverRequests===1);
    observe('default fetch retains its real role-gate 403 behavior',defaultFacts.status===403&&defaultFacts.entry.serverRequests===1);
    const missing=await call('authenticated-api-404','/api/cache-regression-missing');observe('authenticated unknown API route remains 404',missing.status===404);
    await logout('owner-again',ownerAgain);
    const style=await call('static-cache-control','/style.css');observe('API protection does not disable the existing static ETag/cache policy',style.status===200&&style.etag&&style.cacheControl!=='no-store');
    observe('every observed API response including login/logout/errors forbids storage',report.requests.filter(row=>row.path.startsWith('/api/')).every(row=>row.cacheControl==='no-store'));
    observe('every observed native API response retained its original HTTP status',report.requests.every(row=>row.status!==null));
    report.source.after=sources();observe('selected implementation files unchanged during the run',JSON.stringify(report.source.before)===JSON.stringify(report.source.after));
  }catch(error){report.failure=/^[A-Z][A-Z_0-9]*$/.test(error.code||'')?error.code:'BROWSER_HTTP_CACHE_FAILED'}
  finally{
    cleaning=true;cleanupEnd=Math.min(totalEnd,Date.now()+CLEANUP_MS);const failed=[];
    async function clean(name,fn){try{await fn();report.cleanup[name]=true}catch{report.cleanup[name]=false;failed.push(name)}}
    await clean('browserClosed',async()=>{if(context)await bounded(()=>context.close(),3000,'CONTEXT_CLOSE_TIMEOUT');if(browser)await bounded(()=>browser.close(),4000,'BROWSER_CLOSE_TIMEOUT')});
    await clean('browserProcessClosed',async()=>{if(browserServer&&browserServer.process().exitCode===null)try{await bounded(()=>browserServer.close(),3000,'BROWSER_SERVER_CLOSE_TIMEOUT')}catch{browserServer.process().kill('SIGKILL');throw failure('BROWSER_FORCED_CLOSE')}});
    await clean('serverClosed',async()=>{if(server){server.closeAllConnections();for(const socket of sockets)socket.destroy();await bounded(()=>new Promise(resolve=>server.close(resolve)),3000,'SERVER_CLOSE_TIMEOUT')}check(sockets.size===0,'SOCKETS_REMAIN')});
    await clean('poolClosed',async()=>{if(service)await bounded(()=>service.pool.end(),2000,'POOL_CLOSE_TIMEOUT')});
    report.cleanup.failedStages=failed;report.http=report.requests.length;report.fakeQueries=fakeQueries;report.accounting={applicationBodyBytes:bodyBytes,scope:'Actual HTTP request/response bodies including static assets; not headers, wire, browser-control traffic, SQL, heap or hard allocation bound'};
    report.fatal=fatal;report.durationMs=Date.now()-started;report.finishedAt=new Date().toISOString();report.passed=!report.failure&&!fatal&&!failed.length&&report.assertions.length>0&&report.assertions.every(row=>row.passed)&&report.http<=MAX_HTTP&&bodyBytes<=MAX_BYTES&&report.durationMs<=WORK_MS+CLEANUP_MS;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  console.log(JSON.stringify({passed:report.passed,http:report.http,applicationBodyBytes:bodyBytes,failedAssertions:report.assertions.filter(row=>!row.passed).map(row=>row.name),cleanup:report.cleanup,output}));if(!report.passed)process.exitCode=1;
}
if(require.main===module)main().catch(()=>{console.error('BROWSER_HTTP_CACHE_SETUP_FAILED');process.exitCode=1});
