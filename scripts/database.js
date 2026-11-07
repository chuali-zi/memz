// Query timeout exceeds the server-side deadline so PostgreSQL can cancel the
// statement and accept ROLLBACK before the client has to discard the connection.
const DATABASE_LIMITS=Object.freeze({max:10,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:15000});
const MAX_PENDING_CHECKOUTS=32;
const pendingCheckouts=new WeakMap();
function pendingTransactionCheckouts(pool){return pendingCheckouts.get(pool)||0}
const connectionCodes=new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENETUNREACH','EHOSTUNREACH','57P01','57P02','57P03']);
const connectionMessages=new Set(['Connection terminated unexpectedly','Connection terminated','Client has encountered a connection error and is not queryable','Client was closed and is not queryable']);
const connectTimeoutMessages=new Set(['timeout exceeded when trying to connect','Connection terminated due to connection timeout']);

function databasePoolOptions(connectionString){
  let url;
  try{url=new URL(connectionString)}catch{throw new Error('Database connection URL is invalid')}
  if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Database connection URL is invalid');
  // pg lets URL parameters override constructor settings. Keep these deadlines
  // controlled by the application, including when an old URL disables them.
  for(const key of ['connectionTimeoutMillis','statement_timeout','query_timeout'])url.searchParams.delete(key);
  return {connectionString:url.href,...DATABASE_LIMITS};
}
function databaseErrorKind(error){
  if(error?.code==='DB_ADMISSION_BUSY')return 'busy';
  if(error?.code==='57014'||error?.message==='Query read timeout'||connectTimeoutMessages.has(error?.message))return 'timeout';
  if(connectionCodes.has(error?.code)||/^08[A-Z0-9]{3}$/.test(error?.code||'')||connectionMessages.has(error?.message))return 'connection';
  return null;
}
function discardConnection(error){
  return databaseErrorKind(error)==='connection'||error?.message==='Query read timeout';
}
function safeErrorCode(error){
  // Never log error messages, names, connection objects, SQL or parameter values.
  return error?.code==='DB_ADMISSION_BUSY'||connectionCodes.has(error?.code)||/^[0-9A-Z]{5}$/.test(error?.code||'')?error.code:'Error';
}
async function runTransaction(pool,user,fn,{snapshot=false}={}){
  const pending=pendingTransactionCheckouts(pool);
  if(pending>=MAX_PENDING_CHECKOUTS)throw Object.assign(new Error('Database admission is busy'),{code:'DB_ADMISSION_BUSY'});
  // Include handshakes and fulfilled checkouts whose await has not resumed.
  // Keep this single await inline: an async wrapper would delay the error
  // listener below by another microtask after pg hands us the client.
  pendingCheckouts.set(pool,pending+1);
  let client;
  try{client=await pool.connect()}
  finally{
    const remaining=pendingTransactionCheckouts(pool)-1;
    if(remaining)pendingCheckouts.set(pool,remaining);else pendingCheckouts.delete(pool);
  }
  let connectionError,discard;
  // A checked-out pg client has no pool error listener. Keep one while fn may
  // await other work so a lost backend cannot become an uncaught error event.
  const onError=error=>{connectionError=error};
  client.on('error',onError);
  try{
    await client.query(snapshot?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    await client.query("SELECT set_config('app.user_id',$1,true)",[String(user)]);
    const result=await fn(client);
    const committed=await client.query('COMMIT');
    // An aborted transaction accepts COMMIT but reports ROLLBACK. This can
    // happen when fn catches a SQL error; its return value is not a receipt.
    if(committed?.command!=='COMMIT')throw new Error('Database transaction did not commit');
    return result;
  }catch(error){
    if(connectionError||discardConnection(error))discard=connectionError||error;
    else{
      try{await client.query('ROLLBACK')}
      catch(rollbackError){discard=rollbackError}
    }
    // Preserve the original failure, including its status/code and uncertain
    // COMMIT outcome. A rollback error must never replace it or cause a retry.
    throw error;
  }finally{
    // release(error) removes the client; ordinary rollback keeps a usable one.
    // pg attaches its idle listener during release before ours is removed.
    client.release(discard);
    client.removeListener('error',onError);
  }
}

module.exports={DATABASE_LIMITS,MAX_PENDING_CHECKOUTS,pendingTransactionCheckouts,databasePoolOptions,databaseErrorKind,safeErrorCode,runTransaction};
