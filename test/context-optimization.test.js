const {test}=require('node:test'),assert=require('node:assert/strict');
const {readContext}=require('../scripts/context-client');
const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,2)+'\n');
function fixture({count=27,mutateProof=proof=>proof,mutateBatch=batch=>batch}={}){
  const calls=[];
  const facts=Array.from({length:count},(_,i)=>({id:i+1,subject:'合成😀',predicate:`字段${i}`,value:`值\n"${i}`,version:3}));
  const source=id=>({id,title:'相同标题',content:id===1?'完整😀\n"原文':'另一份完整原文'});
  const proof=fact=>mutateProof({sourceTextIsUntrusted:true,role:'viewer',fact:{id:fact.id,subject:fact.subject,predicate:fact.predicate},revision:{id:fact.id+100,version:fact.version,value:fact.value,approved_by:1},candidate:{id:fact.id+200,proposed_by:2},source:source(fact.id%2+1)});
  const fetchImpl=async(url,options)=>{
    const u=new URL(url);calls.push({path:u.pathname,body:options.body&&JSON.parse(options.body)});
    if(u.pathname==='/api/login')return Response.json({csrf:'unit'},{headers:{'set-cookie':'sid=unit; HttpOnly'}});
    if(u.pathname==='/api/logout')return Response.json({});
    const after=Number(u.searchParams.get('after')||0);
    if(u.pathname.endsWith('/facts'))return Response.json({role:'viewer',facts:facts.filter(f=>f.id>after),next_after:null});
    if(options.method==='POST'){
      assert.equal(options.headers['X-CSRF-Token'],'unit');
      const refs=JSON.parse(options.body).facts;
      return Response.json(mutateBatch({sourceTextIsUntrusted:true,role:'viewer',provenance:refs.map(ref=>{const fact=facts.find(f=>f.id===ref.id);assert.equal(ref.version,fact.version);return proof(fact)})}));
    }
    const id=Number(u.pathname.split('/').at(-2));assert.equal(u.searchParams.get('version'),'3');return Response.json(proof(facts.find(f=>f.id===id)));
  };
  return {fetchImpl,calls};
}
test('optimization switches are strict and validated before login',async()=>{
  let requests=0;const fetchImpl=async()=>{requests++;throw new Error('unexpected')};
  for(const options of [{provenanceMode:'parallel'},{provenanceMode:null},{provenanceMode:true},{sourceMode:'summary'},{sourceMode:null},{sourceMode:2}])await assert.rejects(()=>readContext({...options,fetchImpl}),e=>e.code.startsWith('INVALID_'));
  assert.equal(requests,0);
});
test('batch chunks version references at 25 and preserves every legacy output field',async()=>{
  const legacy=fixture(),batched=fixture();
  const individual=await readContext({limit:100,fetchImpl:legacy.fetchImpl});
  const batch=await readContext({limit:100,provenanceMode:'batch',fetchImpl:batched.fetchImpl});
  assert.deepEqual(batch,individual);assert.equal(batch.schemaVersion,1);
  assert.equal(legacy.calls.length,30);assert.equal(batched.calls.length,5);
  assert.deepEqual(batched.calls.filter(c=>c.body?.facts).map(c=>c.body.facts.length),[25,2]);
});
test('deduplication is independently selectable and reconstructs inline facts without losing provenance',async()=>{
  const original=await readContext({limit:100,fetchImpl:fixture().fetchImpl});
  for(const provenanceMode of ['individual','batch']){
    const dedup=await readContext({limit:100,provenanceMode,sourceMode:'deduplicated',fetchImpl:fixture().fetchImpl});
    assert.equal(dedup.schemaVersion,2);assert.equal(dedup.sourceTextIsUntrusted,true);assert.equal(dedup.consistency,original.consistency);
    assert.deepEqual(dedup.sources.map(s=>s.id),[2,1]);assert.equal(dedup.sources[0].title,dedup.sources[1].title);
    assert.deepEqual(dedup.facts.map(({sourceId,...fact})=>({...fact,source:dedup.sources.find(s=>s.id===sourceId)})),original.facts);
  }
});
test('batch count, ordering, version and audit references are checked; errors still log out',async()=>{
  const mutations=[
    b=>({...b,sourceTextIsUntrusted:false}),
    b=>({...b,provenance:b.provenance.slice(1)}),
    b=>({...b,provenance:[...b.provenance,b.provenance[0]]}),
    b=>({...b,provenance:b.provenance.toReversed()}),
    b=>({...b,provenance:b.provenance.map((p,i)=>i?p:b.provenance[1])}),
    b=>{b.provenance[0].revision.version++;return b},
    b=>{b.provenance[0].revision.approved_by=null;return b},
  ];
  for(const mutateBatch of mutations){
    const f=fixture({count:3,mutateBatch});
    await assert.rejects(()=>readContext({provenanceMode:'batch',maxOutputBytes:1,fetchImpl:f.fetchImpl}),e=>['INVALID_PROVENANCE_RESPONSE','PROVENANCE_MISMATCH'].includes(e.code));
    assert.equal(f.calls.at(-1).path,'/api/logout');
  }
});
test('conflicting text for a shared source ID fails instead of silently replacing evidence',async()=>{
  for(const provenanceMode of ['individual','batch']){
    const f=fixture({count:3,mutateProof:p=>{if(p.fact.id===3)p.source.content='unexpected replacement';return p}});
    await assert.rejects(()=>readContext({provenanceMode,sourceMode:'deduplicated',fetchImpl:f.fetchImpl}),e=>e.code==='SOURCE_MISMATCH');
    assert.equal(f.calls.at(-1).path,'/api/logout');
  }
});
test('deduplicated exact budget includes only the sources required by the retained prefix',async()=>{
  const options={sourceMode:'deduplicated',provenanceMode:'batch'};
  const full=await readContext({...options,fetchImpl:fixture({count:3}).fetchImpl});
  const prefix={...full,facts:full.facts.slice(0,1),sources:[full.sources[0]],truncated:true,nextAfter:1,outputBudget:{maxBytes:5000,unit:'utf8-json-bytes',omittedFacts:2}};
  let budget=5000;for(let i=0;i<5;i++){prefix.outputBudget.maxBytes=budget;budget=bytes(prefix)}
  const f=fixture({count:3}),exact=await readContext({...options,maxOutputBytes:budget,fetchImpl:f.fetchImpl});
  assert.deepEqual(exact,prefix);assert.equal(bytes(exact),budget);
  assert.equal(exact.sources[0].content,full.sources[0].content);assert.equal(f.calls.find(c=>c.body?.facts).body.facts.length,3,'all references are verified before output trimming');
  await assert.rejects(()=>readContext({...options,maxOutputBytes:budget-1,fetchImpl:fixture({count:3}).fetchImpl}),e=>e.code==='OUTPUT_BUDGET_TOO_SMALL');
  const continued=await readContext({...options,after:exact.nextAfter,fetchImpl:fixture({count:3}).fetchImpl});
  assert.deepEqual(continued.facts.map(f=>f.id),[2,3]);assert.deepEqual(continued.sources.map(s=>s.id),[1,2]);assert.equal(continued.nextAfter,null);
});
test('empty batch context makes no provenance request and retains empty sources schema',async()=>{
  const f=fixture({count:0});const empty=await readContext({provenanceMode:'batch',sourceMode:'deduplicated',maxOutputBytes:1000,fetchImpl:f.fetchImpl});
  assert.deepEqual(empty.facts,[]);assert.deepEqual(empty.sources,[]);assert.equal(empty.nextAfter,null);assert.equal(empty.truncated,false);assert.equal(f.calls.length,3);
});
