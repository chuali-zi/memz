// Evaluation-only instrumentation. Use pg's callback handoff so installing the
// wrappers does not add an async/await hop before runTransaction owns the client.
const capturing=new WeakSet();
async function captureQueries(pool,read,accept){
  if(capturing.has(pool))throw Object.assign(new Error('Query capture is already active for this pool'),{code:'CAPTURE_IN_PROGRESS'});
  capturing.add(pool);
  const connect=pool.connect,queries=[],clients=new Map();let open=true;
  function unpatch(state,keepListener=false){
    const {client,query,release,onError}=state;let failed=false,failure;
    const clean=fn=>{try{fn()}catch(error){if(!failed){failed=true;failure=error}}};
    if(clients.get(client)===state)clients.delete(client);
    clean(()=>{if(client.query===state.wrappedQuery)client.query=query});
    clean(()=>{if(client.release===state.wrappedRelease)client.release=release});
    if(!keepListener)clean(()=>client.removeListener('error',onError));
    if(failed)throw failure;
  }
  function instrument(client){
    const state={client,query:client.query,release:client.release,failure:undefined};
    // An acquire hook may queue an error before the awaiting caller resumes.
    // Retain its exact error and reject the first query without sending SQL.
    state.onError=error=>{state.failure=state.failure||error};
    state.wrappedQuery=function(...args){
      // The transaction's own listener now owns active-connection failures.
      if(client.listenerCount('error')>1)client.removeListener('error',state.onError);
      if(state.failure){
        const callback=typeof args.at(-1)==='function'?args.at(-1):args[0]?.callback;
        if(typeof callback==='function'){process.nextTick(callback,state.failure);return}
        return Promise.reject(state.failure);
      }
      if(accept(args[0],args[1]))queries.push({sql:args[0],params:args[1]});
      return state.query.apply(this,args);
    };
    state.wrappedRelease=function(...args){
      let cleanupFailed=false,cleanupError,result,releaseFailed=false,releaseError;
      try{unpatch(state,true)}catch(error){cleanupFailed=true;cleanupError=error}
      if(state.failure&&!args[0])args[0]=state.failure;
      // Restore before pg can synchronously hand this client to another waiter;
      // retain the bridge until pg has installed its idle error listener.
      try{result=state.release.apply(this,args)}catch(error){releaseFailed=true;releaseError=error}
      try{client.removeListener('error',state.onError)}catch(error){if(!cleanupFailed){cleanupFailed=true;cleanupError=error}}
      if(releaseFailed)throw releaseError;
      if(cleanupFailed)throw cleanupError;
      return result;
    };
    clients.set(client,state);
    try{client.on('error',state.onError);client.query=state.wrappedQuery;client.release=state.wrappedRelease}
    catch(error){try{unpatch(state)}catch{}throw error}
  }
  function wrappedConnect(callback){
    const receiver=this;
    const start=done=>connect.call(receiver,(error,client,release)=>{
      if(!error&&client&&open){
        try{instrument(client)}catch(instrumentError){
          // This lease has not reached its caller. An instrumentation failure
          // may release this one lease, never an already active client's lease.
          try{release.call(client,instrumentError)}catch{}
          done(instrumentError);return;
        }
        done(null,client,client.release);return;
      }
      done(error,client,release);
    });
    if(callback)return start(callback);
    const PromiseImpl=receiver.Promise||Promise;
    return new PromiseImpl((resolve,reject)=>start((error,client)=>error?reject(error):resolve(client)));
  }
  let failed=false,failure,result;
  const cleanup=fn=>{try{fn()}catch(error){if(!failed){failed=true;failure=error}}};
  try{pool.connect=wrappedConnect;result=await read()}
  catch(error){failed=true;failure=error}
  finally{
    open=false;
    cleanup(()=>{pool.connect=connect});
    for(const state of clients.values())cleanup(()=>unpatch(state));
    clients.clear();capturing.delete(pool);
  }
  if(failed)throw failure;
  return {result,queries};
}
module.exports={captureQueries};
