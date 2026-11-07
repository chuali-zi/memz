// Execute the integration harness's actual private helpers in an isolated VM.
// No copy of their control logic, exported production hook, real PG or HTTP.
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const filename=path.join(__dirname,'session-recovery.js'),source=fs.readFileSync(filename,'utf8');
const first=source.indexOf('  const remaining='),last=source.indexOf('  async function endClient');
assert.ok(first>=0&&last>first,'locate the private helper region; update this fixture if helpers move');
const helpers=source.slice(first,last);
// Extract, then execute the real cleanup-entry assignment. Its arithmetic is
// tested below; neither Math.min nor a particular time expression is asserted.
const entry=source.match(/cleaning\s*=\s*true\s*;\s*cleanupEnd\s*=\s*([^;]+);/);
assert.ok(entry,'locate the actual cleanup-entry assignment');
let mockQueries=0,mockUpstreamFetches=0;
function fixture(){
  let now=1000;
  const context=vm.createContext({Buffer,URL,setTimeout,clearTimeout,Date:{now:()=>now}});
  vm.runInContext(`
    const CLEANUP_BYTES=65536,CLEANUP_MS=60000,BYTE_LIMIT=8388608;
    const workEnd=600000,totalEnd=660000,dbName='memz_session_recovery_owned_probe';
    let cleanupEnd=totalEnd,cleanupBytes=0,workBytes=0,cleaning=true,fatal=null;
    const failure=code=>Object.assign(new Error(code),{code});
    const check=(condition,code)=>{if(!condition)throw failure(code)};
    ${helpers}
    globalThis.probe={bounded,terminalOwnedQuery,remaining,
      setBudget:value=>cleanupBytes=value,expire:()=>cleanupEnd=0,
      state:()=>({fatal,cleanupBytes}),enter:()=>{${entry[0]}}};
  `,context,{filename});
  return {...context.probe,context,setNow:value=>{now=value}};
}
const ownedDrop='DROP DATABASE memz_session_recovery_owned_probe WITH (FORCE)';
test('exhausted cleanup accounting cannot prevent native owned DROP and acknowledgement',async()=>{
  const p=fixture();p.setBudget(65537);let calls=0,acknowledged=false;
  const result={get rows(){assert.equal(acknowledged,true,'ownership state must update before result accounting');return []}};
  await p.terminalOwnedQuery({query:async()=>{mockQueries++;calls++;return result}},ownedDrop,[],()=>{acknowledged=true});
  assert.equal(calls,1);assert.equal(acknowledged,true);assert.equal(p.state().fatal,'CLEANUP_BYTE_LIMIT');assert.ok(p.state().cleanupBytes>65536,'record excess without pretending the run stayed within budget');
});
test('terminal cleanup rejects unrelated databases and unrelated catalog parameters before transport',async()=>{
  const p=fixture();let calls=0;const client={query:async()=>{mockQueries++;calls++;return {rows:[]}}};
  await assert.rejects(()=>p.terminalOwnedQuery(client,'DROP DATABASE memz_session_recovery_unowned WITH (FORCE)'),e=>e.code==='UNOWNED_TERMINAL_QUERY');
  await assert.rejects(()=>p.terminalOwnedQuery(client,'SELECT count(*)::int AS n FROM pg_catalog.pg_database WHERE datname=$1',['memz_session_recovery_unowned']),e=>e.code==='UNOWNED_TERMINAL_QUERY');
  assert.equal(calls,0);
});
test('an expired deadline cancels once and never starts the supplied operation',async()=>{
  const p=fixture();p.expire();let started=0,cancelled=0;
  await assert.rejects(()=>p.bounded(()=>{started++;return Promise.resolve()},10,'SYNTHETIC_TIMEOUT',()=>{cancelled++}),e=>e.code==='CLEANUP_DEADLINE');
  assert.equal(started,0);assert.equal(cancelled,1);
});
test('expired terminal cleanup destroys its client without sending SQL or claiming a DROP acknowledgement',async()=>{
  const p=fixture();p.expire();let calls=0,destroyed=0,acknowledged=false;
  const client={query:async()=>{mockQueries++;calls++;return {rows:[]}},connection:{stream:{destroy(){destroyed++}}}};
  await assert.rejects(()=>p.terminalOwnedQuery(client,ownedDrop,[],()=>{acknowledged=true}),e=>e.code==='CLEANUP_DEADLINE');
  assert.equal(calls,0);assert.equal(destroyed,1);assert.equal(acknowledged,false);
});
test('native terminal SQL failure retains the original error and cannot acknowledge a DROP',async()=>{
  const p=fixture();p.setBudget(65537);const primary=new Error('Fixed synthetic native SQL failure');let acknowledged=false;
  await assert.rejects(()=>p.terminalOwnedQuery({query:async()=>{mockQueries++;throw primary}},ownedDrop,[],()=>{acknowledged=true}),error=>error===primary);
  assert.equal(acknowledged,false);assert.equal(p.state().fatal,'CLEANUP_BYTE_LIMIT');
});
test('cleanup receives at most 60 seconds even when work ends early and never extends the total deadline',()=>{
  const p=fixture();p.enter();assert.equal(p.remaining(),60000);
  p.setNow(650000);p.enter();assert.equal(p.remaining(),10000);
  p.setNow(660001);assert.equal(p.remaining(),0);
});
const admission=source.slice(source.indexOf('  function admit('),source.indexOf('  async function startCLI('));
const routeStart=source.indexOf("    await context.route('**/*'"),routeEnd=source.indexOf("    stage='initial-login'",routeStart);
assert.ok(routeStart>=0&&routeEnd>routeStart,'locate the actual forwarding registration');
async function routeFixture({status=200,bodyFailure=false,disposeFailure=false,drop=false,primary=null}={}){
  const p=fixture();let callback,fetches=0,fulfills=0,aborts=0,disposals=0,options;
  p.context.register=async(_pattern,handler)=>{callback=handler};
  vm.runInContext(`
    const MAX_HTTP=64,MAX_BODY=131072,report={http:[],observationFailures:[]};
    const observations=new Set(),writeKeys=[];
    let base='http://127.0.0.1:12345',loseNext=${drop},originalKey,firstId;
    const loss={resolve(){},reject(){}};const context={route:register};
    function deferred(){let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve}}
    ${admission}
    fatal=${JSON.stringify(primary)};
  `,p.context);
  await vm.runInContext(`(async()=>{${source.slice(routeStart,routeEnd)}})()`,p.context);
  const body=Buffer.from(JSON.stringify(drop?{id:5,project_id:1}:{synthetic:true}));
  const response={status:()=>status,body:async()=>{if(bodyFailure)throw Object.assign(new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'),{code:'SYNTHETIC_BODY_FAILED'});return body},dispose:async()=>{disposals++;if(disposeFailure)throw new Error('SYNTHETIC_PRIVATE_DISPOSE')}};
  const route={request:()=>({url:()=>'http://127.0.0.1:12345'+(drop?'/api/projects/1/sources':'/api/projects'),method:()=>drop?'POST':'GET',postDataBuffer:()=>null,headers:()=>({'idempotency-key':'synthetic-owned-key'})}),
    fetch:async value=>{mockUpstreamFetches++;fetches++;options=value;return response},
    fulfill:async value=>{fulfills++;assert.ok(value.response===response,'forward the actual status/headers object');assert.ok(value.body===body,'forward exactly the already observed bytes')},abort:async()=>{aborts++}};
  await callback(route);
  const state=JSON.parse(vm.runInContext('JSON.stringify({fatal,rows:report.http,failures:report.observationFailures,tracking:observations.size,firstId})',p.context));
  return {fetches,fulfills,aborts,disposals,options,state};
}
test('forwarding performs one upstream attempt with no redirects/retries and preserves actual response bytes',async()=>{
  const r=await routeFixture({status:401});assert.equal(r.fetches,1);assert.equal(r.options.maxRedirects,0);assert.equal(r.options.maxRetries,0);assert.equal(r.fulfills,1);assert.equal(r.aborts,0);assert.equal(r.disposals,1);assert.equal(r.state.rows[0].status,401);assert.equal(r.state.rows[0].upstreamAttempts,1);assert.equal(r.state.tracking,0);assert.equal(r.state.fatal,null);
});
test('upstream body failure is not fulfilled or retried and preserves the earlier primary failure',async()=>{
  const r=await routeFixture({bodyFailure:true,disposeFailure:true,primary:'ORIGINAL_PRIMARY'});assert.equal(r.fetches,1);assert.equal(r.fulfills,0);assert.equal(r.aborts,1);assert.equal(r.disposals,1);assert.equal(r.state.fatal,'ORIGINAL_PRIMARY');assert.deepEqual(r.state.failures.map(row=>row.code),['SYNTHETIC_BODY_FAILED','UPSTREAM_DISPOSE_FAILED']);assert.equal(r.state.tracking,0);assert.ok(!JSON.stringify(r.state).includes('SYNTHETIC_PRIVATE'),'raw diagnostic reasons must not enter persistent observations');
});
test('upstream redirects fail closed without a second attempt or fulfilled page response',async()=>{
  const r=await routeFixture({status:302});assert.equal(r.fetches,1);assert.equal(r.fulfills,0);assert.equal(r.aborts,1);assert.equal(r.disposals,1);assert.equal(r.state.fatal,'UNEXPECTED_UPSTREAM_REDIRECT');assert.equal(r.state.tracking,0);
});
test('the deliberately lost source reply is aborted only after its one real 200 body was observed',async()=>{
  const r=await routeFixture({drop:true});assert.equal(r.fetches,1);assert.equal(r.fulfills,0);assert.equal(r.aborts,1);assert.equal(r.disposals,1);assert.equal(r.state.firstId,5);assert.equal(r.state.rows[0].syntheticLostReplyAfterServer200,true);assert.ok(r.state.rows[0].responseBytes>0);assert.equal(r.state.fatal,null);
});
test('route-drain failure and existing observation failure cannot prevent context/browser closure',async()=>{
  const p=fixture(),calls=[];p.context.closed=name=>{calls.push(name)};
  const start=source.indexOf("    await clean('otherContextClosed'"),end=source.indexOf("    await clean('browserProcessClosed'",start);
  assert.ok(start>=0&&end>start,'locate the actual browser cleanup stages');
  const clean=source.match(/async function clean\(name,fn\)\{[^\n]+/)[0];
  await vm.runInContext(`(async()=>{
    const report={failure:'ORIGINAL_PRIMARY',cleanup:{}},failed=[],observations=new Set();
    const otherContext=null,context={unrouteAll:async()=>{throw new Error('synthetic route drain failure')},close:async()=>closed('context')},browser={close:async()=>closed('browser')};
    fatal='HTTP_OBSERVATION_FAILED';
    ${admission}
    ${clean}
    ${source.slice(start,end)}
    globalThis.cleanupResult={failure:report.failure,cleanup:report.cleanup,failed,fatal};
  })()`,p.context);
  assert.deepEqual(calls,['context','browser']);assert.equal(p.context.cleanupResult.failure,'ORIGINAL_PRIMARY');assert.equal(p.context.cleanupResult.fatal,'HTTP_OBSERVATION_FAILED');assert.equal(p.context.cleanupResult.cleanup.routesDrained,false);assert.equal(p.context.cleanupResult.cleanup.contextClosed,true);assert.equal(p.context.cleanupResult.cleanup.browserClosed,true);
});
after(()=>console.log('Synthetic session recovery harness resources:',JSON.stringify({sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),mockQueries,mockUpstreamFetches,realPostgresQueries:0,httpRequests:0,modelCalls:0,scope:'actual private helper region, forwarding callback and cleanup statements, isolated VM; no end-to-end recovery claim'})));
