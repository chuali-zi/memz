const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {MAX_SESSIONS}=require('../scripts/session-store');
const {app,pool}=require('../server');
const server=app.listen(0,'127.0.0.1');
const ready=once(server,'listening');
after(async()=>{await new Promise(resolve=>server.close(resolve));await pool.end()});
pool.connect=async()=>{throw new Error('Session lifecycle must not need a database checkout')};

async function call(path,{method='GET',cookie,csrf,body,origin}={}){
  await ready;
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{
    method,headers:{...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(body?{'content-type':'application/json'}:{}),...(origin?{origin}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)
  });
  const data=await response.json();
  return {status:response.status,headers:response.headers,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const login=(cookie,extra={})=>call('/api/login',{method:'POST',cookie,body:{username:'owner',password:'demo-owner'},...extra});

test('login rotation, capacity rejection and logout preserve usable sessions',async()=>{
  let auth=await login();assert.equal(auth.status,200);
  assert.deepEqual(Object.keys(auth.data).sort(),['csrf','name']);
  assert.match(auth.headers.get('set-cookie'),/HttpOnly/);
  assert.match(auth.headers.get('set-cookie'),/SameSite=Strict/);
  assert.match(auth.headers.get('set-cookie'),/Max-Age=28800/);
  const original=auth;
  const wrong=await login(auth.cookie,{body:{username:'owner',password:'incorrect'}});
  assert.equal(wrong.status,401);assert.equal(wrong.cookie,undefined);
  assert.equal((await call('/api/me',{cookie:auth.cookie})).status,200);
  const foreign=await login(auth.cookie,{origin:'https://untrusted.example'});
  assert.equal(foreign.status,403);assert.equal(foreign.cookie,undefined);
  assert.equal((await call('/api/me',{cookie:auth.cookie})).status,200);

  auth=await login(auth.cookie);assert.equal(auth.status,200);
  assert.notEqual(auth.cookie,original.cookie);assert.notEqual(auth.data.csrf,original.data.csrf);
  assert.equal((await call('/api/me',{cookie:original.cookie})).status,401);
  assert.equal((await call('/api/logout',{method:'POST',cookie:auth.cookie,csrf:original.data.csrf})).status,403);
  assert.equal((await call('/api/me',{cookie:auth.cookie})).status,200);

  // Concurrent batches exercise real HTTP admission; the original login occupies
  // one slot. Successful reauthentication above must not consume another slot.
  for(let i=1;i<MAX_SESSIONS;i+=25){
    const batch=await Promise.all(Array.from({length:Math.min(25,MAX_SESSIONS-i)},()=>login()));
    for(const result of batch)assert.equal(result.status,200);
  }
  for(const cookie of [undefined,'sid=forged',original.cookie]){
    const rejected=await login(cookie);
    assert.equal(rejected.status,503);assert.equal(rejected.cookie,undefined);
    assert.equal(rejected.headers.get('retry-after'),'60');
    assert.deepEqual(rejected.data,{error:'登录会话已满，请稍后重试'});
  }
  assert.equal((await call('/api/me',{cookie:auth.cookie})).status,200,'capacity rejection must retain active sessions');
  const replacement=await login(auth.cookie);assert.equal(replacement.status,200,'existing login can rotate while full');
  assert.equal((await call('/api/me',{cookie:auth.cookie})).status,401);
  assert.equal((await login()).status,503,'rotation must keep the same session count');
  assert.equal((await call('/api/logout',{method:'POST',cookie:replacement.cookie,csrf:replacement.data.csrf})).status,200);
  assert.equal((await call('/api/me',{cookie:replacement.cookie})).status,401);
  assert.equal((await login()).status,200,'logout frees admission capacity');
});
