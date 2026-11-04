const assert=require('node:assert/strict');
module.exports=async({call,owner,member,viewer,other})=>{
  const sources=[];
  for(const content of ['同标题来源A：18号。','同标题来源B：19号。']){const r=await call(member,'/api/projects/1/sources',{title:'审核同名来源（合成）',content});assert.equal(r.status,200);sources.push(r.data)}
  const ids=[];
  for(let i=0;i<2;i++){const r=await call(member,'/api/projects/1/candidates',{subject:'审核来源'+i,predicate:'截止日',value:i?'19号':'18号',source_id:sources[i].id,expected_version:0});assert.equal(r.status,200);ids.push(r.data.id)}
  const before=(await call(owner,'/api/projects/1/data')).data;
  for(let i=0;i<2;i++){
    const r=await call(viewer,`/api/projects/1/candidates/${ids[i]}/source`);assert.equal(r.status,200);assert.equal(r.data.role,'viewer');assert.equal(r.data.candidate.id,ids[i]);assert.equal(r.data.candidate.status,'pending');assert.equal(r.data.current,null);assert.deepEqual(r.data.comparison,{expectedVersion:0,currentVersion:0,matches:true});assert.equal(r.data.source.id,sources[i].id);assert.equal(r.data.source.content,sources[i].content);
  }
  assert.deepEqual((await call(owner,'/api/projects/1/data')).data,before,'reading a pending source cannot approve, audit or mutate business data');
  assert.equal((await call(other,`/api/projects/1/candidates/${ids[0]}/source`)).status,403);
  assert.equal((await call(owner,`/api/projects/2/candidates/${ids[0]}/source`)).status,403);
  assert.equal((await call(other,`/api/projects/2/candidates/${ids[0]}/source`)).status,404);
  assert.equal((await call(viewer,'/api/projects/1/candidates/2147483647/source')).status,404);
  assert.equal((await call(viewer,'/api/projects/1/candidates/not-a-number/source')).status,400);
  assert.equal((await call(owner,`/api/projects/1/candidates/${ids[0]}/reject`,{})).status,200);
  const competing=await call(member,'/api/projects/1/candidates',{subject:'审核来源1',predicate:'截止日',value:'21号',source_id:sources[0].id,expected_version:0});assert.equal(competing.status,200);
  assert.equal((await call(owner,`/api/projects/1/candidates/${ids[1]}/approve`,{})).status,200);
  const changed=await call(viewer,`/api/projects/1/candidates/${competing.data.id}/source`);assert.equal(changed.status,200);
  assert.deepEqual(changed.data.comparison,{expectedVersion:0,currentVersion:1,matches:false});assert.equal(changed.data.current.value,'19号');assert.equal(changed.data.current.source_id,sources[1].id);
  assert.equal((await call(owner,`/api/projects/1/candidates/${competing.data.id}/approve`,{})).status,409);
  assert.deepEqual((await call(viewer,`/api/projects/1/candidates/${competing.data.id}/source`)).data,changed.data);
  const rejected=await call(viewer,`/api/projects/1/candidates/${ids[0]}/source`);assert.equal(rejected.data.candidate.status,'rejected');assert.deepEqual(rejected.data.source,{id:sources[0].id,title:sources[0].title,content:sources[0].content});
};
