const {test}=require('node:test'),assert=require('node:assert/strict');
const {readContext}=require('../scripts/context-client');
test('context client rejects unsafe or silently truncated configuration before login',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw new Error('unexpected request')};
  for(const options of [{baseURL:'http://user:password@localhost:3000'},{baseURL:'http://localhost:3000/path'},{projectId:0},{limit:101},{query:'x'.repeat(201)},{timeoutMs:0}])await assert.rejects(()=>readContext({...options,fetchImpl}),e=>e.code.startsWith('INVALID_'));
  assert.equal(calls,0);
});
test('context client reports transport timeout without exposing supplied credentials',async()=>{
  await assert.rejects(()=>readContext({password:'unit-password-placeholder',fetchImpl:async()=>{throw new DOMException('unit-password-placeholder','TimeoutError')}}),e=>e.code==='REQUEST_TIMEOUT'&&!e.message.includes('placeholder'));
});
test('context client rejects malformed success and attempts logout after a failed read',async()=>{
  const calls=[];
  await assert.rejects(()=>readContext({fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname;calls.push(path);assert.equal(options.redirect,'error');
    if(path==='/api/login')return new Response(JSON.stringify({csrf:'unit-csrf'}),{headers:{'set-cookie':'sid=unit-session; HttpOnly'}});
    assert.equal(options.headers.cookie,'sid=unit-session');
    if(path==='/api/logout'){assert.equal(options.headers['X-CSRF-Token'],'unit-csrf');return new Response('{}')}
    return new Response('not json',{status:200});
  }}),e=>e.code==='INVALID_JSON_RESPONSE');
  assert.deepEqual(calls,['/api/login','/api/projects/1/facts','/api/logout']);
});
test('context client bounds chunked HTTP response bytes before accepting context',async()=>{
  const http=require('node:http');let loggedOut=false;
  const server=http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/login'){res.setHeader('set-cookie','sid=synthetic-session; HttpOnly');res.end(JSON.stringify({csrf:'synthetic-csrf'}));return}
    if(req.url==='/api/logout'){loggedOut=true;res.end('{}');return}
    res.write('{"role":"viewer","facts":[],"next_after":null,"padding":"');res.end('x'.repeat(2*1024*1024)+'"}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(()=>readContext({baseURL:`http://127.0.0.1:${server.address().port}`}),e=>e.code==='RESPONSE_TOO_LARGE');assert.equal(loggedOut,true)}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
test('whole-read deadline stops further reads but still attempts logout',async()=>{
  const paths=[];
  await assert.rejects(()=>readContext({totalTimeoutMs:100,fetchImpl:async(url)=>{
    const path=new URL(url).pathname;paths.push(path);
    if(path==='/api/login'){await new Promise(resolve=>setTimeout(resolve,150));return new Response('{"csrf":"unit"}',{headers:{'set-cookie':'sid=unit; HttpOnly'}})}
    return new Response('{}');
  }}),e=>e.code==='TOTAL_TIMEOUT');
  assert.deepEqual(paths,['/api/login','/api/logout']);
});
