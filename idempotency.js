const crypto=require('node:crypto');
const fail=(status,message)=>Object.assign(new Error(message),{status});
function requestKey(req){
  const key=req.get('Idempotency-Key');
  if(key===undefined)return null;
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw fail(400,'Idempotency-Key 格式无效');
  return key;
}
// Caller checks current authorization before entering. Must use the same
// READ COMMITTED transaction as create(), including its audit write.
async function createOnce(c,{project,user,operation,key,payload},create){
  if(key===null)return create();
  const scope=[project,user,operation,key];
  const hash=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['memz-create-v1',...scope])]);
  const previous=(await c.query(`SELECT request_hash,response FROM idempotency_requests
    WHERE project_id=$1 AND actor_id=$2 AND operation=$3 AND request_key=$4`,scope)).rows[0];
  if(previous){
    if(previous.request_hash!==hash)throw fail(409,'幂等键已用于不同的创建内容');
    return previous.response;
  }
  const response=await create();
  await c.query(`INSERT INTO idempotency_requests(project_id,actor_id,operation,request_key,request_hash,response)
    VALUES($1,$2,$3,$4,$5,$6)`,[...scope,hash,JSON.stringify(response)]);
  return response;
}
module.exports={requestKey,createOnce};
