const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {MAX_PENDING_CHECKOUTS,pendingTransactionCheckouts,runTransaction,databaseErrorKind,safeErrorCode}=require('../scripts/database');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function client(){const c=new EventEmitter();c.queries=[];c.releases=[];c.query=async sql=>{c.queries.push(sql);return {command:sql.split(' ')[0],rows:[]}};c.release=error=>c.releases.push(error);return c}
function waitingPool(){const waiting=[];return {waiting,connect(){const d=deferred();waiting.push(d);return d.promise}}}
test('32 checkout handoffs reserve synchronously and overflow never connects or enters SQL',async()=>{
  const pool=waitingPool();let callbacks=0;
  const jobs=Array.from({length:MAX_PENDING_CHECKOUTS},()=>runTransaction(pool,1,()=>{callbacks++;return 42}));
  assert.equal(pendingTransactionCheckouts(pool),32);assert.equal(pool.waiting.length,32);
  await assert.rejects(runTransaction(pool,1,()=>{callbacks++}),error=>error.code==='DB_ADMISSION_BUSY'&&error.message==='Database admission is busy');
  assert.equal(pool.waiting.length,32);assert.equal(callbacks,0);
  for(const d of pool.waiting)d.resolve(client());
  assert.deepEqual(await Promise.all(jobs),Array(32).fill(42));assert.equal(callbacks,32);assert.equal(pendingTransactionCheckouts(pool),0);
  assert.equal(databaseErrorKind({code:'DB_ADMISSION_BUSY'}),'busy');assert.equal(safeErrorCode({code:'DB_ADMISSION_BUSY'}),'DB_ADMISSION_BUSY');
});
test('fulfilled but not resumed checkouts still hold their slot and pools are independent',async()=>{
  const pool=waitingPool(),other=waitingPool();
  const jobs=Array.from({length:32},()=>runTransaction(pool,1,()=>1));
  pool.waiting[0].resolve(client());assert.equal(pendingTransactionCheckouts(pool),32);
  await assert.rejects(runTransaction(pool,1,()=>2),{code:'DB_ADMISSION_BUSY'});
  const independent=runTransaction(other,1,()=>3);assert.equal(pendingTransactionCheckouts(other),1);other.waiting[0].resolve(client());
  for(const d of pool.waiting.slice(1))d.resolve(client());
  await Promise.all(jobs);assert.equal(await independent,3);assert.equal(pendingTransactionCheckouts(pool),0);assert.equal(pendingTransactionCheckouts(other),0);
});
test('synchronous throws and rejected checkout waves preserve primary errors and release all slots',async()=>{
  const failure=new Error('synthetic checkout failure'),sync={connect(){throw failure}};
  await assert.rejects(runTransaction(sync,1,()=>assert.fail()),error=>error===failure);assert.equal(pendingTransactionCheckouts(sync),0);
  const pool=waitingPool();
  for(let wave=0;wave<2;wave++){
    const jobs=Array.from({length:32},()=>runTransaction(pool,1,()=>assert.fail()));const settled=Promise.allSettled(jobs);
    for(const d of pool.waiting.splice(0))d.reject(failure);
    for(const result of await settled){assert.equal(result.status,'rejected');assert.equal(result.reason,failure)}
    assert.equal(pendingTransactionCheckouts(pool),0);
  }
});
test('held transactions commit and roll back at full admission without being counted or readmitted',async()=>{
  for(const failing of [false,true]){
    const c=client(),gate=deferred(),started=deferred(),pool=waitingPool();let first=true;
    const deferredConnect=pool.connect.bind(pool);pool.connect=()=>{if(first){first=false;return Promise.resolve(c)}return deferredConnect()};
    const primary=Object.assign(new Error('synthetic primary'),{status:409}),rollback=new Error('synthetic rollback');
    if(failing){const query=c.query;c.query=sql=>sql==='ROLLBACK'?Promise.reject(rollback):query(sql)}
    const active=runTransaction(pool,1,async()=>{started.resolve();await gate.promise;if(failing)throw primary;return 7});
    const activeResult=Promise.allSettled([active]);await started.promise;assert.equal(pendingTransactionCheckouts(pool),0);
    const queued=Array.from({length:32},()=>runTransaction(pool,1,()=>1)),queuedResult=Promise.allSettled(queued);
    gate.resolve();const [result]=await activeResult;
    assert.equal(pendingTransactionCheckouts(pool),32);assert.equal(pool.waiting.length,32);
    if(failing){assert.equal(result.reason,primary);assert.deepEqual(c.releases,[rollback])}
    else{assert.equal(result.value,7);assert.deepEqual(c.releases,[undefined]);assert.equal(c.queries.at(-1),'COMMIT')}
    for(const d of pool.waiting)d.resolve(client());await queuedResult;assert.equal(pendingTransactionCheckouts(pool),0);
  }
});
test('checkout installs the error listener in its original single-await microtask handoff',async()=>{
  const c=client(),ready=Promise.resolve(c),failure=Object.assign(new Error('synthetic disconnect'),{code:'ECONNRESET'});let listeners;
  ready.then(()=>queueMicrotask(()=>{listeners=c.listenerCount('error');if(listeners)c.emit('error',failure)}));
  const query=c.query;c.query=async sql=>{if(sql.startsWith('SELECT'))throw failure;return query(sql)};
  const pool={connect:()=>ready};
  await assert.rejects(runTransaction(pool,1,()=>assert.fail()),error=>error===failure);
  assert.equal(listeners,1,'no async wrapper may reopen the unhandled error-event window');
  assert.deepEqual(c.releases,[failure]);assert.equal(c.listenerCount('error'),0);assert.equal(pendingTransactionCheckouts(pool),0);
});
