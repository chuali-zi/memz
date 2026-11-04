const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const net=require('node:net');
const {once}=require('node:events');

test('CLI startup advertises its configured port and serves an authenticated database request',async()=>{
  const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let timer,output='';
  try{
    const url=await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('CLI startup timed out')),10000);
      child.on('error',reject);child.once('exit',code=>reject(new Error(`CLI exited before startup: ${code}`)));
      child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/Memz (http:\/\/127\.0\.0\.1:\d+)/);if(match)resolve(match[1])});
      child.stderr.on('data',()=>{});
    });
    assert.equal(url,`http://127.0.0.1:${port}`,'startup link must target this process, not a different server on port 3000');
    const login=await fetch(`${url}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'demo-owner'}),signal:AbortSignal.timeout(5000)});
    assert.equal(login.status,200);
    const projects=await fetch(`${url}/api/projects`,{headers:{cookie:login.headers.get('set-cookie').split(';')[0]},signal:AbortSignal.timeout(5000)});
    assert.equal(projects.status,200);assert.ok((await projects.json()).some(p=>p.id===1&&p.role==='owner'));
  }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGTERM');await exited}
});
