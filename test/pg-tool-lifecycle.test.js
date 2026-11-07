const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {pgTool,PG_TOOL_LIMITS}=require('./pg-tool-helper');
const URL='postgres://synthetic:synthetic-password-canary@127.0.0.1:5432/synthetic';
const realChild=script=>(_command,_args,options)=>spawn(process.execPath,['-e',script],options);
function safe(error,code){
  assert.equal(error.code,code);assert.equal(error.cause,undefined);
  for(const text of [String(error.stack),JSON.stringify(error)]){
    assert.ok(!text.includes('synthetic-password-canary'));assert.ok(!text.includes('synthetic-private-stderr'));assert.ok(!text.includes(URL));
  }
  return true;
}

test('default limits and PostgreSQL argv/password placement remain compatible',async()=>{
  assert.deepEqual(PG_TOOL_LIMITS,{timeoutMs:60000,maxOutputBytes:8388608,terminationGraceMs:250});
  for(const name of ['pg_dump','pg_restore']){
    let observed;
    const result=await pgTool(name,URL,undefined,{spawnTool:(command,args,options)=>{
      observed={command,args,options};return realChild("process.stdout.write(Buffer.from([0,1,2,255]));process.stderr.write('synthetic-private-stderr')")(command,args,options);
    }});
    assert.equal(result.code,0);assert.deepEqual(result.bytes,Buffer.from([0,1,2,255]));
    assert.equal(observed.options.env.PGPASSWORD,'synthetic-password-canary');assert.ok(!observed.args.some(value=>value.includes('synthetic-password-canary')));
    if(process.env.PG_TOOLS_CONTAINER){assert.equal(observed.command,'docker');assert.deepEqual(observed.args.slice(0,6),['exec','-i','-e','PGPASSWORD',process.env.PG_TOOLS_CONTAINER,name])}
    else assert.equal(observed.command,fs.existsSync('/usr/lib/postgresql/16/bin/'+name)?'/usr/lib/postgresql/16/bin/'+name:name);
    assert.deepEqual(observed.args.slice(-1*(name==='pg_dump'?1:3)),name==='pg_dump'?['--format=custom']:['--exit-on-error','--single-transaction','--no-owner']);
  }
});

test('timeout and stdout overflow escalate a real SIGTERM-resistant child and reject only after close',{timeout:7000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'memz-pg-tool-lifecycle-'));
  try{
    for(const overflowing of [false,true]){
      const marker=path.join(directory,overflowing?'overflow':'timeout');let child,closed=false;
      const script=`const fs=require('node:fs');process.on('SIGTERM',()=>fs.appendFileSync(${JSON.stringify(marker)},'T'));
        fs.writeFileSync(${JSON.stringify(marker)},'S');process.stderr.write('synthetic-private-stderr');
        ${overflowing?"process.stdin.once('data',()=>process.stdout.write(Buffer.alloc(2048)));":''}
        process.stdout.write('ready');setInterval(()=>{},1000);`;
      child=spawn(process.execPath,['-e',script],{stdio:['pipe','pipe','pipe']});
      child.once('close',()=>{closed=true});
      let startupTimer;
      try{
        // Start the accelerated helper deadline only after the real child has
        // installed its signal handler. Slow CI process startup is not the fault.
        await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>{startupTimer=setTimeout(()=>reject(new Error('Synthetic resistant child did not start')),2000)})]);
        clearTimeout(startupTimer);
        const started=Date.now();
        await assert.rejects(()=>pgTool('pg_dump',URL,overflowing?Buffer.from('begin'):undefined,
          {timeoutMs:overflowing?2000:300,maxOutputBytes:1024,terminationGraceMs:250,spawnTool:()=>child}),error=>{
          safe(error,overflowing?'PG_TOOL_OUTPUT_LIMIT':'PG_TOOL_TIMEOUT');assert.equal(error.childClosed,true);assert.equal(error.signal,'SIGKILL');assert.equal(closed,true);return true;
        });
        assert.equal(fs.readFileSync(marker,'utf8'),'ST','child really started and ignored SIGTERM');
        assert.equal(child.signalCode,'SIGKILL');assert.throws(()=>process.kill(child.pid,0),error=>error.code==='ESRCH');
        assert.ok(Date.now()-started<2500);
      }finally{
        clearTimeout(startupTimer);
        if(!closed){const ending=once(child,'close');child.kill('SIGKILL');await ending;}
      }
    }
  }finally{fs.rmSync(directory,{recursive:true,force:true})}
});

test('stdin EPIPE preserves nonzero tool receipts but cannot turn undelivered input into success',async()=>{
  const input=Buffer.alloc(1024*1024,7);
  for(const code of [7,0]){
    const options={spawnTool:realChild(`require('node:fs').closeSync(0);process.stderr.write('synthetic-private-stderr');setTimeout(()=>process.exit(${code}),100)`),timeoutMs:2000};
    if(code){const result=await pgTool('pg_restore',URL,input,options);assert.equal(result.code,7);assert.deepEqual(result.bytes,Buffer.alloc(0));}
    else await assert.rejects(()=>pgTool('pg_restore',URL,input,options),error=>safe(error,'PG_TOOL_INPUT_FAILED')&&error.childClosed===true);
  }
});

test('spawn errors and synchronous stdin failures settle safely without leaking errors or credentials',async()=>{
  await assert.rejects(()=>pgTool('pg_dump',URL,undefined,{spawnTool:()=>{throw new Error('synthetic-password-canary '+URL)}}),error=>safe(error,'PG_TOOL_START_FAILED'));
  await assert.rejects(()=>pgTool('pg_dump',URL,undefined,{spawnTool:(_command,_args,options)=>spawn(path.join(os.tmpdir(),'memz-no-such-tool-'+process.pid),[],options)}),error=>safe(error,'PG_TOOL_START_FAILED')&&error.childClosed===true);
  await assert.rejects(()=>pgTool('pg_restore',URL,{invalid:true},{spawnTool:realChild('setInterval(()=>{},1000)'),timeoutMs:2000,terminationGraceMs:100}),error=>safe(error,'PG_TOOL_INPUT_FAILED')&&error.childClosed===true);
  for(const options of [{timeoutMs:0},{timeoutMs:60001},{maxOutputBytes:8388609},{terminationGraceMs:1001}])await assert.rejects(()=>pgTool('pg_dump',URL,undefined,options),error=>safe(error,'PG_TOOL_CONFIG'));
});
