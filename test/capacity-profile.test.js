// Pure/fake-driver contracts only. No PostgreSQL, HTTP sockets or benchmark run.
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {capacityProfile,ByteLedger,budgetGroup,meterClient,fixtureBounds,jsonBytes,rowsJSON}=require('../evaluation/capacity-budget');
const {dataset,random,initialize,rowCounts,runtimeConfiguration}=require('../evaluation/reader-capacity');
const {validateSnapshot}=require('../scripts/context-snapshot');
const profile=capacityProfile('node-pair-smoke-v1'),records=dataset(),bounds=fixtureBounds(records,profile);
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('legacy stays page25/n80 while the fixed smoke has pair-wide 16MiB and every negative phase',()=>{
  assert.deepEqual(capacityProfile(),{id:'legacy',pageSize:25,perLevel:80,budgeted:false});assert.equal(capacityProfile('legacy').budgeted,false);assert.throws(()=>capacityProfile('unknown'),{code:'UNKNOWN_CAPACITY_PROFILE'});
  assert.equal(profile.pageSize,10);assert.equal(profile.perLevel,32);assert.equal(profile.maxHttpRequests,1+17+3*32+6+12+2+4);assert.equal(profile.maxHttpRequests,138);
  assert.equal(2*(profile.parentBytes+profile.childBytes),16*1024*1024);assert.equal(profile.pairBytes,16*1024*1024);
  assert.equal(records.length,512);assert.equal(records.reduce((sum,row)=>sum+Buffer.byteLength(row.content),0),524288);assert.equal(hash(records),'564ce2e4d666ff078661606987e1e3870d80b05a2a08bf631691aacc6a69693c');assert.ok(bounds.httpSnapshotMaxBytes<profile.httpResponseBytes);
});
test('reservations reject before work, include all inflight work and do not clamp actual overruns',()=>{
  const ledger=new ByteLedger(100),a=ledger.reserve(60),b=ledger.reserve(40);assert.throws(()=>ledger.reserve(1),{code:'BYTE_BUDGET_EXCEEDED'});a.settle(30);assert.equal(ledger.reserved,40);const c=ledger.reserve(30);b.settle(20);c.settle(20);assert.equal(ledger.used,70);assert.equal(ledger.reserved,0);
  const overrun=ledger.reserve(20);assert.throws(()=>overrun.settle(40),{code:'BYTE_PROJECTION_EXCEEDED'});assert.equal(ledger.used,110);assert.equal(ledger.overrunBytes,20);assert.equal(ledger.peakCommitted,110);assert.equal(ledger.overruns,1);
  const group=budgetGroup(100,20);group.work.reserve(80).settle(80);assert.throws(()=>group.work.reserve(1),{code:'BYTE_BUDGET_EXCEEDED'});group.cleanup.reserve(20).settle(10);assert.equal(group.snapshot().used,90);
});
test('Promise and both native callback query shapes settle after completion and never double-wrap a client',async()=>{
  let calls=0,complete;const sentinel={},client={query(sql,params,callback){calls++;if(callback){complete=()=>callback(null,{rows:[{n:1}]});return sentinel}return Promise.resolve({rows:[{n:1}]})}};
  const group=budgetGroup(4096,128),bound=()=>128;meterClient(client,group,bound);meterClient(client,group,bound);
  await client.query('SELECT synthetic',[]);assert.equal(calls,1);assert.equal(group.work.operations,1);
  for(const withValues of [false,true]){
    const promise=new Promise((resolve,reject)=>{const callback=(error,result)=>error?reject(error):resolve(result);const value=withValues?client.query('SELECT synthetic',[1],callback):client.query('SELECT synthetic',callback);assert.equal(value,sentinel)});
    assert.ok(group.work.reserved>0);assert.equal(group.work.operations,withValues?2:1);complete();assert.deepEqual(await promise,{rows:[{n:1}]});assert.equal(group.work.reserved,0);
  }
  assert.equal(group.work.operations,3);assert.equal(calls,3);assert.throws(()=>meterClient(client,budgetGroup(4096,128),bound),{code:'DUPLICATE_BUDGET_CLIENT'});
});
test('bad bounds and unknown callback queries fail before original query; primary SQL errors retain input accounting',async()=>{
  for(const resultBound of [-1,NaN,1.2,undefined]){let calls=0;const client=meterClient({query(){calls++}},budgetGroup(1024,128),()=>resultBound);await assert.rejects(client.query('SELECT synthetic'),{code:'INVALID_PG_RESULT_BOUND'});assert.equal(calls,0)}
  let calls=0;const group=budgetGroup(4096,128),primary=new Error('synthetic-primary'),client=meterClient({query(sql,params,callback){calls++;if(callback){callback(primary);return}return Promise.reject(primary)}},group,()=>128);
  await assert.rejects(client.query('SELECT synthetic'),error=>error===primary);await new Promise(resolve=>client.query('SELECT synthetic',error=>{assert.equal(error,primary);resolve()}));assert.equal(calls,2);assert.equal(group.work.reserved,0);assert.equal(group.work.used,2*(Buffer.byteLength('SELECT synthetic')+jsonBytes([])));
  const unknown=meterClient({query(){assert.fail('must reject before querying')}},budgetGroup(1024,128),()=>{throw Object.assign(new Error('UNSUPPORTED_BUDGET_QUERY'),{code:'UNSUPPORTED_BUDGET_QUERY'})});await new Promise(resolve=>unknown.query('unknown',error=>{assert.equal(error.code,'UNSUPPORTED_BUDGET_QUERY');resolve()}));
});
test('multi-statement rows are all counted; unexpected materialization is explicit failure',async()=>{
  assert.deepEqual(rowsJSON([{rows:[{one:1}]},{rows:[{two:2}]}]),[[{one:1}],[{two:2}]]);assert.throws(()=>rowsJSON([{}]),{code:'UNMEASURABLE_PG_RESULT'});
  const group=budgetGroup(4096,128),client=meterClient({query:async()=>({rows:[{value:'x'.repeat(100)}]})},group,()=>2);
  await assert.rejects(client.query('SELECT synthetic'),{code:'BYTE_PROJECTION_EXCEEDED'});assert.equal(group.work.overruns,1);assert.ok(group.work.used>100);assert.equal(group.work.reserved,0);
});
test('runtime selection is explicit, Node24-only for the small driver and never accepts a shell/import',()=>{
  assert.equal(runtimeConfiguration(capacityProfile(),undefined,'v22.0.0'),null);
  assert.throws(()=>runtimeConfiguration(profile,process.execPath,'v22.0.0'),{code:'LOAD_GENERATOR_NODE24_REQUIRED'});
  for(const value of [undefined,'node','/bin/sh','file:///tmp/node','/tmp/node --eval bad','/tmp/node\0'])assert.throws(()=>runtimeConfiguration(profile,value,'v24.0.0'),{code:'TRUSTED_NODE_BINARY_REQUIRED'});
  if(/^v(22|24)\./.test(process.version)){const selected=runtimeConfiguration(profile,process.execPath,'v24.0.0');assert.equal(selected.version,process.version);assert.equal(selected.executable,fs.realpathSync(process.execPath))}
});

test('small-profile child/connection/drop failures continue owned cleanup before rejecting',async()=>{
  const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../evaluation/reader-capacity.js'),'utf8');
  const body=source.slice(source.indexOf('    const cleanup=async()=>{'),source.indexOf('    try{await Promise.race([cleanup()'));
  assert.ok(body.startsWith('    const cleanup=async()=>{'));
  for(const mode of ['child_nonzero','child_forced','owner_end','admin_end','drop','cleaner_end','owner_hang','admin_hang','connect_hang','drop_hang','cleaner_hang']){
    const calls=[],report={cleanup:{}},synthetic=()=>Object.assign(new Error('synthetic'),{code:'SYNTHETIC'});
    const hang=()=>new Promise(()=>{});
    const connection={stream:{destroy(){calls.push('destroy')}}};
    const cleaner={connection,on(){},async connect(){calls.push('cleaner.connect');if(mode==='connect_hang')return hang()},async query(){calls.push('drop');if(mode==='drop')throw synthetic();if(mode==='drop_hang')return hang()},async end(){calls.push('cleaner.end');if(mode==='cleaner_end')throw synthetic();if(mode==='cleaner_hang')return hang()}};
    const context={profile,report,child:{},childExited:true,childResult:{code:mode==='child_nonzero'?1:0,signal:null},childForced:mode==='child_forced',
      owner:{connection,async end(){calls.push('owner.end');if(mode==='owner_end')throw synthetic();if(mode==='owner_hang')return hang()}},admin:{connection,async end(){calls.push('admin.end');if(mode==='admin_end')throw synthetic();if(mode==='admin_hang')return hang()}},
      created:true,adminURL:{href:'synthetic-local-only'},meter:null,database:'memz_capacity_0000000000000000',
      directClient:()=>cleaner,checkCleanup(){},fail:code=>Object.assign(new Error(code),{code}),setTimeout:(fn,ms)=>setTimeout(fn,ms/1000),clearTimeout};
    const cleanup=vm.runInNewContext(body+'\ncleanup',context);
    await assert.rejects(cleanup(),error=>error.code===(mode.startsWith('child_')?'CHILD_CLEANUP_FAILED':'RESOURCE_CLEANUP_FAILED'));
    assert.deepEqual(calls.filter(call=>call!=='destroy'),['owner.end','admin.end','cleaner.connect',...(mode==='connect_hang'?[]:['drop']),'cleaner.end']);
    assert.equal(report.cleanup.temporaryDatabaseDropped,['drop','drop_hang','connect_hang'].includes(mode)?undefined:true);
    assert.equal(report.cleanup.ownerClosed,['owner_end','owner_hang'].includes(mode)?undefined:true);
    assert.equal(report.cleanup.adminClosed,!['admin_end','cleaner_end','admin_hang','cleaner_hang'].includes(mode));
    if(mode.endsWith('_hang'))assert.ok(calls.includes('destroy'));
  }
});
test('clock crossing cleanup deadline destroys remaining owned handles even before the timer fires',async()=>{
  const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../evaluation/reader-capacity.js'),'utf8');
  const body=source.slice(source.indexOf('    const stopOwned=()=>{'),source.indexOf('    report.cleanup.elapsedMs='));
  const calls=[],primary=Object.assign(new Error('synthetic-primary'),{code:'SYNTHETIC'});let expired=false;
  const context={profile,report:{cleanup:{}},child:null,childExited:true,childResult:null,childForced:false,
    owner:{connection:{stream:{destroy(){calls.push('owner.destroy')}}},async end(){calls.push('owner.end');expired=true}},
    admin:{connection:{stream:{destroy(){calls.push('admin.destroy')}}},async end(){assert.fail('deadline must not start new operations')}},
    created:true,cleanupTimer:undefined,cleanupExpired:false,CLEANUP_MS:10000,failure:primary,
    checkCleanup(){if(expired)throw Object.assign(new Error('CLEANUP_DEADLINE'),{code:'CLEANUP_DEADLINE'})},
    fail:code=>Object.assign(new Error(code),{code}),setTimeout,clearTimeout};
  await vm.runInNewContext('(async()=>{'+body+'})()',context);
  assert.deepEqual(calls,['owner.end','owner.destroy','admin.destroy']);assert.equal(context.failure,primary);
  assert.equal(context.report.status,'failed');assert.equal(context.report.cleanup.errorCode,'CLEANUP_FAILED');
  assert.equal(context.report.cleanup.temporaryDatabaseDropped,undefined);assert.equal(context.report.cleanup.adminClosed,undefined);
});

// Exercise the real context route and its query text against an original tiny
// in-memory store, then run every phase at real concurrency without I/O. This
// checks reservations including initialization's repeated 601KiB JSON values.
const service=require('../server'),originalConnect=service.pool.connect;
after(async()=>{service.pool.connect=originalConnect;await service.pool.end()});
test('complete fixed profile fits parent/child partitions including real-route inflight reservations and cleanup',async t=>{
  const parent=budgetGroup(profile.parentBytes,profile.cleanupBytes),child=budgetGroup(profile.childBytes,profile.cleanupBytes);
  const store=records.map((row,i)=>({...row,id:i+2,source_id:i+5})),projectOne=store.slice(0,256),counts={projects:2,memberships:4,sources:516,facts:513,candidates:513,revisions:513,audit:513,idempotency_requests:0};
  const ownerSQL=[];const owner=meterClient({query:async(sql)=>{ownerSQL.push(sql);if(sql.startsWith('SELECT count(*) AS n FROM '))return {rows:[{n:String(counts[sql.split(' ').at(-1)])}]};if(sql.includes('CREATE TABLE projects'))return Array.from({length:55},()=>({rows:[]}));return {rows:[]}}},parent,bounds.parent);
  const readerSource=fs.readFileSync(path.join(__dirname,'../evaluation/reader-capacity.js'),'utf8');
  const queryFrom=prefix=>{const match=[...readerSource.matchAll(/owner\.query\(`([\s\S]*?)`/g)].find(m=>m[1].startsWith(prefix));assert.ok(match);return match[1]};
  const actualSQL=queryFrom('SELECT f.project_id'),pagesSQL=queryFrom('SELECT f.id,f.subject');
  const rawOwnerQuery=owner.query;
  // Override the raw producer, then meter a separate client; never replace the
  // already-metered query and accidentally bypass its reservation.
  const controller=meterClient({query:async(sql,params)=>{
    if(sql===actualSQL)return {rows:records};
    if(sql===pagesSQL)return {rows:projectOne.map(row=>({id:row.id,subject:row.subject,predicate:row.predicate,value:row.value,version:1,source_id:row.source_id,title:row.title,content:row.content}))};
    if(sql.startsWith('SHOW '))return {rows:[{[sql.slice(5)]:sql.includes('version')?'16.15':'100'}]};
    if(sql.startsWith('SELECT count(*)::int AS connections'))return {rows:[{connections:1,active:0}]};
    // The initialization producer is unmetered here; the public initialize()
    // is separately exercised below through the original metered owner.
    return {rows:[]};
  }},parent,bounds.parent);
  assert.equal(typeof rawOwnerQuery,'function');
  await controller.query('SHOW server_version');await controller.query('SHOW max_connections');await controller.query('CREATE DATABASE memz_capacity_0000000000000000');
  await owner.query(fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));await rowCounts(owner);await initialize(owner,records);await rowCounts(owner);
  await controller.query(actualSQL,['容量基准']);await controller.query(pagesSQL,['容量基准']);
  const noiseSQL=queryFrom('SELECT count(*)::int AS connections');await controller.query(noiseSQL);
  let saturated=false,attempts=0;
  const makeClient=()=>{
    const client=new EventEmitter();let identity='';client.release=()=>{};
    client.query=async(sql,params=[])=>{
      const flat=sql.replace(/\s+/g,' ').trim();
      if(sql.includes('set_config(')){identity=params[0];return {rows:[{set_config:identity}],command:'SELECT'}}
      if(flat.startsWith('SELECT role FROM memberships'))return {rows:(identity==='3'&&params[0]===1)?[{role:'viewer'}]:[],command:'SELECT'};
      if(flat.startsWith('SELECT f.id,f.subject,f.predicate,f.version,r.value,'))return {rows:projectOne.filter(row=>row.id>params[2]).slice(0,params[3]).map(row=>({id:row.id,subject:row.subject,predicate:row.predicate,version:1,value:row.value,revision_id:row.id,source_id:row.source_id})),command:'SELECT'};
      if(flat.startsWith('SELECT f.id AS fact_id'))return {rows:params[1].map(id=>{const row=store.find(row=>row.id===id);return {fact_id:id,subject:row.subject,predicate:row.predicate,revision_id:id,version:1,value:row.value,created_at:new Date('2026-11-07T00:00:00.000Z'),approved_by:1,source_id:row.source_id,candidate_id:id,expected_version:0,proposed_by:1,candidate_source_id:row.source_id,candidate_subject:row.subject,candidate_predicate:row.predicate,candidate_value:row.value,candidate_status:'approved'}}),command:'SELECT'};
      if(flat.startsWith('SELECT id,title,content FROM sources'))return {rows:params[1].map(id=>{const row=store.find(row=>row.source_id===id);return {id,title:row.title,content:row.content}}),command:'SELECT'};
      return {rows:[],command:sql.split(' ')[0]};
    };return meterClient(client,child,bounds.child);
  };
  service.pool.connect=()=>saturated?Promise.reject(new Error('timeout exceeded when trying to connect')):Promise.resolve(makeClient());
  const route=service.app.router.stack.find(layer=>layer.route?.path==='/api/projects/:p/context').route.stack[0].handle;
  const errors=service.app.router.stack.findLast(layer=>layer.handle.length===4).handle;
  const pages=[0,49,99,149,199].map(position=>position===0?0:projectOne[position].id);
  async function context(after,{expected=200,user=3,project=1}={}){
    const bound=expected===200?profile.httpResponseBytes:profile.smallResponseBytes,reservation=parent.work.reserve(bound);attempts++;
    const req={method:'GET',params:{p:String(project)},user:{id:user},query:{q:'容量基准',limit:'10',after:String(after)}};
    let status=200,body;
    const res={headersSent:false,type(){return this},set(){return this},status(value){status=value;return this},send(value){body=value;return this},json(value){body=JSON.stringify(value);return this}};
    const originalLog=console.error;console.error=()=>{};
    try{await route(req,res,error=>errors(error,req,res,assert.fail));assert.equal(status,expected);assert.equal(typeof body,'string');reservation.settle(Buffer.byteLength(body));if(expected===200)validateSnapshot(JSON.parse(body),{projectId:1,query:'容量基准',limit:10,after,search:null})}finally{console.error=originalLog}
  }
  async function phase(concurrency,count,expected=200){const next=random(42),sequence=Array.from({length:count},()=>Math.floor(next()*pages.length));let index=0;await Promise.all(Array.from({length:concurrency},async()=>{while(index<count){const i=index++;await context(pages[sequence[i]],{expected})}}))}
  // Exact login/logout body shapes are included although they never touch PG.
  for(const name of ['viewer','other']){const input=jsonBytes({username:name,password:'demo-'+name}),response=jsonBytes({name:name==='viewer'?'只读者':'另一项目用户',csrf:'x'.repeat(48)}),token=parent.work.reserve(input+profile.smallResponseBytes);token.settle(input+response);attempts++}
  await phase(1,1);for(const concurrency of [1,4,12]){await phase(concurrency,concurrency);await phase(concurrency,32)}
  saturated=true;await phase(6,6,503);saturated=false;await phase(6,12);
  await context(0,{expected:403,user:3,project:2});await context(0,{expected:403,user:4,project:1});
  await controller.query(noiseSQL);await rowCounts(owner);
  for(let i=0;i<2;i++){parent.work.reserve(profile.smallResponseBytes).settle(jsonBytes({ok:true}));attempts++}
  await controller.query('DROP DATABASE memz_capacity_0000000000000000 WITH (FORCE)');
  const p=parent.snapshot(),c=child.snapshot();assert.equal(attempts,138);assert.equal(p.reserved,0);assert.equal(c.reserved,0);assert.equal(p.work.denied+c.work.denied,0);assert.equal(p.work.overruns+c.work.overruns,0);assert.ok(p.used<profile.parentBytes);assert.ok(c.used<profile.childBytes);assert.ok(2*(p.used+c.used)<profile.pairBytes);
  assert.equal(ownerSQL.filter(sql=>sql.includes('jsonb_to_recordset($1::jsonb)')).length,3);assert.ok(p.cleanup.used>0);assert.ok(c.cleanup.used>0);
  t.diagnostic(JSON.stringify({synthetic:true,noDatabaseOrHTTP:true,attempts,parentUsed:p.used,childUsed:c.used,parentPeakCommitted:p.work.peakCommitted,childPeakCommitted:c.work.peakCommitted,pairProjectedUsed:2*(p.used+c.used),pairLimit:profile.pairBytes}));
});
