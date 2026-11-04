const assert=require('node:assert/strict');
const {readContext}=require('../scripts/context-client');
// Invoked after the seed-sensitive integration assertions, also on upgraded databases.
module.exports=async function contextScenarios({baseURL,call,owner,member,viewer,other}){
  const subject='多版本上下文合成案例',predicate='已批准状态';
  const create=async(auth,path,body)=>{const response=await call(auth,path,body);assert.equal(response.status,200);return response.data};
  const source=await create(member,'/api/projects/1/sources',{title:'同名依据（合成）',content:'原始文本声称早期状态；批准记录与来源文本不等于客观真实性。'});
  const foreignSource=await create(other,'/api/projects/2/sources',{title:'同名依据（合成）',content:'另一个项目的独立依据。'});
  const propose=(auth,project,sourceId,value,version)=>create(auth,`/api/projects/${project}/candidates`,{subject,predicate,source_id:sourceId,value,expected_version:version});
  const approve=(auth,project,id)=>create(auth,`/api/projects/${project}/candidates/${id}/approve`,{});
  const foreign=await propose(other,2,foreignSource.id,'另项目专有状态',0);await approve(other,2,foreign.id);
  let firstProof,factId;
  for(let version=1;version<=105;version++){
    const proposal=await propose(member,1,source.id,`批准状态第${version}版`,version-1);await approve(owner,1,proposal.id);
    if(version===1){const first=await readContext({baseURL,query:subject});factId=first.facts[0].id;firstProof=(await call(viewer,`/api/projects/1/facts/${factId}/provenance?version=1`)).data}
  }
  const stale=await propose(member,1,source.id,'过期冲突专有状态',104);
  const beforeConflict=(await call(owner,'/api/projects/1/data')).data;
  assert.equal((await call(owner,`/api/projects/1/candidates/${stale.id}/approve`,{})).status,409);
  assert.deepEqual((await call(owner,'/api/projects/1/data')).data,beforeConflict,'conflict changes neither current/history/candidates nor recent audit');
  const pending=await propose(member,1,source.id,'尚未批准专有状态',105);
  const rejected=await propose(member,1,source.id,'已驳回专有状态',105);await create(owner,`/api/projects/1/candidates/${rejected.id}/reject`,{});
  const current=await readContext({baseURL,query:subject});assert.equal(current.facts.length,1);
  assert.equal(current.projectId,1);assert.equal(current.facts[0].version,105);assert.equal(current.facts[0].value,'批准状态第105版');assert.equal(current.facts[0].source.id,source.id);
  assert.equal(current.facts[0].source.content,source.content,'source text is preserved, not rewritten to agree with the approved value');
  assert.equal(current.sourceTextIsUntrusted,true);
  for(const query of ['批准状态第1版','过期冲突专有状态','尚未批准专有状态','已驳回专有状态','另项目专有状态'])assert.deepEqual((await readContext({baseURL,query})).facts,[],query);
  const own=await readContext({baseURL,username:'other',password:'demo-other',projectId:2,query:subject});assert.equal(own.facts.length,1);assert.equal(own.facts[0].value,'另项目专有状态');assert.equal(own.facts[0].source.id,foreignSource.id);
  await assert.rejects(()=>readContext({baseURL,projectId:2,query:subject}),e=>e.status===403);
  assert.equal((await call(other,`/api/projects/2/facts/${factId}/provenance?version=1`)).status,404);
  assert.deepEqual((await call(viewer,`/api/projects/1/facts/${factId}/provenance?version=1`)).data,firstProof);
  assert.equal((await call(viewer,`/api/projects/1/facts/${factId}/provenance?version=106`)).status,404);
  const history=[];let before=null,pages=0;
  do{const response=await call(viewer,`/api/projects/1/history?limit=25${before===null?'':`&before=${before}`}`);assert.equal(response.status,200);assert.ok(response.data.history.length<=25);history.push(...response.data.history);before=response.data.next_before;assert.ok(++pages<30,'cursor must terminate')}while(before!==null);
  assert.equal(new Set(history.map(row=>row.id)).size,history.length);
  assert.deepEqual(history.filter(row=>row.subject===subject).map(row=>row.version),Array.from({length:105},(_,i)=>105-i));
  assert.ok(history.every(row=>row.value!=='另项目专有状态'));
  const state=(await call(owner,'/api/projects/1/data?include_facts=false&include_history=false&include_sources=false')).data;
  assert.equal(state.candidates.find(row=>row.id===stale.id).status,'pending');assert.equal(state.candidates.find(row=>row.id===pending.id).status,'pending');
};
