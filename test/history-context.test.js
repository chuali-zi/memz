const {test}=require('node:test'),assert=require('node:assert/strict');
const {readHistoryContext}=require('../scripts/history-context');
function fixture({mutatePage=()=>{},mutateProof=()=>{},empty=false,more=false}={}){
  const calls=[],history=empty?[]:[2,1].map(version=>({id:version+10,fact_id:4,subject:'中文😀',predicate:'截止日',version,value:`${version}号`,source:'完整依据',created_at:'2026-11-06T00:00:00.000Z'}));
  const page={role:'viewer',history,next_before:more?11:null};mutatePage(page);
  const proofs=history.map(row=>({sourceTextIsUntrusted:true,role:'viewer',fact:{id:4,subject:row.subject,predicate:row.predicate},revision:{id:row.id,version:row.version,value:row.value,created_at:row.created_at,approved_by:1},source:{id:row.version+20,title:row.source,content:`全文${row.version}😀\n"`},candidate:{id:row.version+30,proposed_by:2,expected_version:row.version-1}}));
  proofs.forEach(mutateProof);
  return {calls,fetchImpl:async(url,options)=>{
    const u=new URL(url);calls.push(u);assert.equal(options.redirect,'error');
    if(u.pathname==='/api/login')return Response.json({csrf:'unit'},{headers:{'set-cookie':'sid=unit; HttpOnly'}});
    assert.equal(options.headers.cookie,'sid=unit');
    if(u.pathname==='/api/logout'){assert.equal(options.headers['X-CSRF-Token'],'unit');return Response.json({})}
    if(u.pathname.endsWith('/history'))return Response.json(page);
    assert.equal(options.headers['X-CSRF-Token'],'unit');assert.deepEqual(JSON.parse(options.body).facts,history.map(r=>({id:r.fact_id,version:r.version})));
    return Response.json({sourceTextIsUntrusted:true,role:'viewer',provenance:proofs});
  }};
}
test('history context binds multiple versions of the same fact and preserves full sources and cursor',async()=>{
  const f=fixture({more:true}),result=await readHistoryContext({fetchImpl:f.fetchImpl});
  assert.deepEqual(result.revisions.map(r=>[r.id,r.version,r.revisionId]),[[4,2,12],[4,1,11]]);
  assert.equal(result.sources[1].content,'全文1😀\n"');assert.equal(result.nextBefore,11);assert.equal(result.truncated,true);assert.equal(f.calls.length,4);
  assert.equal(result.before,null);assert.equal(result.limit,25);
  const empty=fixture({empty:true});assert.deepEqual((await readHistoryContext({fetchImpl:empty.fetchImpl})).revisions,[]);assert.equal(empty.calls.length,3);
});
test('history protocol rejects swapped versions, audit/source corruption and malformed paging, then logs out',async()=>{
  const variants=[{mutatePage:p=>{p.history.reverse()}},{mutatePage:p=>{p.next_before=99}},
    ...[p=>{p.revision.version++},p=>{p.revision.id++},p=>{p.source.title='wrong'},p=>{p.sourceTextIsUntrusted=false},p=>{p.candidate.expected_version=99},p=>{p.revision.created_at='2020-01-01'}].map(mutateProof=>({mutateProof}))];
  for(const variant of variants){const f=fixture(variant);await assert.rejects(()=>readHistoryContext({fetchImpl:f.fetchImpl}),{code:'INVALID_HISTORY_RESPONSE'});assert.equal(f.calls.at(-1).pathname,'/api/logout')}
});
test('history rejects bad configuration before login and enforces both byte budgets',async()=>{
  for(const config of [{limit:26},{before:0},{before:'1'},{projectId:0},{baseURL:'https://user:pass@example.org'},{maxOutputBytes:0},{maxResponseBytes:1048577}]){
    await assert.rejects(()=>readHistoryContext({...config,fetchImpl:()=>assert.fail('no network')}),e=>e.code.startsWith('INVALID_'));
  }
  for(const [config,code] of [[{maxOutputBytes:1},'OUTPUT_BUDGET_TOO_SMALL'],[{maxResponseBytes:200},'RESPONSE_TOO_LARGE']]){
    const f=fixture();await assert.rejects(()=>readHistoryContext({...config,fetchImpl:f.fetchImpl}),{code});assert.equal(f.calls.at(-1).pathname,'/api/logout');
  }
});
test('history reports bounded timeout and authorization failures without raw errors or fallback',async()=>{
  const f=fixture();await assert.rejects(()=>readHistoryContext({fetchImpl:async(url,o)=>new URL(url).pathname.endsWith('/history')?Response.json({error:'private'},{status:403}):f.fetchImpl(url,o)}),{code:'HTTP_403'});
  await assert.rejects(()=>readHistoryContext({fetchImpl:()=>{throw new Error('secret-placeholder')}}),e=>e.code==='REQUEST_FAILED'&&!e.message.includes('secret'));
  const slow=fixture();await assert.rejects(()=>readHistoryContext({totalTimeoutMs:1,fetchImpl:async(...args)=>{await new Promise(r=>setTimeout(r,10));return slow.fetchImpl(...args)}}),{code:'TOTAL_TIMEOUT'});
  assert.equal(slow.calls.at(-1).pathname,'/api/logout');
});
