// Real PG commit + SDK cancellation, only in a random synthetic local database.
// Proxy credentials, headers and bodies stay in memory and are never logged.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs'),path=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const {Client:PgClient}=require('pg');
const {Client:McpClient}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {databasePoolOptions}=require('../scripts/database');
const {startChild}=require('./server-shutdown-helpers');
const ROOT=path.resolve(__dirname,'..');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function within(promise,ms,message){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms)})])}
  finally{clearTimeout(timer)}
}
const directClient=url=>new PgClient({...databasePoolOptions(url),connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});

test('SDK cancellation after a real candidate commit closes HTTP and logs out before exact-key replay',{timeout:45000},async t=>{
  assert.ok(process.env.MIGRATION_TEST_DATABASE_URL,'Use an isolated local test administrator connection');
  let adminURL;try{adminURL=new URL(process.env.MIGRATION_TEST_DATABASE_URL)}catch{throw new Error('Invalid local fixture connection')}
  const admin=directClient(adminURL.href);
  assert.ok(['127.0.0.1','localhost','::1','[::1]'].includes(admin.host),'Synthetic cancellation fixture requires local PostgreSQL');
  const database='memz_mcp_cancel_'+randomBytes(8).toString('hex');
  let owner,app,proxy,transport,client,cancellation,connected=false,created=false,hostCancelled=false,mcpConnected=false,mcpClosed=false,watchdogExpired=false;
  let candidateId,firstAuth,firstIntent,proxyProblem,heldResponse,sdkSettled=false,firstLogoutStatus,requestCount=0;
  const committed=deferred(),cancelledHttp=deferred(),loggedOut=deferred(),transportClosed=deferred();
  const sockets=new Set(),upstreams=new Set(),handlers=new Set(),paths=[];
  let proxyClosing=false,candidatePosts=0,logoutPosts=0,mcpStderr='';
  const watchdog=setTimeout(()=>{
    watchdogExpired=true;proxyClosing=true;cancellation?.abort();
    for(const request of upstreams)request.destroy();for(const socket of sockets)socket.destroy();app?.child.kill('SIGTERM');
  },30000);
  const track=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));socket.setTimeout(12000,()=>socket.destroy())};
  async function counts(){
    const result={};
    for(const table of ['sources','candidates','audit','idempotency_requests','facts','revisions']){
      if(proxyClosing)throw new Error('Synthetic fixture is closing');
      result[table]=Number((await owner.query(`SELECT count(*) AS n FROM ${table} WHERE project_id=1`)).rows[0].n);
    }
    return result;
  }
  const upstream=(route,headers,body)=>new Promise((resolve,reject)=>{
    if(proxyClosing)return reject(new Error('Fixture proxy is closing'));
    const target=new URL(app.base);
    const request=http.request({hostname:target.hostname,port:target.port,path:route,method:'POST',headers,agent:false},response=>{
      const parts=[];let bytes=0;
      response.on('error',()=>reject(new Error('Synthetic upstream response failed')));
      response.on('data',part=>{
        bytes+=part.length;if(bytes>65536){response.destroy();request.destroy();reject(new Error('Synthetic upstream response exceeded limit'));return;}
        parts.push(part);
      });
      response.once('end',()=>resolve({status:response.statusCode,cookies:response.headers['set-cookie'],bytes:Buffer.concat(parts)}));
    });
    upstreams.add(request);request.once('close',()=>upstreams.delete(request));request.on('socket',track);
    request.once('error',()=>reject(new Error('Synthetic upstream request failed')));
    request.setTimeout(5000,()=>request.destroy());request.end(body);
  });
  let baseline,expected,proposal;
  async function handle(req,res){
    try{
      if(proxyClosing||++requestCount>10||req.method!=='POST'||!['/api/login','/api/logout','/api/projects/1/candidates'].includes(req.url))throw new Error();
      paths.push(req.url);const parts=[];let bytes=0;
      for await(const part of req){bytes+=part.length;if(bytes>16384)throw new Error();parts.push(part)}
      const body=Buffer.concat(parts);
      const firstCandidate=req.url==='/api/projects/1/candidates'&&candidatePosts++===0;
      if(firstCandidate){heldResponse=res;res.once('close',()=>cancelledHttp.resolve({afterHostCancellation:hostCancelled}))}
      const headers={'content-type':'application/json',
        ...(req.headers.cookie?{cookie:req.headers.cookie}:{}),
        ...(req.headers['x-csrf-token']?{'x-csrf-token':req.headers['x-csrf-token']}:{}),
        ...(req.headers['idempotency-key']?{'idempotency-key':req.headers['idempotency-key']}:{})};
      if(req.url==='/api/projects/1/candidates'){
        if(firstCandidate)firstIntent={key:req.headers['idempotency-key'],bodySha256:digest(body)};
        else if(firstIntent.key!==req.headers['idempotency-key']||firstIntent.bodySha256!==digest(body))throw new Error();
      }
      if(req.url==='/api/logout'&&logoutPosts===0){
        if(!firstAuth||headers.cookie!==firstAuth.cookie||headers['x-csrf-token']!==firstAuth.csrf)throw new Error();
      }
      const response=await upstream(req.url,headers,body);
      if(proxyClosing)throw new Error();
      if(req.url==='/api/login'&&!firstAuth){
        const json=JSON.parse(response.bytes);firstAuth={cookie:response.cookies?.[0]?.split(';')[0],csrf:json.csrf};
        if(!firstAuth.cookie||typeof firstAuth.csrf!=='string')throw new Error();
      }
      if(firstCandidate){
        if(response.status!==200)throw new Error();candidateId=JSON.parse(response.bytes).id;
        const rows=(await owner.query('SELECT id,status,source_id,expected_version,proposed_by FROM candidates WHERE project_id=1 AND subject=$1',[proposal.subject])).rows;
        if(proxyClosing)throw new Error();
        if(rows.length!==1||rows[0].id!==candidateId||rows[0].status!=='pending'||rows[0].source_id!==proposal.sourceId||rows[0].expected_version!==0||rows[0].proposed_by!==2)throw new Error();
        const audit=(await owner.query("SELECT count(*)::int AS n FROM audit WHERE project_id=1 AND actor_id=2 AND action='propose' AND detail=$1",[`候选 ${candidateId}`])).rows[0].n;
        if(proxyClosing)throw new Error();
        const receipts=(await owner.query("SELECT response FROM idempotency_requests WHERE project_id=1 AND actor_id=2 AND operation='candidates' AND request_key=$1",[proposal.idempotencyKey])).rows;
        if(audit!==1||receipts.length!==1||receipts[0].response.id!==candidateId||receipts[0].response.status!=='pending')throw new Error();
        assert.deepEqual(await counts(),expected);
        // Nothing, including response headers, is sent downstream. Only after
        // independent PG confirmation can the host trigger SDK cancellation.
        committed.resolve({verified:true});return;
      }
      if(req.url==='/api/logout'){
        logoutPosts++;
        if(logoutPosts===1){firstLogoutStatus=response.status;res.once('finish',()=>loggedOut.resolve())}
      }
      res.writeHead(response.status,{'content-type':'application/json',...(response.cookies?{'set-cookie':response.cookies}:{})});res.end(response.bytes);
    }catch{
      proxyProblem='SYNTHETIC_PROXY_FAILURE';committed.resolve({verified:false});res.destroy();
    }
  }
  async function closeProxy(){
    if(!proxy)return;proxyClosing=true;
    for(const request of upstreams)request.destroy();
    const endings=[...sockets].map(socket=>new Promise(resolve=>socket.once('close',resolve)));
    const stopped=new Promise((resolve,reject)=>proxy.close(error=>error?reject(new Error('Synthetic proxy close failed')):resolve()));
    for(const socket of sockets)socket.destroy();
    await within(Promise.all([stopped,...endings,...handlers]),5000,'Synthetic proxy cleanup deadline');
    assert.equal(sockets.size,0);assert.equal(upstreams.size,0);assert.equal(handlers.size,0);
  }
  let failure;
  try{
    admin.on('error',()=>{});await admin.connect();connected=true;await admin.query(`CREATE DATABASE ${database}`);created=true;
    const ownerURL=new URL(adminURL);ownerURL.pathname='/'+database;owner=directClient(ownerURL.href);owner.on('error',()=>{});await owner.connect();
    await owner.query(fs.readFileSync(path.join(ROOT,'db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    const sourceId=(await owner.query('INSERT INTO sources(project_id,title,content) VALUES(1,$1,$2) RETURNING id',
      ['MCP取消合成依据','只用于真实提交后的SDK取消回归，不代表真实业务。'])).rows[0].id;
    baseline=await counts();expected={...baseline,candidates:baseline.candidates+1,audit:baseline.audit+1,idempotency_requests:baseline.idempotency_requests+1};
    proposal=Object.freeze({sourceId,subject:'MCP取消已提交-'+randomBytes(4).toString('hex'),predicate:'状态',value:'原创合成待审值',expectedVersion:0,idempotencyKey:'mcp-cancel-commit-'+randomBytes(8).toString('hex')});
    const appURL=new URL('postgres://memz_app:memz_demo_only@127.0.0.1/memz');appURL.hostname=admin.host;appURL.port=String(admin.port);appURL.pathname='/'+database;appURL.searchParams.set('sslmode','disable');
    app=await startChild(['server.js'],{PORT:'0',DATABASE_URL:appURL.href});
    proxy=http.createServer((req,res)=>{const task=handle(req,res);handlers.add(task);task.then(()=>handlers.delete(task),()=>handlers.delete(task))});
    proxy.on('connection',track);await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    transport=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,'scripts/mcp-server.js')],cwd:ROOT,
      env:{MEMZ_BASE_URL:`http://127.0.0.1:${proxy.address().port}`,MEMZ_USERNAME:'member',MEMZ_PASSWORD:'demo-member',MEMZ_PROJECT_ID:'1',MEMZ_MCP_ALLOW_PROPOSALS:'1'},stderr:'pipe'});
    transport.stderr.on('data',bytes=>{mcpStderr=(mcpStderr+bytes).slice(-16384)});
    client=new McpClient({name:'synthetic-post-commit-cancellation-host',version:'1'});await client.connect(transport,{timeout:5000});mcpConnected=true;
    const originalClose=transport.onclose;transport.onclose=()=>{mcpClosed=true;originalClose?.();transportClosed.resolve()};
    const mcpPid=transport.pid,controller=new AbortController();cancellation=controller;
    const outcome=client.callTool({name:'memz_submit_proposal',arguments:proposal},undefined,{signal:controller.signal,timeout:15000})
      .then(()=>{sdkSettled=true;return {resolved:true}},()=>{sdkSettled=true;return {resolved:false}});
    const committedState=await within(committed.promise,8000,'Real candidate commit was not confirmed');
    assert.equal(committedState.verified,true);assert.equal(proxyProblem,undefined);assert.ok(!sdkSettled,'SDK must still be awaiting the withheld receipt');
    assert.ok(!heldResponse.headersSent&&!heldResponse.destroyed,'no receipt may arrive or close before SDK cancellation');
    const busy=await client.callTool({name:'memz_read_context',arguments:{limit:0}},undefined,{timeout:2000});
    assert.equal(JSON.parse(busy.content[0].text).code,'BUSY');
    hostCancelled=true;controller.abort();assert.equal((await within(outcome,3000,'SDK cancellation did not finish')).resolved,false);
    assert.equal((await within(cancelledHttp.promise,3000,'Cancelled HTTP response did not close')).afterHostCancellation,true);
    await within(loggedOut.promise,6500,'Independent logout did not complete');assert.equal(firstLogoutStatus,200);
    const revoked=await fetch(app.base+'/api/me',{headers:{cookie:firstAuth.cookie},signal:AbortSignal.timeout(3000)});
    assert.equal(revoked.status,401);await revoked.json();
    let released=false;
    for(let attempt=0;attempt<30;attempt++){
      const result=await client.callTool({name:'memz_read_context',arguments:{limit:0}},undefined,{timeout:1000});
      const code=JSON.parse(result.content[0].text).code;
      if(code!=='BUSY'){assert.equal(code,'INVALID_ARGUMENTS');released=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(released,true);assert.ok(transport.pid===mcpPid&&!mcpClosed,'SDK cancellation must leave the same MCP process alive');
    assert.equal(candidatePosts,1,'cancellation must not retry the committed write');assert.deepEqual(await counts(),expected);
    const replay=await client.callTool({name:'memz_submit_proposal',arguments:proposal},undefined,{timeout:10000});
    assert.equal(replay.isError,false);const receipt=JSON.parse(replay.content[0].text);
    assert.equal(receipt.candidateId,candidateId);assert.equal(receipt.statusAtCreation,'pending');assert.equal(receipt.autoApproved,false);assert.equal(receipt.sessionCleanup,'logged_out');
    assert.deepEqual(await counts(),expected);assert.equal(candidatePosts,2);assert.equal(logoutPosts,2);assert.equal(requestCount,6);assert.equal(proxyProblem,undefined);
    const pending=(await owner.query('SELECT status FROM candidates WHERE id=$1 AND project_id=1',[candidateId])).rows;
    assert.equal(pending.length,1);assert.equal(pending[0].status,'pending');assert.equal(watchdogExpired,false);
    assert.deepEqual(paths,['/api/login','/api/projects/1/candidates','/api/logout','/api/login','/api/projects/1/candidates','/api/logout']);
    assert.ok(mcpStderr==='','MCP diagnostics must remain empty');
    t.diagnostic('Synthetic real PG+SDK evidence: pending candidate/audit/idempotency committed before cancellation; held HTTP closed; independent logout revoked session; same MCP process released BUSY; identical-key replay kept one candidate/audit/receipt and zero new facts/revisions. Seven bounded HTTP requests, no approval or model call.');
  }catch(error){failure=error}
  finally{
    clearTimeout(watchdog);cancellation?.abort();
    const cleanup=[];
    if(client)try{await within(client.close(),6500,'MCP client cleanup deadline');if(mcpConnected)await within(transportClosed.promise,3000,'MCP child close not observed')}catch{cleanup.push('mcp')}
    try{await closeProxy()}catch{cleanup.push('proxy')}
    if(app)try{if(!app.result()){app.child.kill('SIGTERM');await within(app.exit,5000,'HTTP app close deadline')}}catch{try{await app.stop()}catch{}cleanup.push('app')}
    if(owner)try{await owner.end()}catch{cleanup.push('owner')}
    if(created)try{await admin.query(`DROP DATABASE ${database} WITH (FORCE)`)}catch{cleanup.push('database')}
    if(connected)try{await admin.end()}catch{cleanup.push('admin')}
    if(cleanup.length){
      t.diagnostic('Synthetic cancellation fixture cleanup failed at stages: '+cleanup.join(', '));
      failure=failure||new Error('Synthetic cancellation fixture cleanup failed');
    }else t.diagnostic('Synthetic cancellation fixture cleanup complete: MCP stdio close, proxy frontend/upstream sockets, HTTP child, direct connections and random database removed.');
  }
  if(failure)throw failure;
});
