const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {readContext}=require('../scripts/context-client');

test('the existing context reader accepts logout 401 while cancelling its unfinished real HTTP body',async()=>{
  let logoutClosed=false,logoutCalls=0;
  const server=http.createServer((req,res)=>{
    req.resume();res.setHeader('content-type','application/json');
    if(req.url==='/api/login'){res.setHeader('set-cookie','sid=synthetic-session; HttpOnly');res.end(JSON.stringify({csrf:'synthetic-csrf'}));return}
    if(req.url==='/api/logout'){
      logoutCalls++;res.statusCode=401;res.once('close',()=>{logoutClosed=true});res.write('{"synthetic-private-error":');return;
    }
    res.end(JSON.stringify({role:'viewer',facts:[],next_after:null}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const context=await readContext({baseURL:`http://127.0.0.1:${server.address().port}`,timeoutMs:2000,totalTimeoutMs:5000});
    assert.deepEqual(context.facts,[]);assert.ok(!JSON.stringify(context).includes('synthetic-private-error'));assert.equal(logoutCalls,1);
    const limit=Date.now()+500;while(!logoutClosed&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(logoutClosed,true,'the unused body must close before the per-request timeout');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
