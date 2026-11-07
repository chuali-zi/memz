const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const {once}=require('node:events');
const {spawn}=require('node:child_process');
const {DATABASE_LIMITS}=require('../scripts/database');

test('a database TCP peer that never completes its handshake yields a bounded sanitized HTTP failure',async()=>{
  const sockets=new Set(),blackhole=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket))});
  blackhole.listen(0,'127.0.0.1');await once(blackhole,'listening');
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',DATABASE_URL:`postgres://synthetic-user:synthetic-private-marker@127.0.0.1:${blackhole.address().port}/synthetic-db?sslmode=disable`},stdio:['ignore','pipe','pipe']});
  const exit=new Promise(resolve=>child.once('exit',resolve));let stderr='';child.stderr.on('data',data=>stderr+=data);
  try{
    const base=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Timeout test app did not start')),10000);let output='';
      child.once('error',()=>{clearTimeout(timer);reject(new Error('Timeout test app failed to start'))});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Timeout test app exited before startup'))});
      child.stdout.on('data',data=>{output+=data;const match=output.match(/Memz (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1])}});
    });
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'viewer',password:'demo-viewer'})});
    assert.equal(login.status,200);await login.json();const cookie=login.headers.get('set-cookie').split(';')[0];
    const started=Date.now(),response=await fetch(base+'/api/projects',{headers:{cookie},signal:AbortSignal.timeout(DATABASE_LIMITS.connectionTimeoutMillis+5000)});
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'数据库请求超时，请稍后重试'});
    assert.ok(Date.now()-started<DATABASE_LIMITS.connectionTimeoutMillis+4000,'handshake timeout must finish without an external abort');
    assert.equal(stderr.trim(),'Request failed: Error');
    assert.ok(!stderr.includes('synthetic-private-marker'));assert.equal(child.exitCode,null);
    const me=await fetch(base+'/api/me',{headers:{cookie}});assert.equal(me.status,200);await me.json();
  }finally{
    if(child.exitCode===null)child.kill('SIGTERM');await exit;
    for(const socket of sockets)socket.destroy();await new Promise(resolve=>blackhole.close(resolve));
  }
});
