// Test-only gate after a real native INSERT callback, never a production hook.
// This demonstrates changed-membership atomicity, not cancellation of every
// admitted write or revocation of an already established snapshot.
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
const {Client}=require('pg');
const ROOT=path.resolve(__dirname,'..'),TABLES=['projects','memberships','sources','facts','candidates','revisions','audit','idempotency_requests'];
const ledger={sqlUtf8:0,parameterJson:0,resultRowsJson:0,httpRequestBody:0,httpResponseBody:0,httpRequests:0},LIMIT=1024*1024,CLEANUP_RESERVE=4096;
const nativeClients=new WeakMap();
let created=0,dropped=0,workBytes=0,cleanupBytes=0;
const totalBytes=()=>ledger.sqlUtf8+ledger.parameterJson+ledger.resultRowsJson+ledger.httpRequestBody+ledger.httpResponseBody;
function add(field,bytes,cleanup=false){ledger[field]+=bytes;if(cleanup)cleanupBytes+=bytes;else workBytes+=bytes;assert.ok(cleanup?cleanupBytes<=CLEANUP_RESERVE:workBytes<=LIMIT-CLEANUP_RESERVE,'small original fixture '+(cleanup?'reserved cleanup':'work')+' application-byte budget')}
function input(sql,params,cleanup=false){add('sqlUtf8',Buffer.byteLength(sql),cleanup);add('parameterJson',Buffer.byteLength(JSON.stringify(params||[])),cleanup)}
function output(result,cleanup=false){add('resultRowsJson',Buffer.byteLength(JSON.stringify(Array.isArray(result)?result.map(r=>r.rows):result.rows)),cleanup)}
function terminalQuery(c,sql){
  const native=nativeClients.get(c);assert.ok(native);
  assert.ok(sql==='ROLLBACK'||(native.database&&sql===`DROP DATABASE ${native.database} WITH (FORCE)`),'only this fixture database or ROLLBACK may use cleanup reserve');
  input(sql,[],true);return native.query.call(c,sql).then(result=>{output(result,true);return result});
}
function ownerClient(url,{database,onCreate}={}){
  const c=new Client({connectionString:url,connectionTimeoutMillis:3000,statement_timeout:2000,query_timeout:3000});c.on('error',()=>{});
  const query=c.query;nativeClients.set(c,{query,database});c.query=function(sql,params){
    if(sql==='ROLLBACK')return terminalQuery(this,sql);
    input(sql,params);return query.call(this,sql,params).then(result=>{
      // Ownership starts at native CREATE acknowledgement, before accounting
      // can reject its result. Never lose the database to a failed meter.
      if(database&&sql===`CREATE DATABASE ${database}`)onCreate();
      output(result);return result;
    });
  };return c;
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});promise.catch(()=>{});return {promise,resolve,reject}}
async function fingerprint(owner){
  const value={};for(const table of TABLES){
    // Sequence values are deliberately excluded: a rolled-back nextval may
    // leave a gap. Membership.active is checked separately around maintenance.
    const selection=table==='memberships'?'SELECT project_id,user_id,role FROM memberships':`SELECT * FROM ${table}`;
    value[table]=(await owner.query(`SELECT count(*)::int AS rows,md5(COALESCE(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) AS hash FROM (${selection}) t`)).rows[0];
  }return value;
}
function installGate(pool,operation,marker){
  const entered=deferred(),released=deferred(),state={armed:true,insert:null,isolation:null,auditError:null,rollback:0,commit:0,unexpected:null};
  const originalConnect=pool.connect;let timer;
  const fail=error=>{state.unexpected||=error;entered.reject(error);released.resolve()};
  const release=()=>{clearTimeout(timer);released.resolve()};
  // Set a barrier deadline when the HTTP write starts, not while fixture setup
  // is running. Timeout releases the actual checked-out client's continuation.
  function arm(){timer=setTimeout(()=>fail(new Error('SYNTHETIC_GATE_DEADLINE')),5000)}
  pool.on('connect',client=>{
    const query=client.query;
    const observe=(sql,error,result)=>{
      if(error){if(sql.startsWith('INSERT INTO audit('))state.auditError=error;return}
      output(result,sql==='ROLLBACK');if(sql==='ROLLBACK')state.rollback++;if(sql==='COMMIT')state.commit++;
    };
    client.query=function(sql,params,callback){
      if(typeof params==='function'){callback=params;params=undefined}
      input(sql,params,sql==='ROLLBACK');
      const target=state.armed&&sql.startsWith(`INSERT INTO ${operation}(`)&&params?.[1]===marker;
      if(target){
        state.armed=false;
        assert.equal(callback,undefined,'real HTTP create currently uses the Promise query form');
        return new Promise((resolve,reject)=>{
          // The native callback is proof that PostgreSQL completed INSERT;
          // withholding only its result keeps the HTTP handler before audit.
          query.call(client,sql,params,(error,result)=>{
            try{observe(sql,error,result);if(error){fail(error);reject(error);return}
              assert.equal(result.command,'INSERT');assert.equal(result.rowCount,1);assert.ok(Number.isSafeInteger(result.rows[0].id));
              assert.ok(client.listenerCount('error')>0,'runTransaction must retain its checked-out error listener');
              input('SHOW transaction_isolation',[]);
              query.call(client,'SHOW transaction_isolation',[],(isolationError,info)=>{
                try{if(isolationError)throw isolationError;output(info);state.isolation=info.rows[0].transaction_isolation;assert.equal(state.isolation,'read committed');
                  state.insert={id:result.rows[0].id,command:result.command,rowCount:result.rowCount,pid:client.processID};entered.resolve(state.insert);
                  released.promise.then(()=>resolve(result),reject);
                }catch(problem){fail(problem);reject(problem)}
              });
            }catch(problem){fail(problem);reject(problem)}
          });
        });
      }
      // Preserve the native callback return value, callback receiver and the
      // original error object. Never wrap connect/release or add error listeners.
      if(typeof callback==='function')return query.call(client,sql,params,function(error,result){
        try{observe(sql,error,result)}catch(problem){fail(problem)}
        return callback.call(this,error,result);
      });
      const pending=query.call(client,sql,params);
      return pending.then(result=>{observe(sql,null,result);return result},error=>{observe(sql,error);throw error});
    };
  });
  return {state,entered:entered.promise,release,arm,assertConnectUnchanged:()=>assert.equal(pool.connect,originalConnect)};
}

async function fixture(operation,run){
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'explicit isolated test administrator connection required');
  const name='memz_write_revoke_'+randomBytes(8).toString('hex');
  let owner,service,server,gate,made=false;const requests=[];
  const admin=ownerClient(process.env.MIGRATION_TEST_DATABASE_URL,{database:name,onCreate:()=>{made=true;created++}});
  const modulePath=require.resolve('../server');
  try{
    await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
    const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL);url.pathname='/'+name;owner=ownerClient(url.href);await owner.connect();
    await owner.query(fs.readFileSync(path.join(ROOT,'db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    const marker='original-write-revocation-'+operation;url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;
    // The Node test worker owns both sequential app instances. No shared app or
    // external configuration is changed, and each pool is ended before reuse.
    delete require.cache[modulePath];service=require('../server');gate=installGate(service.pool,operation,marker);
    server=service.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
    function request(route,{session,body,key,method=body===undefined?'GET':'POST'}={}){
      assert.ok(ledger.httpRequests<15,'fixed total HTTP request budget');ledger.httpRequests++;
      const text=body===undefined?undefined:JSON.stringify(body);if(text)add('httpRequestBody',Buffer.byteLength(text));
      const promise=(async()=>{const response=await fetch(base+route,{method,body:text,headers:{...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...(text?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},signal:AbortSignal.timeout(10000)});
        const raw=await response.text();add('httpResponseBody',Buffer.byteLength(raw));return {status:response.status,data:JSON.parse(raw),cookie:response.headers.get('set-cookie')?.split(';')[0]};})();
      requests.push(promise);promise.catch(()=>{});return promise;
    }
    const login=await request('/api/login',{body:{username:'member',password:'demo-member'}});assert.equal(login.status,200);const session={cookie:login.cookie,csrf:login.data.csrf};
    // Exercise both callback shapes on this real metered client while tx keeps
    // its listener. Callback-mode returns exactly the native pg value (undefined).
    await service.tx(2,async client=>{for(const values of [undefined,[2]])await new Promise((resolve,reject)=>{
      function callback(error,result){if(error){reject(error);return}try{assert.equal(result.rows[0].probe,values?2:1);resolve()}catch(problem){reject(problem)}}
      const returned=values?client.query('SELECT $1::int AS probe',values,callback):client.query('SELECT 1::int AS probe',callback);assert.equal(returned,undefined);
    })});
    await run({owner,service,gate,request,session,marker});
    assert.equal((await request('/api/logout',{session,method:'POST'})).status,200);gate.assertConnectUnchanged();assert.equal(gate.state.unexpected,null);
  }finally{
    // Always open the barrier and await every already-started HTTP operation
    // before closing its pool or dropping this fixture, including failure paths.
    gate?.release();await Promise.allSettled(requests);
    try{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}if(service)await service.pool.end()}
    finally{delete require.cache[modulePath];try{if(owner)await owner.end()}finally{try{if(made){await terminalQuery(admin,`DROP DATABASE ${name} WITH (FORCE)`);dropped++}}finally{await admin.end()}}}
  }
}

for(const operation of ['sources','candidates'])test(operation+': revoke after actual HTTP INSERT rolls back the whole creation; explicit reactivation uses the same key once',{timeout:25000},async t=>{
  await fixture(operation,async({owner,gate,request,session,marker})=>{
    const route='/api/projects/1/'+operation,key='same-original-key-'+operation;
    const body=operation==='sources'?{title:marker,content:'Original small source only.'}:{subject:marker,predicate:'status',value:'Original pending candidate only.',source_id:2,expected_version:0};
    const before=await fingerprint(owner),beforeCommit=gate.state.commit,beforeRollback=gate.state.rollback;
    gate.arm();const pending=request(route,{session,body,key});pending.catch(error=>{gate.state.unexpected||=error;gate.release()});
    const inserted=await gate.entered;assert.equal(gate.state.commit,beforeCommit);
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${operation} WHERE id=$1`,[inserted.id])).rows[0].n,0,'uncommitted completed INSERT is not visible to another session');
    // active is not part of the referenced actor key. Candidate FK KEY SHARE
    // must not turn this non-key UPDATE into an unbounded maintenance wait.
    await owner.query('BEGIN');try{
      const revoked=await owner.query('UPDATE memberships SET active=false WHERE project_id=$1 AND user_id=$2 AND active IS TRUE RETURNING active',[1,2]);assert.deepEqual(revoked.rows,[{active:false}]);
      assert.equal((await owner.query('COMMIT')).command,'COMMIT');
    }catch(error){await owner.query('ROLLBACK').catch(()=>{});throw error}
    // Release only after the real owner COMMIT. audit is the next application
    // statement, whose READ COMMITTED snapshot sees the now-inactive member.
    gate.release();const failed=await pending;
    assert.equal(gate.state.auditError?.code,'42501');assert.equal(gate.state.rollback,beforeRollback+1);assert.equal(gate.state.commit,beforeCommit);
    // Current error-handler contract for a raw RLS violation is fixed generic
    // 500. Pre-admission authorization remains 403; no production mapping change.
    assert.deepEqual({status:failed.status,data:failed.data},{status:500,data:{error:'请求无法处理'}});
    assert.deepEqual(await fingerprint(owner),before,'no source/candidate/audit/receipt/history row may survive rollback');
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${operation} WHERE id=$1`,[inserted.id])).rows[0].n,0);
    assert.equal((await request(route,{session,body,key})).status,403,'same key cannot authorize an inactive member');assert.deepEqual(await fingerprint(owner),before);
    assert.deepEqual((await owner.query('UPDATE memberships SET active=true WHERE project_id=$1 AND user_id=$2 AND active IS FALSE RETURNING role,active',[1,2])).rows,[{role:'member',active:true}]);
    const winner=await request(route,{session,body,key});assert.equal(winner.status,200);assert.ok(Number.isSafeInteger(winner.data.id));if(operation==='candidates')assert.equal(winner.data.status,'pending');
    const committed=await fingerprint(owner);assert.deepEqual(await request(route,{session,body,key}),winner,'same key replays the one complete creation response');assert.deepEqual(await fingerprint(owner),committed);
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${operation} WHERE project_id=1 AND ${operation==='sources'?'title':'subject'}=$1`,[marker])).rows[0].n,1);
    const detail=operation==='sources'?`新增来源 ${winner.data.id}`:`候选 ${winner.data.id}`;
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM audit WHERE project_id=1 AND actor_id=2 AND action=$1 AND detail=$2',[operation==='sources'?'source':'propose',detail])).rows[0].n,1);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM idempotency_requests WHERE project_id=1 AND actor_id=2 AND operation=$1 AND request_key=$2',[operation,key])).rows[0].n,1);
    if(operation==='candidates')assert.equal((await owner.query('SELECT count(*)::int AS n FROM revisions WHERE candidate_id=$1',[winner.data.id])).rows[0].n,0);
    t.diagnostic(JSON.stringify({synthetic:true,operation,isolation:gate.state.isolation,nativeInsertCompleted:true,revocationCommittedBeforeRelease:true,auditSqlstate:gate.state.auditError.code,rollbackObserved:true,sequenceGapsAllowed:true,reactivatedCreationRows:1,modelCalls:0}));
  });
});
after(()=>{assert.equal(created,dropped);assert.ok(ledger.httpRequests<=15);assert.ok(totalBytes()<=LIMIT);console.log('Synthetic write-revocation resources:',JSON.stringify({...ledger,totalApplicationBytes:totalBytes(),workBytes,cleanupBytes,cleanupReserve:CLEANUP_RESERVE,temporaryDatabasesCreated:created,temporaryDatabasesDropped:dropped,modelCalls:0,scope:'SQL UTF8 + parameter/result.rows JSON (all results) + HTTP request/response bodies; not wire, headers, PG errors or heap'}))});
