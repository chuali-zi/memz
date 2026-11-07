const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {app,pool}=require('../server');
const originalConnect=pool.connect;
let checkouts=0;
pool.connect=async()=>{checkouts++;throw Object.assign(new Error('synthetic-private-detail'),{code:'ECONNRESET'})};
const server=app.listen(0,'127.0.0.1'),ready=once(server,'listening');
after(async()=>{pool.connect=originalConnect;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end()});
async function call(path,{auth,body,headers={}}={}){
  await ready;
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{
    method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(2000),
    headers:{...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},
    ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})
  });
  return {status:response.status,data:await response.json()};
}
async function login(){
  await ready;
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/login`,{method:'POST',signal:AbortSignal.timeout(2000),headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'demo-owner'})});
  assert.equal(response.status,200);
  return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:(await response.json()).csrf};
}
const path='/api/projects/1/facts/provenance',body={facts:[{id:1,version:1}]};
test('batch provenance keeps authentication, CSRF and bounded input rejection before checkout',{timeout:10000},async()=>{
  const before=checkouts;
  assert.equal((await call(path,{body})).status,401);
  const auth=await login();
  assert.equal((await call(path,{auth:{...auth,csrf:'forged'},body})).status,403);
  for(const invalid of [{facts:[]},{facts:Array.from({length:26},(_,id)=>({id:id+1,version:1}))},{facts:[{id:1,version:1},{id:1,version:1}]},{...body,gold:'synthetic-private-detail'}])assert.equal((await call(path,{auth,body:invalid})).status,400);
  assert.equal((await call(path,{auth,body,headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await call(path,{auth,body:JSON.stringify(body)+' '.repeat(16385)})).status,413);
  assert.equal(checkouts,before);
});
test('batch provenance database failures use readonly 503 while source and candidate writes remain uncertain',{timeout:10000},async()=>{
  const auth=await login(),originalLog=console.error,logs=[],before=checkouts;
  console.error=(...args)=>logs.push(args.join(' '));
  try{
    for(const [code,message] of [['ECONNRESET','数据库暂时不可用，请稍后重试'],['57014','数据库请求超时，请稍后重试']]){
      pool.connect=async()=>{checkouts++;throw Object.assign(new Error('synthetic-private-detail'),{code})};
      for(const response of [
        await call('/api/projects/1/facts',{auth}),
        await call('/api/projects/1/context/exact',{auth,body:{selector:{subject:'项目',predicate:'截止日'}}}),
        await call(path,{auth,body})
      ]){
        assert.equal(response.status,503);assert.deepEqual(response.data,{error:message});
        assert.equal(Object.hasOwn(response.data,'outcome'),false,'wire error shape stays compatible');
      }
      for(const response of [
        await call('/api/projects/1/sources',{auth,body:{title:'合成来源',content:'仅限故障回归'}}),
        await call('/api/projects/1/candidates',{auth,body:{subject:'项目',predicate:'状态',value:'待审',source_id:1,expected_version:0}})
      ]){
        assert.equal(response.status,503);
        assert.deepEqual(response.data,{error:'数据库连接中断，写入结果可能不确定；请先核实，创建重试请复用原幂等键'});
      }
    }
    assert.equal(checkouts-before,10,'each request checks out once without an automatic retry');
    assert.equal(logs.length,10);assert.ok(logs.every(line=>!line.includes('synthetic-private-detail')));
  }finally{console.error=originalLog}
});
