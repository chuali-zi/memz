// Local synthetic wire peers only: no real PostgreSQL, user data or SQL writes.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {checkSetup}=require('../scripts/check-setup');
const ROOT=path.resolve(__dirname,'..');

async function probe({authenticate}){
  const sockets=new Set(),queries=[];let statementDeadline,applicationName,child,closed=false,timer,forced=false;
  // AuthenticationOk + ReadyForQuery, without reading/logging auth values.
  const ready=Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73]);
  const peer=net.createServer(socket=>{
    sockets.add(socket);let startup=Buffer.alloc(0),pending=Buffer.alloc(0),authenticated=false;
    socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    socket.on('data',bytes=>{
      if(!authenticate)return; // TCP handshake succeeds but PG startup never does.
      if(!authenticated){
        startup=Buffer.concat([startup,bytes]);
        if(startup.length<8)return;
        const length=startup.readInt32BE(0);
        if(length<9||length>8192){socket.destroy();return;}
        if(startup.length<length)return;
        const fields=startup.subarray(8,length-1).toString('utf8').split('\0');
        for(let i=0;i<fields.length-1;i+=2){
          if(fields[i]==='statement_timeout')statementDeadline=fields[i+1];
          if(fields[i]==='application_name')applicationName=fields[i+1];
        }
        startup=Buffer.alloc(0);authenticated=true;socket.write(ready);
      }else{
        // The only query is the diagnostic's fixed BEGIN READ ONLY. Never
        // respond, so the driver's query deadline must close this connection.
        if(pending.length+bytes.length>8192){socket.destroy();return;}
        pending=Buffer.concat([pending,bytes]);
        while(pending.length>=5){
          const length=pending.readInt32BE(1);
          if(length<4||length>8192){socket.destroy();return;}
          if(pending.length<length+1)return;
          if(pending[0]===81)queries.push(pending.subarray(5,length).toString('utf8'));
          pending=pending.subarray(length+1);
        }
      }
    });
  });
  peer.listen(0,'127.0.0.1');await once(peer,'listening');
  const url=new URL(`postgres://synthetic-user:synthetic-deadline-canary@127.0.0.1:${peer.address().port}/synthetic`);
  url.search='?query_timeout=60000&query_timeout=90000&statement_timeout=0&connectionTimeoutMillis=60000&application_name=setup-deadline-fixture&sslmode=disable';
  let stdout='',stderr='',outcome;const started=Date.now();
  try{
    child=spawn(process.execPath,['scripts/check-setup.js'],{cwd:ROOT,env:{...process.env,DATABASE_URL:url.href},stdio:['ignore','pipe','pipe']});
    const exit=new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error('Synthetic diagnostic child failed to start')));child.once('close',(code,signal)=>{closed=true;resolve({code,signal})})});
    child.stdout.on('data',bytes=>{stdout=(stdout+bytes).slice(-16384)});child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-16384)});
    timer=setTimeout(()=>{forced=true;child.kill('SIGKILL')},9000);
    outcome=await exit;clearTimeout(timer);
    assert.equal(forced,false,'diagnostic must finish without the fixture watchdog');
    assert.equal(outcome.code,1);assert.equal(outcome.signal,null);assert.equal(stderr,'');
    const report=JSON.parse(stdout);assert.equal(report.ok,false);assert.equal(report.code,'DATABASE_UNAVAILABLE');
    assert.ok(!stdout.includes('synthetic-deadline-canary'));assert.ok(!stdout.includes(url.href));assert.ok(!stdout.includes('synthetic-user'));
    assert.ok(Date.now()-started<8000,'URL overrides must not replace the diagnostic five-second deadline');
    if(authenticate){
      assert.equal(statementDeadline,'5000');assert.equal(applicationName,'setup-deadline-fixture','unrelated startup parameters must survive');
      assert.deepEqual(queries,['BEGIN READ ONLY']);
      assert.ok(Date.now()-started>=4000,'the peer must exercise the fixed query deadline, not an immediate startup rejection');
    }
  }finally{
    clearTimeout(timer);
    if(child&&!closed){const exit=once(child,'close');child.kill('SIGKILL');await exit;}
    // Wait for every actual socket close, including destroyed-but-not-closed sockets.
    const endings=[...sockets].map(socket=>new Promise(resolve=>socket.once('close',resolve)));
    const stopped=new Promise(resolve=>peer.close(resolve));for(const socket of sockets)socket.destroy();
    await Promise.all([stopped,...endings]);assert.equal(sockets.size,0);
  }
}

test('setup CLI keeps fixed startup and query deadlines despite duplicate URL overrides, with no secret output',{timeout:12000},async()=>{
  await Promise.all([probe({authenticate:false}),probe({authenticate:true})]);
});

test('deadline sanitization retains actual host overrides and malformed URL failures stay fixed',async()=>{
  for(const url of ['postgres://u:synthetic-canary@127.0.0.1/db?query_timeout=60000&host=example.invalid',
    'postgres://u:synthetic-canary@localhost/db?statement_timeout=0&port=70000']){
    const result=await checkSetup(url);assert.equal(result.code,'LOCAL_DATABASE_REQUIRED');assert.ok(!JSON.stringify(result).includes('synthetic-canary'));
  }
  for(const url of ['synthetic-canary','postgres://u:synthetic-canary@[invalid']){
    const result=await checkSetup(url);assert.equal(result.code,'DATABASE_UNAVAILABLE');assert.ok(!JSON.stringify(result).includes('synthetic-canary'));
  }
});
