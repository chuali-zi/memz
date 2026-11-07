const SHUTDOWN_TIMEOUT_MS=20000;

function createShutdownGate(){
  let draining=false;
  return {
    beginDrain:()=>{draining=true},
    middleware:(req,res,next)=>{
      if(!draining)return next();
      res.set('Connection','close').status(503).json({error:'服务正在停止，请稍后重试'});
    }
  };
}

// Installed only by the CLI. Imported apps keep ownership of their own server,
// signals and pool. The deadline includes both HTTP drain and pool shutdown.
function installShutdown({server,pool,onDrain=()=>{}}){
  let stopping=false,finished=false,deadline;
  function finish(code,message){
    if(finished)return;
    finished=true;clearTimeout(deadline);
    if(message)console.error(message);
    if(code!==0){try{server.closeAllConnections?.()}catch{}}
    // An unfinished JS callback can retain a checked-out client indefinitely.
    // Exit at the deadline rather than force-release it and race tx's finally.
    process.exit(code);
  }
  function shutdown(){
    if(stopping)return;
    stopping=true;
    // Keep this timer referenced: an unresolved pool.end() promise alone need
    // not keep Node alive, but must not produce a misleading successful exit.
    deadline=setTimeout(()=>finish(1,'Shutdown deadline exceeded; exiting.'),SHUTDOWN_TIMEOUT_MS);
    try{
      onDrain();
      console.log('Memz stopping; waiting for active requests.');
      server.close(error=>{
        if(error)return finish(1,'Shutdown failed; exiting.');
        Promise.resolve().then(()=>pool.end()).then(()=>finish(0),()=>finish(1,'Shutdown failed; exiting.'));
      });
      server.closeIdleConnections?.();
    }catch{finish(1,'Shutdown failed; exiting.')}
  }
  process.on('SIGTERM',shutdown);
  process.on('SIGINT',shutdown);
  return shutdown;
}

module.exports={SHUTDOWN_TIMEOUT_MS,createShutdownGate,installShutdown};
