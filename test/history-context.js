const assert=require('node:assert/strict');
const {readHistoryContext}=require('../scripts/history-context');
module.exports=async function historyContext({baseURL,call,owner,member}){
  async function create(auth,path,body){const r=await call(auth,path,body);assert.equal(r.status,200);return r.data}
  const subject='历史上下文真实回归';
  const source=await create(member,'/api/projects/1/sources',{title:'历史证据😀',content:'初版20号；更正15号。完整不可截断😀'});
  async function approve(value,expected_version){const c=await create(member,'/api/projects/1/candidates',{subject,predicate:'截止日',value,expected_version,source_id:source.id});await create(owner,`/api/projects/1/candidates/${c.id}/approve`,{});return c}
  await approve('20号',0);await approve('15号',1);
  let changed=false;
  const first=await readHistoryContext({baseURL,limit:1,fetchImpl:async(url,options)=>{
    const response=await fetch(url,options);
    if(new URL(url).pathname.endsWith('/history')){await approve('12号',2);changed=true}
    return response;
  }});
  assert.ok(changed);assert.equal(first.revisions[0].value,'15号');assert.equal(first.revisions[0].version,2);
  assert.equal(first.sources[0].content,source.content);assert.equal(first.truncated,true);
  const older=await readHistoryContext({baseURL,limit:1,before:first.nextBefore});assert.equal(older.revisions[0].version,1);assert.equal(older.revisions[0].value,'20号');
  const latest=await readHistoryContext({baseURL,limit:1});assert.equal(latest.revisions[0].version,3);assert.equal(latest.revisions[0].value,'12号');
  const size=Buffer.byteLength(JSON.stringify(latest)+'\n');
  assert.deepEqual(await readHistoryContext({baseURL,limit:1,maxOutputBytes:size}),latest);
  await assert.rejects(()=>readHistoryContext({baseURL,limit:1,maxOutputBytes:size-1}),{code:'OUTPUT_BUDGET_TOO_SMALL'});
  await assert.rejects(()=>readHistoryContext({baseURL,username:'other',password:'demo-other',projectId:1}),{code:'HTTP_403'});
  await assert.rejects(()=>readHistoryContext({baseURL,username:'viewer',password:'demo-viewer',projectId:2}),{code:'HTTP_403'});
};
