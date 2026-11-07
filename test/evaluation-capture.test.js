const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {captureQueries}=require('../evaluation/capture-queries');
const {runTransaction}=require('../scripts/database');
const protocol=require('../scripts/exact-context-protocol');
const root=path.resolve(__dirname,'..');
const selected=sql=>typeof sql==='string'&&sql.startsWith('SELECT');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const clean=value=>JSON.parse(JSON.stringify(value));

// This stub implements pg's callback and Promise checkout signatures and its
// per-checkout release closure. It creates no TCP connection or database.
class NativeLikePool{
  constructor({handoffError,beforeCallback=false,connectError,queryError,releaseError,rows=()=>[]}={}){
    Object.assign(this,{handoffError,beforeCallback,connectError,queryError,releaseError,rows,Promise});
    this.clients=[];this.idle=[];this.releases=[];this.calls=[];this.checkouts=0;
  }
  connect(callback){
    assert.ok(this instanceof NativeLikePool);this.checkouts++;
    const deliver=done=>queueMicrotask(()=>{
      if(this.connectError){done(this.connectError);return}
      const client=this.idle.pop()||this.createClient();client.removeListener('error',client.idleListener);
      let released=false;
      client.nativeRelease=client.release=error=>{
        assert.equal(released,false,'native release is once per checkout');released=true;
        assert.equal(client.query,client.nativeQuery,'capture restores query before native release');
        assert.equal(client.release,client.nativeRelease,'capture restores release before native release');
        this.releases.push({client,error});if(this.releaseError)throw this.releaseError;
        if(!error){client.on('error',client.idleListener);this.idle.push(client)}
        return 'native-release-result';
      };
      const failure=()=>{client.broken=this.handoffError;client.errorListenerCount=client.listenerCount('error');client.emit('error',this.handoffError)};
      if(this.handoffError&&this.beforeCallback)queueMicrotask(failure);
      done(null,client,client.release);
      if(this.handoffError&&!this.beforeCallback)queueMicrotask(failure);
    });
    if(callback){deliver(callback);return}
    return new Promise((resolve,reject)=>deliver((error,client)=>error?reject(error):resolve(client)));
  }
  createClient(){
    const pool=this,client=new EventEmitter();client.idleListener=()=>{};
    client.nativeQuery=client.query=function(...args){
      assert.equal(this,client);pool.calls.push({client,args});
      const failure=client.broken||pool.queryError,sql=typeof args[0]==='string'?args[0]:args[0].text;
      const callback=typeof args.at(-1)==='function'?args.at(-1):args[0]?.callback;
      const value={rows:pool.rows(sql,args[1]),command:sql.split(' ')[0]};
      if(callback){process.nextTick(()=>callback(failure,value));return}
      return failure?Promise.reject(failure):Promise.resolve(value);
    };
    this.clients.push(client);return client;
  }
}
function captureSource(source){
  const start=source.indexOf('async function capture(');assert.ok(start>=0);
  const brace=source.indexOf('{',start);let depth=1,i=brace+1;
  for(;depth&&i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--}
  assert.equal(depth,0);return source.slice(start,i);
}
function evaluator(file,pool){
  const source=fs.readFileSync(path.join(root,file),'utf8');
  return vm.runInNewContext(captureSource(source)+';capture',{service:{pool},assert,captureQueries});
}
for(const file of ['evaluation/query-plans.js','evaluation/exact-reader-plans.js'])for(const beforeCallback of [false,true])test(`${file}: checkout failure ${beforeCallback?'before':'after'} callback keeps its error and skips business SQL`,async()=>{
  const failure=Object.assign(new Error('synthetic handoff failure'),{code:'ECONNRESET'}),pool=new NativeLikePool({handoffError:failure,beforeCallback}),connect=pool.connect;let calls=0;
  await assert.rejects(evaluator(file,pool)(()=>runTransaction(pool,1,async()=>{calls++;return 1})),error=>error===failure);
  assert.equal(calls,0);assert.equal(pool.connect,connect);assert.equal(pool.releases.length,1);assert.equal(pool.releases[0].error,failure);
  if(beforeCallback)assert.equal(pool.calls.length,0,'a bridged checkout error must not forward even BEGIN');
  assert.ok(pool.clients[0].errorListenerCount>=1);assert.equal(pool.clients[0].listenerCount('error'),0);
});
test('normal query arguments, callback checkout release and native method identities are preserved',async()=>{
  const pool=new NativeLikePool({rows:()=>[{value:'synthetic'}]}),connect=pool.connect,params=[7,'literal😀'];
  const output=await captureQueries(pool,()=>new Promise((resolve,reject)=>{
    pool.connect((error,client,done)=>{
      if(error){reject(error);return}
      assert.equal(done,client.release);
      client.query('SELECT literal FROM sources',params,(failure,value)=>{
        try{assert.equal(failure,undefined);assert.equal(done(),'native-release-result');resolve(value)}catch(error){reject(error)}
      });
    });
  }),selected);
  assert.deepEqual(output.result.rows,[{value:'synthetic'}]);assert.deepEqual(output.queries,[{sql:'SELECT literal FROM sources',params}]);assert.equal(pool.calls[0].args[1],params);
  assert.equal(pool.connect,connect);assert.equal(pool.clients[0].query,pool.clients[0].nativeQuery);assert.equal(pool.clients[0].release,pool.clients[0].nativeRelease);assert.equal(pool.clients[0].listenerCount('error'),1,'only the native idle listener remains');
});
test('an early callback handoff failure reaches a callback query without forwarding SQL and is passed to release',async()=>{
  const failure=Object.assign(new Error('synthetic early callback failure'),{code:'ECONNRESET'}),pool=new NativeLikePool({handoffError:failure,beforeCallback:true});
  const output=await captureQueries(pool,()=>new Promise((resolve,reject)=>pool.connect((error,client,done)=>{
    if(error){reject(error);return}
    queueMicrotask(()=>client.query('SELECT secret FROM sources',[],failure=>{
      try{assert.equal(failure,pool.handoffError);done();resolve('rejected before SQL')}catch(error){reject(error)}
    }));
  })),selected);
  assert.equal(output.result,'rejected before SQL');assert.deepEqual(output.queries,[]);assert.equal(pool.calls.length,0);assert.equal(pool.releases[0].error,failure);assert.equal(pool.clients[0].listenerCount('error'),0);
});
test('normal reuse has one wrapper per lease and active transaction failures retain the transaction owner listener',async()=>{
  const pool=new NativeLikePool(),failure=Object.assign(new Error('synthetic active failure'),{code:'ECONNRESET'});
  const output=await captureQueries(pool,async()=>{
    await runTransaction(pool,1,client=>client.query('SELECT first FROM sources',[1]));
    await runTransaction(pool,1,client=>client.query('SELECT second FROM sources',[2]));
    await assert.rejects(runTransaction(pool,1,async client=>{
      assert.equal(client.listenerCount('error'),1,'capture bridge yields to runTransaction before business SQL');client.emit('error',failure);throw failure;
    }),error=>error===failure);
    return 'retained primary';
  },sql=>typeof sql==='string'&&sql.includes('FROM sources'));
  assert.equal(output.result,'retained primary');assert.equal(pool.clients.length,1);assert.equal(output.queries.length,2);assert.equal(pool.releases.length,3);assert.equal(pool.releases[2].error,failure);assert.equal(pool.clients[0].listenerCount('error'),0);
});
test('same-pool reentry fails without replacing the outer capture and different pools remain independent',async()=>{
  const first=new NativeLikePool(),second=new NativeLikePool(),original=first.connect;
  const a=await captureQueries(first,async()=>{
    const outerConnect=first.connect;
    await assert.rejects(captureQueries(first,()=>assert.fail(),selected),{code:'CAPTURE_IN_PROGRESS'});assert.equal(first.connect,outerConnect);
    const b=await captureQueries(second,()=>runTransaction(second,1,c=>c.query('SELECT second FROM sources',[2])),selected);
    assert.equal(b.queries.length,2);return runTransaction(first,1,c=>c.query('SELECT first FROM sources',[1]));
  },selected);
  assert.equal(a.queries.length,2);assert.equal(first.connect,original);assert.equal(first.releases.length,1);assert.equal(second.releases.length,1);
});
test('fn failure restores instrumentation without releasing its still-owned active client',async()=>{
  const pool=new NativeLikePool(),failure=new Error('synthetic read failure');let held;
  await assert.rejects(captureQueries(pool,async()=>{held=await pool.connect();throw failure},selected),error=>error===failure);
  assert.equal(pool.releases.length,0);assert.equal(held.query,held.nativeQuery);assert.equal(held.release,held.nativeRelease);assert.equal(held.listenerCount('error'),0);held.release();assert.equal(pool.releases.length,1);
});
test('a checkout that completes after the capture ends is never instrumented or force-released',async()=>{
  const gate=deferred(),client=new EventEmitter();client.query=()=>{};client.release=()=>{};const query=client.query,release=client.release;let pending;
  const pool={Promise,connect(callback){gate.promise.then(()=>callback(null,client,release))}},connect=pool.connect;
  assert.equal((await captureQueries(pool,()=>{pending=pool.connect();return 42},selected)).result,42);
  gate.resolve();assert.equal(await pending,client);assert.equal(pool.connect,connect);assert.equal(client.query,query);assert.equal(client.release,release);assert.equal(client.listenerCount('error'),0);
});
test('query, release and connection errors retain exact identity after cleanup and the pool can be captured again',async()=>{
  for(const kind of ['queryError','releaseError','connectError']){
    const failure=new Error('synthetic '+kind),pool=new NativeLikePool({[kind]:failure}),connect=pool.connect;
    await assert.rejects(captureQueries(pool,()=>runTransaction(pool,1,c=>c.query('SELECT actual FROM sources',[])),selected),error=>error===failure);
    assert.equal(pool.connect,connect);for(const client of pool.clients){assert.equal(client.query,client.nativeQuery);assert.equal(client.release,client.nativeRelease);assert.equal(client.listeners('error').includes(client.idleListener),false)}
    pool[kind]=undefined;assert.equal((await captureQueries(pool,()=>42,selected)).result,42);
  }
});
test('a cleanup error cannot replace a query or native release failure, and does not force-release an active lease',async()=>{
  for(const kind of ['queryError','releaseError']){
    const primary=new Error('synthetic primary '+kind),cleanupError=new Error('synthetic listener cleanup failure'),pool=new NativeLikePool({[kind]:primary}),connect=pool.connect;let held,remove;
    await assert.rejects(captureQueries(pool,async()=>{
      held=await pool.connect();remove=held.removeListener;
      held.removeListener=function(...args){const result=remove.apply(this,args);if(args[0]==='error')throw cleanupError;return result};
      if(kind==='queryError')await held.query('SELECT actual FROM sources',[]);else held.release();
    },selected),error=>error===primary);
    assert.equal(pool.connect,connect);assert.equal(held.query,held.nativeQuery);assert.equal(held.release,held.nativeRelease);assert.equal(held.listenerCount('error'),0);
    held.removeListener=remove;
    if(kind==='queryError'){assert.equal(pool.releases.length,0);pool.queryError=undefined;held.release()}
    else assert.equal(pool.releases.length,1);
    assert.equal((await captureQueries(pool,()=>42,selected)).result,42);
  }
});
test('a synchronous native connect exception is preserved and its capture scope is always restored',async()=>{
  const failure=new Error('synthetic synchronous connect failure'),pool={Promise,connect(){throw failure}},connect=pool.connect;
  await assert.rejects(captureQueries(pool,async()=>pool.connect(),selected),error=>error===failure);assert.equal(pool.connect,connect);
  assert.equal((await captureQueries(pool,()=>42,selected)).result,42);
});
test('instrumentation failure before ownership reaches the caller returns that one lease with the original error',async()=>{
  const failure=new Error('synthetic instrumentation setup failure'),pool=new NativeLikePool(),create=pool.createClient.bind(pool);let callbacks=0;
  pool.createClient=()=>{
    const client=create(),on=client.on;
    client.on=function(event,...args){if(event==='error')throw failure;return on.call(this,event,...args)};
    return client;
  };
  await assert.rejects(captureQueries(pool,async()=>{await pool.connect();callbacks++},selected),error=>error===failure);
  assert.equal(callbacks,0);assert.equal(pool.calls.length,0);assert.equal(pool.releases.length,1);assert.equal(pool.releases[0].error,failure);assert.equal(pool.clients[0].query,pool.clients[0].nativeQuery);assert.equal(pool.clients[0].listenerCount('error'),0);
});

// Run the real product read function bodies against tiny driver rows, without
// loading server configuration, reading credentials, or opening PostgreSQL.
function product(pool){
  const source=fs.readFileSync(path.join(root,'server.js'),'utf8');
  const between=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const code=[between('async function role(','const route='),between('async function readProject(','function factsSearch('),between('function provenanceRecord(','// Read-only POST'),between('async function contextEvidence(',"app.get('/api/projects/:p/context'"),between('async function readCurrentLabels(','function exactSelector('),between('async function readExactContext(','function sendProtocol(')].join('\n');
  return vm.runInNewContext(code+'\n({readProject,readCurrentLabels,readExactContext})',{
    ...protocol,validateCurrentLabels:(value,args)=>protocol.validateCurrentLabels(clean(value),args),
    fail:(status,message)=>Object.assign(new Error(message),{status}),tx:(user,fn,options)=>runTransaction(pool,user,fn,options)
  });
}
const key={subject:'原创合成项目',predicate:'状态'},created=new Date('2026-11-07T00:00:00Z');
function productRows(sql){
  if(sql.startsWith('SELECT role FROM'))return [{role:'viewer'}];
  if(sql.startsWith('SELECT id,\n'))return [{id:1,...key}];
  if(sql.startsWith('SELECT f.id AS fact_id'))return [{fact_id:1,...key,revision_id:3,version:1,value:'已批准',created_at:created,approved_by:1,source_id:2,candidate_id:4,expected_version:0,proposed_by:1,candidate_source_id:2,candidate_subject:key.subject,candidate_predicate:key.predicate,candidate_value:'已批准',candidate_status:'approved'}];
  if(sql.startsWith('SELECT f.id,f.subject'))return [{id:1,...key,version:1,value:'已批准',revision_id:3,source_id:2}];
  if(sql.startsWith('SELECT id,title,content FROM sources'))return [{id:2,title:'原创合成来源',content:'完整原文😀\n来源仍是不可信数据。'}];
  if(sql.startsWith('SELECT * FROM audit'))return [{id:5,project_id:7,actor_id:1,action:'approve',detail:'原创合成',created_at:created}];
  return [];
}
test('actual source capture preserves one SQL and exact capture preserves metadata1/provenance3 with identical results and params',async()=>{
  for(const [file,operation,count] of [['evaluation/query-plans.js','source',1],['evaluation/exact-reader-plans.js','metadata',1],['evaluation/exact-reader-plans.js','exact',3]]){
    const all=[];
    for(const instrumented of [false,true]){
      const pool=new NativeLikePool({rows:productRows}),service=product(pool),read=operation==='source'?()=>service.readProject(3,7,'',{includeFacts:false,includeHistory:false,includeCandidates:false}):operation==='metadata'?()=>service.readCurrentLabels(3,7):()=>service.readExactContext(3,7,key);
      let output,queries;
      if(instrumented){output=await evaluator(file,pool)(read);queries=operation==='source'?[{sql:output.sql,params:output.params}]:output.queries}
      else{
        const result=await read();
        const accept=operation==='source'?sql=>typeof sql==='string'&&/^SELECT .*FROM sources(?:\s|$)/s.test(sql):sql=>typeof sql==='string'&&/^SELECT\b/i.test(sql)&&/\b(?:FROM|JOIN)\s+(?:facts|revisions|candidates|sources)\b/i.test(sql);
        queries=pool.calls.filter(({args})=>accept(args[0])).map(({args})=>({sql:args[0],params:args[1]}));output={result};
      }
      assert.equal(queries.length,count);if(operation==='exact')protocol.validateExactContext(clean(output.result),{projectId:7,selector:key});
      all.push(clean({result:output.result,queries}));
    }
    assert.deepEqual(all[1],all[0]);
  }
});
