const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {app,pool}=require('../server');
const server=app.listen(0,'127.0.0.1'),ready=once(server,'listening');
let checkouts=0,databaseError=new Error('Unexpected database checkout');
pool.connect=async()=>{checkouts++;throw databaseError};
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end()});
async function call(path,{auth,body,method=body===undefined?'GET':'POST',headers={}}={}){
  await ready;
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{
    method,headers:{...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},
    ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)}),signal:AbortSignal.timeout(3000)
  });
  return {status:response.status,data:await response.json(),headers:response.headers};
}
async function login(){
  await ready;const response=await fetch(`http://127.0.0.1:${server.address().port}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'viewer',password:'demo-viewer'})});
  assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:(await response.json()).csrf};
}
const selector={subject:'项目',predicate:'截止日'};
test('the new routes require authentication and the readonly POST still requires CSRF',async()=>{
  const before=checkouts;
  assert.equal((await call('/api/projects/1/current-labels')).status,401);
  assert.equal((await call('/api/projects/1/context/exact',{body:{selector}})).status,401);
  const auth=await login();
  for(const csrf of ['', 'forged'])assert.equal((await call('/api/projects/1/context/exact',{auth:{...auth,csrf},body:{selector}})).status,403);
  assert.equal(checkouts,before);
});
test('exact selector validation rejects unknown fields, invalid types, Unicode and length before any checkout',async()=>{
  const auth=await login(),before=checkouts;
  for(const body of [{},{selector:null},{selector:[]},{selector:{}},{selector:{subject:'a'}},{selector:{subject:'a',predicate:1}},{selector:{subject:'',predicate:'x'}},{selector:{subject:'a',predicate:' \t'}},{selector:{subject:'x'.repeat(101),predicate:'x'}},{selector:{subject:'a',predicate:'前\0后'}},{selector:{subject:'a',predicate:'前\ud800后'}},{selector:{subject:'前\udc00后',predicate:'x'}},{selector:{...selector,value:'synthetic-private'}},{selector,gold:'synthetic-private'},{selector,projectId:2},{selector,query:''},{selector,limit:1}]){
    const response=await call('/api/projects/1/context/exact',{auth,body});assert.equal(response.status,400);assert.deepEqual(response.data,{error:'精确选择器无效'});assert.ok(!JSON.stringify(response).includes('synthetic-private'));
  }
  for(const id of ['0','-1','1e0','2147483648'])assert.equal((await call(`/api/projects/${id}/context/exact`,{auth,body:{selector}})).status,400);
  for(const query of ['?q=','?projectId=2','?limit=1','?after=0'])assert.equal((await call('/api/projects/1/context/exact'+query,{auth,body:{selector}})).status,400);
  assert.equal(checkouts,before);
});
test('exact POST retains the JSON object, charset and 16KiB body gates',async()=>{
  const auth=await login(),before=checkouts;
  for(const body of ['', 'null','[]','{"selector":'])assert.equal((await call('/api/projects/1/context/exact',{auth,body})).status,400);
  assert.equal((await call('/api/projects/1/context/exact',{auth,body:{selector},headers:{'content-type':'text/plain'}})).status,415);
  const raw=JSON.stringify({selector})+' '.repeat(16385);assert.equal((await call('/api/projects/1/context/exact',{auth,body:raw})).status,413);
  assert.equal(checkouts,before);
});
test('current-labels accepts neither query controls nor a request body',async()=>{
  const auth=await login(),before=checkouts;
  for(const query of ['?limit=512','?after=0','?q=','?value=synthetic-private','?limit=1&limit=2'])assert.equal((await call('/api/projects/1/current-labels'+query,{auth})).status,400);
  for(const contentType of ['application/json','text/plain']){
    const result=await new Promise((resolve,reject)=>{
      const body='{}',req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/projects/1/current-labels',method:'GET',headers:{cookie:auth.cookie,'content-type':contentType,'content-length':Buffer.byteLength(body)}},res=>{let text='';res.on('data',data=>text+=data);res.on('end',()=>resolve({status:res.statusCode,text}))});req.once('error',reject);req.end(body);
    });
    assert.equal(result.status,400);assert.deepEqual(JSON.parse(result.text),{error:'标签请求不接受参数或请求体'});
  }
  assert.equal(checkouts,before);
});
test('database failures on exact POST use readonly diagnostics while existing creates keep uncertain-write guidance',async()=>{
  const auth=await login(),originalLog=console.error,logs=[];
  console.error=(...args)=>logs.push(args.join(' '));
  try{
    for(const [code,message] of [['ECONNRESET','数据库暂时不可用，请稍后重试'],['57014','数据库请求超时，请稍后重试']]){
      databaseError=Object.assign(new Error('synthetic-private-database-detail'),{code});
      for(const response of [await call('/api/projects/1/current-labels',{auth}),await call('/api/projects/1/context/exact',{auth,body:{selector}})]){
        assert.equal(response.status,503);assert.deepEqual(response.data,{error:message});
      }
      const boundary=await call('/api/projects/1/context/exact',{auth,body:{selector:{subject:'x'.repeat(100),predicate:'😀'.repeat(50)}}});
      assert.equal(boundary.status,503,'valid UTF-16 limits must pass input checks without being clipped');
      const write=await call('/api/projects/1/sources',{auth,body:{title:'synthetic',content:'synthetic'},headers:{'x-read-only':'true'}});
      assert.equal(write.status,503);assert.match(write.data.error,/写入结果可能不确定/);
    }
    assert.ok(logs.every(line=>!line.includes('synthetic-private')));
  }finally{console.error=originalLog}
});
