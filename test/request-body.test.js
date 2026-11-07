const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {gzipSync}=require('node:zlib');
const {app,pool}=require('../server');
const server=app.listen(0,'127.0.0.1');
after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end()});
// Invalid inputs, login/logout and unknown routes must not touch PostgreSQL.
pool.connect=async()=>{throw new Error('Unexpected database checkout during input rejection')};
const credentials=JSON.stringify({username:'owner',password:'demo-owner'});
async function request(path,{body,headers={},auth,method='POST'}={}){
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{
    method,headers:{...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{}),...headers},body
  });
  const text=await response.text();
  return {status:response.status,headers:response.headers,text,json:()=>JSON.parse(text)};
}
async function login(){
  const r=await request('/api/login',{body:credentials,headers:{'content-type':'application/json'}});
  assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.json().csrf};
}
function rejected(r,status,{api=true}={}){
  assert.equal(r.status,status);assert.match(r.headers.get('content-type'),/application\/json/);
  if(api)assert.equal(r.headers.get('cache-control'),'no-store','API errors must remain non-cacheable before authentication, media and parser gates');
  const json=r.json();assert.deepEqual(Object.keys(json),['error']);assert.equal(typeof json.error,'string');
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.ok(r.headers.get('content-security-policy'));
  assert.equal(r.headers.get('set-cookie'),null,'拒绝请求不能创建会话');
}
test('JSON object endpoints reject absent and unsupported Content-Type consistently',async()=>{
  const auth=await login();
  for(const path of ['/api/projects/1/sources','/api/projects/1/candidates','/api/login']){
    rejected(await request(path,{auth}),415);
    for(const type of ['text/plain','application/x-www-form-urlencoded','application/octet-stream','application/problem+json']){
      rejected(await request(path,{auth,body:credentials,headers:{'content-type':type}}),415);
    }
  }
});
test('missing, malformed, scalar and array JSON are rejected without reflecting input',async()=>{
  const auth=await login();
  for(const path of ['/api/projects/1/sources','/api/projects/1/candidates','/api/login']){
    for(const body of [undefined,'',' ','null','true','1','"text"','[]','[{}]','{"secret-marker":']){
      const r=await request(path,{auth,body,headers:{'content-type':'application/json'}});rejected(r,400);
      assert.ok(!r.text.includes('secret-marker'));assert.ok(!r.text.includes('SyntaxError'));
    }
  }
});
test('JSON byte limit accepts 16 KiB and rejects larger or inflated bodies',async()=>{
  const prefix={username:'owner',password:'demo-owner',padding:''};
  const base=Buffer.byteLength(JSON.stringify(prefix));
  const boundary=JSON.stringify({...prefix,padding:'a'.repeat(16384-base)});
  assert.equal(Buffer.byteLength(boundary),16384);
  assert.equal((await request('/api/login',{body:boundary,headers:{'content-type':'application/json'}})).status,200);
  rejected(await request('/api/login',{body:boundary+' ',headers:{'content-type':'application/json'}}),413);
  const unicode=JSON.stringify({...prefix,padding:'汉'.repeat(6000)});
  assert.ok(unicode.length<16384&&Buffer.byteLength(unicode)>16384);
  rejected(await request('/api/login',{body:unicode,headers:{'content-type':'application/json'}}),413);
  rejected(await request('/api/login',{body:gzipSync(unicode),headers:{'content-type':'application/json','content-encoding':'gzip'}}),413);
});
test('unsupported charset and encoding return safe JSON errors',async()=>{
  rejected(await request('/api/login',{body:credentials,headers:{'content-type':'application/json; charset=iso-8859-1'}}),415);
  rejected(await request('/api/login',{body:credentials,headers:{'content-type':'application/json','content-encoding':'unknown'}}),415);
  const corrupt=await request('/api/login',{body:credentials,headers:{'content-type':'application/json','content-encoding':'gzip'}});
  rejected(corrupt,400);assert.equal(corrupt.json().error,'压缩请求体无效');
});
test('authentication and CSRF gates still reject unauthenticated or forged writes',async()=>{
  rejected(await request('/api/projects/1/sources',{body:'plain',headers:{'content-type':'text/plain'}}),401);
  const auth=await login();
  rejected(await request('/api/projects/1/sources',{auth:{...auth,csrf:'wrong'},body:'plain',headers:{'content-type':'text/plain'}}),403);
});
test('login Origin rejection and authenticated API misses use JSON errors',async()=>{
  rejected(await request('/api/login',{body:credentials,headers:{'content-type':'application/json',origin:'https://untrusted.example'}}),403);
  const auth=await login();rejected(await request('/api/missing',{auth,method:'GET'}),404);
});
test('valid JSON charset, field errors and bodyless logout retain existing behavior',async()=>{
  const r=await request('/api/login',{body:credentials,headers:{'content-type':'application/json; charset=utf-8'}});assert.equal(r.status,200);
  const auth=await login();
  for(const path of ['/api/projects/1/sources','/api/projects/1/candidates'])rejected(await request(path,{auth,body:'{}',headers:{'content-type':'application/json'}}),400);
  const logout=await request('/api/logout',{auth});assert.equal(logout.status,200);assert.deepEqual(logout.json(),{ok:true});
  rejected(await request('/api/me',{auth,method:'GET'}),401);
});
test('login requires a string username without array coercion or object conversion',async()=>{
  for(const username of [['owner'],[],null,true,1,{}, {toString:'owner'}, {toString:null,valueOf:null}]){
    rejected(await request('/api/login',{body:JSON.stringify({username,password:'demo-owner'}),headers:{'content-type':'application/json'}}),401);
  }
});

async function hostRequest(host,path,{body,headers={},method='POST'}={}){
  return new Promise((resolve,reject)=>{
    const req=require('node:http').request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host,'content-type':'application/json',...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode,headers:{get:name=>res.headers[name]??null},text,json:()=>JSON.parse(text)}));
    });req.on('error',reject);req.end(body);
  });
}
test('local demo rejects a foreign Host even when login Origin matches that Host',async()=>{
  const host='synthetic-demo.invalid';
  rejected(await hostRequest(host,'/api/login',{body:credentials,headers:{origin:`http://${host}`}}),403);
});

test('foreign Host cannot read assets or bypass checks with forwarded headers or a session',async()=>{
  const auth=await login();
  for(const host of ['localhost.synthetic.invalid','127.0.0.1.synthetic.invalid','localhost@synthetic.invalid','0.0.0.0','127.1','localhost:65536','localhost:0']){
    for(const path of ['/','/api/me']){
      const response=await hostRequest(host,path,{method:'GET',headers:{cookie:auth.cookie,'x-forwarded-host':'localhost','x-forwarded-proto':'http'}});rejected(response,403,{api:path.startsWith('/api/')});assert.equal(response.json().error,'仅支持本机演示地址');assert.ok(!response.text.includes(host));
    }
  }
  rejected(await hostRequest('synthetic.invalid','/api/login',{body:'not json',headers:{origin:'http://synthetic.invalid'}}),403);
});
test('literal loopback Hosts retain public demo login, CSRF and logout behavior',async()=>{
  for(const host of ['127.0.0.1','localhost',`localhost:${server.address().port}`,`[::1]:${server.address().port}`]){
    const loginResponse=await hostRequest(host,'/api/login',{body:credentials,headers:{origin:`http://${host}`}});assert.equal(loginResponse.status,200);
    const cookie=loginResponse.headers.get('set-cookie')[0].split(';')[0],csrf=loginResponse.json().csrf;
    assert.equal((await hostRequest(host,'/api/me',{method:'GET',headers:{cookie}})).status,200);
    rejected(await hostRequest(host,'/api/projects/1/sources',{body:'{}',headers:{cookie,'x-csrf-token':'wrong'}}),403);
    assert.equal((await hostRequest(host,'/api/logout',{body:'{}',headers:{cookie,'x-csrf-token':csrf}})).status,200);
    rejected(await hostRequest(host,'/api/login',{body:credentials,headers:{origin:'http://synthetic.invalid'}}),403);
  }
});
