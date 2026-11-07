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
let mockQueries=0;
function fixture(){
  let now=1000;
  const context=vm.createContext({Buffer,setTimeout,clearTimeout,Date:{now:()=>now}});
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
  return {...context.probe,setNow:value=>{now=value}};
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
after(()=>console.log('Synthetic session recovery harness resources:',JSON.stringify({sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),mockQueries,realPostgresQueries:0,httpRequests:0,modelCalls:0,scope:'actual private helper region and cleanup-entry statement, isolated VM; no end-to-end recovery claim'})));
