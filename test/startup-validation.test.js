const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {once}=require('node:events');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile),server=path.resolve(__dirname,'../server.js');
const {listenPort}=require('../scripts/server-lifecycle');

test('CLI port defaults and zero-prefixed decimal values remain numeric TCP ports',()=>{
  for(const value of [undefined,''])assert.equal(listenPort(value),3000);
  for(const [value,port] of [['0',0],['00000',0],['00080',80],['3000',3000],['65535',65535]])assert.equal(listenPort(value),port);
  for(const value of ['0\n','0\r','0\u2028',3000,null])assert.throws(()=>listenPort(value),/^Error: INVALID_PORT$/);
});

async function failedStartup(port,cwd){
  let failure;
  try{await execute(process.execPath,[server],{cwd,env:{...process.env,PORT:port},timeout:10000,killSignal:'SIGKILL'})}
  catch(error){failure=error}
  assert.ok(failure,'invalid or unavailable ports must not start a server');
  assert.equal(failure.killed,false,'startup failure must finish without the test watchdog');
  assert.equal(failure.code,1);
  assert.equal(failure.stdout,'');
  return failure.stderr;
}

test('invalid PORT cannot become a Unix socket or appear in startup diagnostics',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memz-startup-port-'));
  try{
    for(const port of ['synthetic-private-port','-1','65536','1.5',' 3000','3000 ','1e3','0x1234','000000']){
      assert.equal(await failedStartup(port,dir),'Memz startup failed: invalid PORT.\n');
      assert.deepEqual(fs.readdirSync(dir),[],'invalid ports must not create socket files');
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('occupied TCP port fails with a fixed diagnostic and no successful startup link',async()=>{
  const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  try{assert.equal(await failedStartup(String(reserve.address().port),path.dirname(server)),'Memz startup failed: cannot listen.\n')}
  finally{await new Promise(resolve=>reserve.close(resolve))}
});

test('importing the app does not validate CLI-only PORT or bind a listener',async()=>{
  const result=await execute(process.execPath,['-e',"const {pool}=require(process.argv[1]);pool.end().then(()=>process.stdout.write('imported\\n'));",server],{
    env:{...process.env,PORT:'synthetic-invalid-import-port'},timeout:10000
  });
  assert.equal(result.stdout,'imported\n');assert.equal(result.stderr,'');
});
