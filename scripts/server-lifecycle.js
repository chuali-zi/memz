const SHUTDOWN_TIMEOUT_MS=20000;

function listenPort(value){
  if(value===undefined||value==='')return 3000;
  if(typeof value!=='string'||!/^[0-9]{1,5}$/.test(value)||Number(value)>65535)throw new Error('INVALID_PORT');
  return Number(value);
}

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
  let stopping=false,finished=false,failed=false,deadline;
  const sockets=new Map();
  function trackSocket(socket){
    let state=sockets.get(socket);
    if(state)return state;
    state={active:0};sockets.set(socket,state);
    socket.once('close',()=>sockets.delete(socket));
    // The connection event can already be queued when server.close() runs.
    if(stopping)socket.destroy();
    return state;
  }
  server.on('connection',trackSocket);
  // Count before the application's request listener can finish synchronously.
  // Complete headers admit a request, including one whose body is still arriving.
  server.prependListener('request',(request,response)=>{
    const socket=request.socket,state=trackSocket(socket);state.active++;
    let settled=false;
    const settle=()=>{
      if(settled)return;
      settled=true;state.active--;
      // end() flushes queued response bytes; destroy() here could truncate them.
      // Pipelined responses share a socket and must all finish first.
      if(stopping&&state.active===0&&!socket.destroyed)socket.end();
    };
    response.once('finish',settle);response.once('close',settle);
  });
  function finish(code,message){
    if(finished)return;
    if(failed&&code===0)code=1;
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
      // Native closeIdleConnections does not close a speculative TCP connection
      // that has never submitted HTTP headers. It has no admitted work to drain.
      for(const [socket,state] of sockets)if(state.active===0)socket.destroy();
      server.closeIdleConnections?.();
    }catch{finish(1,'Shutdown failed; exiting.')}
  }
  process.on('SIGTERM',shutdown);
  process.on('SIGINT',shutdown);
  shutdown.fail=()=>{
    if(finished)return;
    if(!failed){failed=true;console.error('HTTP server failed; stopping.')}
    shutdown();
  };
  return shutdown;
}

module.exports={SHUTDOWN_TIMEOUT_MS,listenPort,createShutdownGate,installShutdown};
