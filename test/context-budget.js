const assert=require('node:assert/strict');
const {readContext}=require('../scripts/context-client');
module.exports=async function contextBudget({baseURL,call,owner,member}){
  const content='界😀\n"'.repeat(800),subject='上下文字节预算合成';assert.equal(content.length,4000);
  const source=await call(member,'/api/projects/1/sources',{title:'重复大来源（合成）',content});assert.equal(source.status,200);
  for(let i=0;i<3;i++){
    const candidate=await call(member,'/api/projects/1/candidates',{subject,predicate:`字段${i}`,value:`值😀${i}`,source_id:source.data.id,expected_version:0});assert.equal(candidate.status,200);
    assert.equal((await call(owner,`/api/projects/1/candidates/${candidate.data.id}/approve`,{})).status,200);
  }
  const plain=await readContext({baseURL,query:subject});assert.equal(plain.facts.length,3);assert.equal(plain.outputBudget,undefined);
  const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,2)+'\n');assert.ok(bytes(plain)>24000,'individual HTTP limits do not cap combined context at 12 KB');
  const bounded=await readContext({baseURL,query:subject,maxOutputBytes:12000});assert.ok(bytes(bounded)<=12000,'final serialized context must fit the requested byte budget');
  assert.equal(bounded.facts.length,1);assert.deepEqual(bounded.facts,plain.facts.slice(0,1));assert.equal(bounded.facts[0].source.content,content);
  assert.equal(bounded.truncated,true);assert.equal(bounded.nextAfter,bounded.facts[0].id);assert.equal(bounded.outputBudget.omittedFacts,2);
  const {stdout}=await require('node:util').promisify(require('node:child_process').execFile)(process.execPath,['scripts/context-client.js'],{env:{...process.env,MEMZ_BASE_URL:baseURL,MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',MEMZ_QUERY:subject,MEMZ_MAX_OUTPUT_BYTES:'12000'},timeout:10000});
  assert.ok(Buffer.byteLength(stdout)<=12000);assert.deepEqual(JSON.parse(stdout),bounded);
  const continuation=await call(owner,`/api/projects/1/facts?q=${encodeURIComponent(subject)}&after=${bounded.nextAfter}`);assert.equal(continuation.status,200);assert.deepEqual(continuation.data.facts.map(f=>f.id),plain.facts.slice(1).map(f=>f.id));
  await assert.rejects(()=>readContext({baseURL,query:subject,maxOutputBytes:1000}),e=>e.code==='OUTPUT_BUDGET_TOO_SMALL');
  const pageBound=await readContext({baseURL,query:subject,limit:1,maxOutputBytes:12000});assert.equal(pageBound.truncated,true);assert.equal(pageBound.outputBudget.omittedFacts,0);assert.equal(pageBound.nextAfter,plain.facts[0].id);
  const empty=await readContext({baseURL,query:'预算无匹配合成',maxOutputBytes:1000});assert.deepEqual(empty.facts,[]);assert.equal(empty.truncated,false);assert.equal(empty.nextAfter,null);assert.ok(bytes(empty)<=1000);
  await assert.rejects(()=>readContext({baseURL,query:subject,maxOutputBytes:12000,fetchImpl:async(url,options)=>{
    if(new URL(url).pathname===`/api/projects/1/facts/${plain.facts[2].id}/provenance`)return Response.json({error:'synthetic failure'},{status:503});
    return fetch(url,options);
  }}),e=>e.status===503,'budget omission must not turn failed provenance verification into success');

  await assert.rejects(()=>readContext({baseURL,username:'other',password:'demo-other',query:subject,maxOutputBytes:12000}),e=>e.status===403);
};
