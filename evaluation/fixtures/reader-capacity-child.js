// Private IPC control fixture, never an HTTP administration endpoint.
const {performance}=require('node:perf_hooks');
const {app,pool}=require('../../server');
const {DATABASE_LIMITS}=require('../../scripts/database');
const {createCliHttpServer,HTTP_RECEIVE_OPTIONS}=require('../../scripts/http-server');
const {capacityProfile,budgetGroup,meterClient,fixtureBounds}=require('../capacity-budget');
const profile=capacityProfile(process.argv[2]);
const byteBudget=profile.budgeted?budgetGroup(profile.childBytes,profile.cleanupBytes):null;
let server,interval,closing=false,phase='startup',pendingSamples=0,droppedSamples=0;
let budgetFailureCode=null;
const held=[],started=performance.now();
function sample(){
  return {type:'resource',childElapsedMs:performance.now()-started,phase,rssBytes:process.memoryUsage().rss,
    cpu:process.cpuUsage(),pool:{total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount,held:held.length},droppedSamples,
    ...(byteBudget?{byteBudget:{...byteBudget.snapshot(),failureCode:budgetFailureCode}}:{})};
}
function send(value){if(process.connected)process.send(value,()=>{})}
if(byteBudget){
  const bound=fixtureBounds(require('../reader-capacity').dataset(),profile).child;
  pool.on('connect',client=>meterClient(client,byteBudget,bound,error=>{
    budgetFailureCode=/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'BYTE_MEASUREMENT_FAILED';
    send({...sample(),type:'budget-error',errorCode:budgetFailureCode});
  }));
}
async function shutdown(){
  if(closing)return;closing=true;clearInterval(interval);
  while(held.length)held.pop().release();
  if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});
  await pool.end();process.exit(0);
}
process.on('SIGTERM',()=>{shutdown().catch(()=>process.exit(1))});
process.on('disconnect',()=>{shutdown().catch(()=>process.exit(1))});
process.on('message',async message=>{
  if(closing||!message||!Number.isSafeInteger(message.id))return;
  try{
    if(message.command==='phase'){
      if(typeof message.phase!=='string'||message.phase.length>40)throw new Error();
      phase=message.phase;
    }else if(message.command==='hold'){
      if(held.length)throw new Error();
      for(let i=0;i<DATABASE_LIMITS.max;i++)held.push(await pool.connect());
    }else if(message.command==='release'){
      while(held.length)held.pop().release();
    }else if(message.command!=='sample')throw new Error();
    send({type:'control',id:message.id,ok:true,resource:sample()});
  }catch{
    while(held.length)held.pop().release();
    send({type:'control',id:message.id,ok:false,code:'CHILD_CONTROL_FAILED'});
  }
});
const listening=()=>{
  send({type:'ready',baseURL:`http://127.0.0.1:${server.address().port}`,limits:DATABASE_LIMITS,
    ...(profile.budgeted?{node:process.version,execPath:process.execPath,receivePolicy:{...HTTP_RECEIVE_OPTIONS,timeout:server.timeout,maxConnections:server.maxConnections}}:{})});
  interval=setInterval(()=>{
    if(!process.connected||pendingSamples>=2){droppedSamples++;return;}
    pendingSamples++;process.send(sample(),()=>{pendingSamples--});
  },100);
};
if(profile.budgeted){server=createCliHttpServer(app);server.listen(0,'127.0.0.1',listening)}
else server=app.listen(0,'127.0.0.1',listening);
