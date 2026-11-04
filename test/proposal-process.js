const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {submitProposal}=require('../scripts/proposal-client');
const {createSource}=require('../scripts/source-client');
module.exports=async({baseURL,call,owner,member,viewer})=>{
  const sourceInput={projectId:1,title:'外部提交依据（合成）',content:'本次截止日为18号。',idempotencyKey:randomUUID()};
  const sourceRun=await run(sourceInput,'member','scripts/source-client.js');assert.equal(sourceRun.code,0,sourceRun.stderr);
  const sourceReceipt=JSON.parse(sourceRun.stdout);assert.equal(sourceReceipt.candidateCreated,false);assert.equal(sourceReceipt.sessionCleanup,'logged_out');
  const sourceReplay=await run(sourceInput,'member','scripts/source-client.js');assert.equal(sourceReplay.code,0);assert.equal(JSON.parse(sourceReplay.stdout).sourceId,sourceReceipt.sourceId);
  for(const [input,user,status] of [[sourceInput,'viewer',403],[sourceInput,'other',403],[{...sourceInput,projectId:2},'member',403],[{...sourceInput,content:'更改正文'},'member',409]]){
    const result=await run(input,user,'scripts/source-client.js');assert.equal(result.code,1);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).status,status);
  }
  const sourceState=(await call(viewer,'/api/projects/1/data')).data;
  assert.equal(sourceState.sources.filter(s=>s.id===sourceReceipt.sourceId).length,1);
  assert.equal(sourceState.audit.filter(a=>a.action==='source'&&a.detail===`新增来源 ${sourceReceipt.sourceId}`).length,1);
  const source={data:{id:sourceReceipt.sourceId}};
  const proposal={projectId:1,sourceId:source.data.id,subject:'外部提交-'+randomUUID(),predicate:'截止日',value:'18号',expectedVersion:0,idempotencyKey:randomUUID()};
  function run(input,username='member',script='scripts/proposal-client.js'){
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[script,'--stdin'],{env:{...process.env,MEMZ_BASE_URL:baseURL,MEMZ_USERNAME:username,MEMZ_PASSWORD:`demo-${username}`},stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('proposal child timeout'))},25000);
      child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('error',reject);child.stdin.on('error',()=>{});
      child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});child.stdin.end(typeof input==='string'?input:JSON.stringify(input));
    });
  }
  const first=await run(proposal);assert.equal(first.code,0,first.stderr);assert.equal(first.stderr,'');const receipt=JSON.parse(first.stdout);assert.equal(receipt.statusAtCreation,'pending');assert.equal(receipt.autoApproved,false);assert.equal(receipt.sessionCleanup,'logged_out');
  const replay=await run(proposal);assert.equal(replay.code,0);assert.equal(JSON.parse(replay.stdout).candidateId,receipt.candidateId);
  const read=()=>call(viewer,`/api/projects/1/data?q=${encodeURIComponent(proposal.subject)}`);
  const pending=(await read()).data;assert.equal(pending.facts.length,0);assert.equal(pending.candidates.filter(c=>c.subject===proposal.subject).length,1);assert.equal(pending.audit.filter(a=>a.action==='propose'&&a.detail===`候选 ${receipt.candidateId}`).length,1);
  for(const [input,user,status] of [[proposal,'viewer',403],[proposal,'other',403],[{...proposal,sourceId:4,idempotencyKey:randomUUID()},'member',400],[{...proposal,value:'19号'},'member',409]]){
    const rejected=await run(input,user);assert.equal(rejected.code,1);assert.equal(rejected.stdout,'');assert.equal(JSON.parse(rejected.stderr).status,status);assert.equal(JSON.parse(rejected.stderr).outcome,'rejected');assert.ok(!rejected.stderr.includes('demo-'));
  }
  for(const input of ['{',JSON.stringify({...proposal,sourceId:0}),'x'.repeat(16385)]){const bad=await run(input);assert.equal(bad.code,1);assert.equal(bad.stdout,'');assert.equal(JSON.parse(bad.stderr).outcome,'not_attempted')}
  assert.equal((await call(owner,`/api/projects/1/candidates/${receipt.candidateId}/approve`,{})).status,200);
  assert.equal((await read()).data.facts[0].value,'18号');
  const approvedFact=(await read()).data.facts[0];
  const proof=await call(viewer,`/api/projects/1/facts/${approvedFact.id}/provenance?version=${approvedFact.version}`);assert.equal(proof.status,200);assert.equal(proof.data.source.id,sourceReceipt.sourceId);assert.equal(proof.data.source.content,sourceInput.content);
  const approvedReplay=JSON.parse((await run(proposal)).stdout);assert.equal(approvedReplay.candidateId,receipt.candidateId);assert.equal(approvedReplay.statusAtCreation,'pending');assert.equal(approvedReplay.currentStatusNotRead,true);
  const stale=await run({...proposal,value:'19号',idempotencyKey:randomUUID()});assert.equal(stale.code,0);
  assert.equal((await call(owner,`/api/projects/1/candidates/${JSON.parse(stale.stdout).candidateId}/approve`,{})).status,409);
  assert.equal((await read()).data.facts[0].value,'18号');
  const uncertainSource={...sourceInput,title:'来源响应丢失-'+randomUUID(),idempotencyKey:randomUUID()};let sourceWrites=0;
  await assert.rejects(()=>createSource({baseURL,source:uncertainSource,fetchImpl:async(url,opts)=>{const response=await fetch(url,opts);if(url.pathname.endsWith('/sources')){sourceWrites++;assert.equal(response.status,200);await response.json();throw new Error('source response lost after commit')}return response}}),e=>e.outcome==='unknown');
  assert.equal(sourceWrites,1);const recoveredSource=await run(uncertainSource,'member','scripts/source-client.js');assert.equal(recoveredSource.code,0);
  const recoveredSourceId=JSON.parse(recoveredSource.stdout).sourceId;
  const retained=(await call(viewer,'/api/projects/1/data')).data;
  assert.equal(retained.sources.filter(s=>s.title===uncertainSource.title).length,1);
  assert.equal(retained.audit.filter(a=>a.action==='source'&&a.detail===`新增来源 ${recoveredSourceId}`).length,1);
  // A failed second step never deletes or rewrites the already-created source.
  const failedSecond=await run({...proposal,sourceId:recoveredSourceId,idempotencyKey:randomUUID()},'viewer');assert.equal(failedSecond.code,1);
  assert.ok((await call(viewer,'/api/projects/1/data')).data.sources.some(s=>s.id===recoveredSourceId&&s.content===uncertainSource.content));
  const lost={...proposal,subject:proposal.subject+'-响应丢失',idempotencyKey:randomUUID()};let writes=0;
  await assert.rejects(()=>submitProposal({baseURL,proposal:lost,fetchImpl:async(url,opts)=>{const response=await fetch(url,opts);if(url.pathname.endsWith('/candidates')){writes++;assert.equal(response.status,200);await response.json();throw new Error('lost after commit')}return response}}),e=>e.outcome==='unknown');
  assert.equal(writes,1);const recovered=await run(lost);assert.equal(recovered.code,0);
  const after=(await call(viewer,'/api/projects/1/data')).data;assert.equal(after.candidates.filter(c=>c.subject===lost.subject).length,1);
  assert.equal(after.audit.filter(a=>a.action==='propose'&&a.detail===`候选 ${JSON.parse(recovered.stdout).candidateId}`).length,1);
};
