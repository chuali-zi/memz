// Candidate creation only; the server retains authorization, version and audit rules.
const {fail,check,integer,writeRecord,runCLI}=require('./write-client');
async function submitProposal({baseURL,username,password,proposal,fetchImpl}={}){
  const fields=['projectId','sourceId','subject','predicate','value','expectedVersion','idempotencyKey'];
  check(proposal&&typeof proposal==='object'&&!Array.isArray(proposal)&&Object.keys(proposal).length===fields.length&&Object.keys(proposal).every(k=>fields.includes(k)),'INVALID_PROPOSAL');
  check(integer(proposal.projectId)&&integer(proposal.sourceId)&&integer(proposal.expectedVersion,0),'INVALID_IDENTIFIERS');
  for(const [field,max] of [['subject',100],['predicate',100],['value',1000]])check(typeof proposal[field]==='string'&&proposal[field].trim()&&proposal[field].length<=max&&proposal[field].isWellFormed()&&!proposal[field].includes('\0'),'INVALID_TEXT');
  check(typeof proposal.idempotencyKey==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(proposal.idempotencyKey),'INVALID_IDEMPOTENCY_KEY');
  proposal={...proposal}; // Keep the validated intent stable across asynchronous login.
  const body={subject:proposal.subject.trim(),predicate:proposal.predicate.trim(),value:proposal.value.trim(),source_id:proposal.sourceId,expected_version:proposal.expectedVersion};
  return writeRecord({baseURL,username,password,fetchImpl,projectId:proposal.projectId,operation:'candidates',body,idempotencyKey:proposal.idempotencyKey,receiptResult:receipt=>{
    if(receipt.status!=='pending')throw fail('INVALID_CREATION_RECEIPT','unknown');
    return {schemaVersion:1,projectId:proposal.projectId,candidateId:receipt.id,sourceId:receipt.source_id,expectedVersion:receipt.expected_version,statusAtCreation:'pending',currentStatusNotRead:true,autoApproved:false};
  }});
}
if(require.main===module)runCLI('proposal',submitProposal);
module.exports={submitProposal};
