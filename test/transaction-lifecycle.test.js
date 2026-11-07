const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {runTransaction}=require('../scripts/database');

function fixture(query=async sql=>({rows:[],command:sql.split(' ',1)[0]})){
  const client=new EventEmitter(),queries=[],releases=[];
  client.query=async(...args)=>{queries.push(args);return query(...args)};
  client.release=error=>releases.push(error);
  let connects=0;
  const pool={connect:async()=>{connects++;return client}};
  return {pool,client,queries,releases,connects:()=>connects};
}
test('successful transactions preserve identity, read snapshot and callback result',async()=>{
  const f=fixture();
  assert.deepEqual(await runTransaction(f.pool,3,async()=>({value:42}),{snapshot:true}),{value:42});
  assert.deepEqual(f.queries,[['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'],["SELECT pg_catalog.set_config('app.user_id',$1,true)",['3']],['COMMIT']]);
  assert.deepEqual(f.releases,[undefined]);assert.equal(f.client.listenerCount('error'),0);
});
test('business failure rolls back and preserves the exact error and reusable client',async()=>{
  const f=fixture(),failure=Object.assign(new Error('version conflict'),{status:409});
  await assert.rejects(()=>runTransaction(f.pool,1,()=>{throw failure}),error=>error===failure);
  assert.equal(f.queries.at(-1)[0],'ROLLBACK');assert.deepEqual(f.releases,[undefined]);
  assert.equal(f.client.listenerCount('error'),0);assert.equal(f.connects(),1);
});
test('rollback failure discards the client without replacing the original error',async()=>{
  const rollback=Object.assign(new Error('synthetic private rollback detail'),{code:'ECONNRESET'});
  const f=fixture(async sql=>{if(sql==='ROLLBACK')throw rollback});
  const failure=Object.assign(new Error('version conflict'),{status:409});
  await assert.rejects(()=>runTransaction(f.pool,1,()=>{throw failure}),error=>error===failure);
  assert.deepEqual(f.releases,[rollback]);assert.equal(f.connects(),1);
  assert.equal(f.client.listenerCount('error'),0);
});
test('a failed BEGIN is released and never invokes the transaction callback',async()=>{
  const failure=new Error('failed begin'),f=fixture(async sql=>{if(sql==='BEGIN')throw failure});
  let called=false;
  await assert.rejects(()=>runTransaction(f.pool,1,()=>{called=true}),error=>error===failure);
  assert.equal(called,false);assert.equal(f.queries.at(-1)[0],'ROLLBACK');assert.deepEqual(f.releases,[undefined]);
});
test('uncertain COMMIT failure is neither replayed nor masked by a rollback',async()=>{
  const failure=Object.assign(new Error('synthetic private connection detail'),{code:'ECONNRESET'});
  const f=fixture(async sql=>{if(sql==='COMMIT')throw failure});let calls=0;
  await assert.rejects(()=>runTransaction(f.pool,1,()=>{calls++;return 1}),error=>error===failure);
  assert.equal(calls,1);assert.equal(f.connects(),1);
  assert.equal(f.queries.at(-1)[0],'COMMIT');assert.deepEqual(f.releases,[failure]);
});
test('only an explicit COMMIT command can confirm success, without exposing invalid receipts or retrying',async()=>{
  for(const committed of [{command:'ROLLBACK'},{command:'synthetic-private-result'},undefined]){
    const f=fixture(async sql=>sql==='COMMIT'?committed:{rows:[]});let calls=0;
    await assert.rejects(()=>runTransaction(f.pool,1,()=>{calls++;return {value:'synthetic-private-result'}}),error=>{
      assert.equal(error.message,'Database transaction did not commit');
      assert.equal(error.cause,undefined);assert.ok(!String(error).includes('synthetic-private-result'));return true;
    });
    assert.equal(calls,1);assert.equal(f.connects(),1);
    assert.equal(f.queries.filter(([sql])=>sql==='COMMIT').length,1);
    assert.equal(f.queries.at(-1)[0],'ROLLBACK');assert.deepEqual(f.releases,[undefined]);
  }
});
test('client read timeout destroys the connection without queuing rollback behind the unfinished query',async()=>{
  const failure=new Error('Query read timeout'),f=fixture();
  await assert.rejects(()=>runTransaction(f.pool,1,()=>{throw failure}),error=>error===failure);
  assert.ok(!f.queries.some(([sql])=>sql==='ROLLBACK'));assert.deepEqual(f.releases,[failure]);
});
test('PostgreSQL statement cancellation rolls back while retaining a usable connection',async()=>{
  const failure=Object.assign(new Error('canceling statement due to statement timeout'),{code:'57014'}),f=fixture();
  await assert.rejects(()=>runTransaction(f.pool,1,()=>{throw failure}),error=>error===failure);
  assert.equal(f.queries.at(-1)[0],'ROLLBACK');assert.deepEqual(f.releases,[undefined]);
});
test('checkout rejection is preserved without executing or retrying the callback',async()=>{
  const failure=new Error('timeout exceeded when trying to connect');let connects=0,called=false;
  await assert.rejects(()=>runTransaction({connect:async()=>{connects++;throw failure}},1,()=>{called=true}),error=>error===failure);
  assert.equal(called,false);assert.equal(connects,1);
});
test('a checked-out client error event is handled and the client is discarded on failure',async()=>{
  const failure=Object.assign(new Error('synthetic connection loss'),{code:'57P01'}),f=fixture();
  await assert.rejects(()=>runTransaction(f.pool,1,async client=>{
    await Promise.resolve();client.emit('error',failure);throw failure;
  }),error=>error===failure);
  assert.deepEqual(f.releases,[failure]);assert.ok(!f.queries.some(([sql])=>sql==='ROLLBACK'));
  assert.equal(f.client.listenerCount('error'),0);
});
