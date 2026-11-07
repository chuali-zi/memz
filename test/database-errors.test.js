const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {Client}=require('pg');
const {DATABASE_LIMITS,databasePoolOptions,databaseErrorKind,safeErrorCode}=require('../scripts/database');
const {app,pool}=require('../server');
const server=app.listen(0,'127.0.0.1'),ready=once(server,'listening');
after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end()});

test('database limits provide finite checkout, statement and client response deadlines',()=>{
  assert.deepEqual(DATABASE_LIMITS,{max:10,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:15000});
  for(const [key,value] of Object.entries(DATABASE_LIMITS))assert.equal(pool.options[key],value);
  assert.ok(DATABASE_LIMITS.query_timeout>DATABASE_LIMITS.statement_timeout);
});
test('connection URL parameters cannot disable application deadlines and unrelated options survive',()=>{
  const options=databasePoolOptions('postgres://synthetic:synthetic-private@localhost/example?query_timeout=0&query_timeout=90000&statement_timeout=0&connectionTimeoutMillis=0&application_name=deadline-test&sslmode=disable');
  const url=new URL(options.connectionString);
  for(const key of ['query_timeout','statement_timeout','connectionTimeoutMillis'])assert.equal(url.searchParams.has(key),false);
  assert.equal(url.searchParams.get('application_name'),'deadline-test');assert.equal(url.searchParams.get('sslmode'),'disable');
  assert.equal(url.username,'synthetic');assert.equal(url.password,'synthetic-private');
  const client=new Client(options);
  assert.equal(client.connectionParameters.statement_timeout,DATABASE_LIMITS.statement_timeout);
  assert.equal(client.connectionParameters.query_timeout,DATABASE_LIMITS.query_timeout);
});
test('malformed database URLs produce a fixed error without retaining their input or cause',()=>{
  for(const value of ['postgres://synthetic-private@[invalid','synthetic-private','https://synthetic-private.example']){
    assert.throws(()=>databasePoolOptions(value),error=>{
      assert.equal(error.message,'Database connection URL is invalid');
      assert.equal(error.cause,undefined);assert.equal(error.input,undefined);
      assert.ok(!String(error.stack).includes('synthetic-private'));return true;
    });
  }
});
test('only exact pg timeout messages, connection codes and connection SQLSTATEs are classified',()=>{
  for(const message of ['Query read timeout','timeout exceeded when trying to connect','Connection terminated due to connection timeout'])assert.equal(databaseErrorKind(new Error(message)),'timeout');
  assert.equal(databaseErrorKind({code:'57014'}),'timeout');
  for(const code of ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENETUNREACH','EHOSTUNREACH','08006','08P01','57P01','57P02','57P03'])assert.equal(databaseErrorKind({code}),'connection');
  for(const message of ['Connection terminated unexpectedly','Connection terminated','Client has encountered a connection error and is not queryable','Client was closed and is not queryable'])assert.equal(databaseErrorKind({message}),'connection');
  for(const error of [{message:'a custom timeout with private details'},{code:'23505'},{code:'57014-more'},{code:'08P01-private'},undefined])assert.equal(databaseErrorKind(error),null);
});
test('diagnostic codes never reflect arbitrary error names, messages or malformed codes',()=>{
  for(const error of [{name:'private-name',message:'private-message'},{code:'postgres://private'},{code:'secret\ncode'},undefined])assert.equal(safeErrorCode(error),'Error');
  assert.equal(safeErrorCode({code:'57014'}),'57014');assert.equal(safeErrorCode({code:'ECONNRESET'}),'ECONNRESET');
});
test('HTTP database errors retain JSON compatibility and uncertain-write guidance without leaking details',async()=>{
  await ready;const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'demo-owner'})});
  const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf;
  const originalConnect=pool.connect,originalLog=console.error,logs=[];
  console.error=(...args)=>logs.push(args.join(' '));
  try{
    for(const [failure,readMessage,label] of [
      [Object.assign(new Error('synthetic-private-message'),{code:'ECONNRESET'}),'数据库暂时不可用，请稍后重试','ECONNRESET'],
      [Object.assign(new Error('synthetic-private-message'),{code:'57014'}),'数据库请求超时，请稍后重试','57014'],
      [new Error('timeout exceeded when trying to connect'),'数据库请求超时，请稍后重试','Error'],
      [new Error('Connection terminated due to connection timeout'),'数据库请求超时，请稍后重试','Error'],
      [new Error('Query read timeout'),'数据库请求超时，请稍后重试','Error']
    ]){
      let connects=0;pool.connect=async()=>{connects++;throw failure};
      for(const write of [false,true]){
        const response=await fetch(base+(write?'/api/projects/1/sources':'/api/projects'),{
          method:write?'POST':'GET',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},
          ...(write?{body:JSON.stringify({title:'synthetic',content:'synthetic'})}:{})
        });
        assert.equal(response.status,503);
        assert.deepEqual(await response.json(),{error:write?'数据库连接中断，写入结果可能不确定；请先核实，创建重试请复用原幂等键':readMessage});
        assert.equal(logs.at(-1),'Request failed: '+label);
      }
      assert.equal(connects,2,'each HTTP request must attempt checkout only once');
    }
    pool.connect=async()=>{throw Object.assign(new Error('synthetic-private-message'),{code:'synthetic-private-code',name:'synthetic-private-name'})};
    const unknown=await fetch(base+'/api/projects',{headers:{cookie}});
    assert.equal(unknown.status,500);assert.deepEqual(await unknown.json(),{error:'请求无法处理'});
    assert.equal(logs.at(-1),'Request failed: Error');
    assert.ok(logs.every(log=>!log.includes('synthetic-private')));
  }finally{pool.connect=originalConnect;console.error=originalLog}
});
