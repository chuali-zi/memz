// Source creation only. A later candidate must explicitly bind the returned ID.
const {check,integer,writeRecord,runCLI}=require('./write-client');
async function createSource({baseURL,username,password,source,fetchImpl}={}){
  const fields=['projectId','title','content','idempotencyKey'];
  check(source&&typeof source==='object'&&!Array.isArray(source)&&Object.keys(source).length===fields.length&&Object.keys(source).every(k=>fields.includes(k)),'INVALID_SOURCE');
  check(integer(source.projectId),'INVALID_PROJECT');
  for(const [field,max] of [['title',150],['content',4000]])check(typeof source[field]==='string'&&source[field].trim()&&source[field].length<=max&&source[field].isWellFormed()&&!source[field].includes('\0'),'INVALID_TEXT');
  source={...source};
  const body={title:source.title.trim(),content:source.content.trim()};
  return writeRecord({baseURL,username,password,fetchImpl,projectId:source.projectId,operation:'sources',body,idempotencyKey:source.idempotencyKey,receiptResult:receipt=>({schemaVersion:1,projectId:source.projectId,sourceId:receipt.id,creationReceiptOnly:true,candidateCreated:false,autoApproved:false})});
}
if(require.main===module)runCLI('source',createSource);
module.exports={createSource};
