const {test}=require('node:test'),assert=require('node:assert/strict');
const {readContext}=require('../scripts/context-client');
const {snapshotReceipt,SNAPSHOT_DESCRIPTION,SNAPSHOT_MAX_BYTES}=require('../scripts/context-snapshot');
const {parseSearchQuery}=require('../scripts/search-query');
const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,2)+'\n');
function wire({count=3,query='',limit=25,after=0,searchMode='substring',unique=false,maximal=false}={}){
  const facts=Array.from({length:count},(_,i)=>({id:after+i+1,subject:maximal?'\u0001'.repeat(100):'中文项目😀',predicate:maximal?'\u0001'.repeat(100):`字段${i}`,version:1,value:maximal?'\u0001'.repeat(1000):`值\n"😀${i}`,revisionId:i+100,sourceId:unique?i+10:i%2+10}));
  const sourceIds=[...new Set(facts.map(f=>f.sourceId))];
  const sources=sourceIds.map(id=>({id,title:maximal?'\u0001'.repeat(150):'同名合成来源',content:maximal?'\u0001'.repeat(4000):`完整原文${id}😀\n"`}));
  const provenance=facts.map(f=>({sourceTextIsUntrusted:true,role:'viewer',fact:{id:f.id,subject:f.subject,predicate:f.predicate},revision:{id:f.revisionId,version:f.version,value:f.value,created_at:'2026-11-06T00:00:00.000Z',approved_by:1},sourceId:f.sourceId,candidate:{id:f.id+200,expected_version:0,proposed_by:2}}));
  const search=parseSearchQuery(query,searchMode);
  return {...snapshotReceipt(),projectId:1,query,limit,after,role:'viewer',sourceTextIsUntrusted:true,facts,provenance,sources,next_after:null,...(search?{search}:{})};
}
function transport(page,{status=200}={}){
  const calls=[];
  return {calls,fetchImpl:async(url,options)=>{
    const u=new URL(url);calls.push(u);assert.equal(options.redirect,'error');
    if(u.pathname==='/api/login')return Response.json({csrf:'unit'},{headers:{'set-cookie':'sid=unit; HttpOnly'}});
    assert.equal(options.headers.cookie,'sid=unit');
    if(u.pathname==='/api/logout')return Response.json({});
    if(u.pathname.endsWith('/context'))return Response.json(page,{status});
    if(u.pathname.endsWith('/facts'))return Response.json({role:page.role,facts:page.facts.map(({revisionId,sourceId,...fact})=>({...fact,source:page.sources.find(s=>s.id===sourceId).title})),next_after:page.next_after,...(page.search?{search:page.search}:{})});
    const proof=(p)=>{const {sourceId,...rest}=p;return {...rest,source:page.sources.find(s=>s.id===sourceId)}};
    if(options.method==='POST')return Response.json({sourceTextIsUntrusted:true,role:page.role,provenance:page.provenance.map(proof)});
    return Response.json(proof(page.provenance.find(p=>p.fact.id===Number(u.pathname.split('/').at(-2)))));
  }};
}
test('snapshot reads one context response and preserves all fact/provenance fields in both source layouts',async()=>{
  for(const sourceMode of ['inline','deduplicated']){
    const page=wire(),original=await readContext({sourceMode,fetchImpl:transport(page).fetchImpl});
    const f=transport(page),result=await readContext({provenanceMode:'snapshot',sourceMode,fetchImpl:f.fetchImpl});
    const {snapshot,consistency,...withoutReceipt}=result;const {consistency:oldConsistency,...legacy}=original;
    assert.deepEqual(withoutReceipt,legacy);assert.deepEqual(snapshot,snapshotReceipt());assert.equal(consistency,SNAPSHOT_DESCRIPTION);assert.notEqual(consistency,oldConsistency);
    assert.deepEqual(f.calls.map(u=>u.pathname),['/api/login','/api/projects/1/context','/api/logout']);
    assert.equal(result.sourceTextIsUntrusted,true);
  }
});
test('snapshot limits are explicit and never silently split a page',async()=>{
  for(const limit of [26,100,101,2147483647]){
    const f=transport(wire());await assert.rejects(()=>readContext({provenanceMode:'snapshot',limit,fetchImpl:f.fetchImpl}),{code:'INVALID_SNAPSHOT_LIMIT'});assert.equal(f.calls.length,0);
  }
  const f=transport(wire({count:25}));const result=await readContext({provenanceMode:'snapshot',fetchImpl:f.fetchImpl});assert.equal(result.facts.length,25);assert.equal(f.calls.length,3);
});
test('maximally escaped valid fields with 25 distinct full sources fit the default wire byte cap',async()=>{
  const page=wire({count:25,unique:true,maximal:true}),wireBytes=Buffer.byteLength(JSON.stringify(page));
  assert.ok(wireBytes<SNAPSHOT_MAX_BYTES,`wire=${wireBytes}`);assert.ok(wireBytes>950000,'exercise the upper range, not a small fixture');
  const result=await readContext({provenanceMode:'snapshot',sourceMode:'deduplicated',fetchImpl:transport(page).fetchImpl});
  assert.equal(result.facts.length,25);assert.equal(result.sources.length,25);assert.equal(result.sources[24].content,'\u0001'.repeat(4000));
});
test('snapshot rejects incomplete, redundant, misbound or unrecognized receipts before output omission',async()=>{
  const mutations=[
    p=>{delete p.schema},p=>{p.schema='future-v2'},p=>{p.consistency='best-effort'},p=>{p.projectId=2},p=>{p.query='other'},p=>{p.limit=24},p=>{p.after=1},p=>{p.role='admin'},p=>{p.sourceTextIsUntrusted=false},p=>{p.search={}},
    p=>{p.facts=null},p=>{p.facts[0]=null},p=>{p.facts.reverse()},p=>{p.facts[1].id=p.facts[0].id},p=>{p.facts[0].sourceId=11},p=>{p.facts[0].revisionId=999},p=>{p.next_after=p.facts[0].id},p=>{p.next_after=p.facts.at(-1).id},
    p=>{delete p.provenance},p=>{p.provenance.pop()},p=>{p.provenance.push(p.provenance[0])},p=>{p.provenance.reverse()},p=>{p.provenance[0]=null},p=>{p.provenance[0].source={}},p=>{p.provenance[0].sourceId=11},p=>{p.provenance[0].role='owner'},p=>{p.provenance[0].sourceTextIsUntrusted=false},
    p=>{p.provenance[0].fact.subject='错主体'},p=>{p.provenance[0].revision.version=2},p=>{p.provenance[0].revision.value='错值'},p=>{p.provenance[0].revision.approved_by=0},p=>{p.provenance[0].revision.created_at='invalid'},p=>{p.provenance[0].candidate.expected_version=1},p=>{p.provenance[1].candidate.id=p.provenance[0].candidate.id},
    p=>{p.sources.pop()},p=>{p.sources.push(p.sources[0])},p=>{p.sources.push({id:999,title:'未引用',content:'不应传出'})},p=>{p.sources.reverse()},p=>{p.sources[0]=null},p=>{p.sources[0].content='\ud800'},p=>{p.sources[0].content='x'.repeat(4001)},p=>{p.sources[0].projectId=2},
  ];
  for(const mutate of mutations){const page=wire();mutate(page);const f=transport(page);await assert.rejects(()=>readContext({provenanceMode:'snapshot',maxOutputBytes:1,fetchImpl:f.fetchImpl}),{code:'INVALID_SNAPSHOT_RESPONSE'},String(mutate));assert.equal(f.calls.length,3);assert.equal(f.calls.at(-1).pathname,'/api/logout')}
});
test('snapshot validates its all_terms receipt and request cursor without falling back',async()=>{
  const options={provenanceMode:'snapshot',query:'字段 项目',searchMode:'all_terms',after:9,limit:3};
  const page=wire({...options,count:3}),f=transport(page),result=await readContext({...options,fetchImpl:f.fetchImpl});assert.deepEqual(result.search,page.search);assert.equal(result.after,9);assert.equal(f.calls[1].searchParams.get('match'),'all_terms');assert.equal(f.calls[1].searchParams.get('after'),'9');
  for(const mutate of [p=>{delete p.search},p=>{p.search.order='ranked'},p=>{p.search.terms.reverse()},p=>{p.facts[0].id=9},p=>{p.next_after=11}]){
    const malformed=structuredClone(page);mutate(malformed);await assert.rejects(()=>readContext({...options,fetchImpl:transport(malformed).fetchImpl}),{code:'INVALID_SNAPSHOT_RESPONSE'});
  }
  const old=transport({role:'viewer',facts:[],next_after:null});await assert.rejects(()=>readContext({provenanceMode:'snapshot',fetchImpl:old.fetchImpl}),{code:'INVALID_SNAPSHOT_RESPONSE'});assert.equal(old.calls.length,3);
});
test('snapshot HTTP failures, response limits and logout failures produce no success or alternate reads',async()=>{
  for(const status of [403,404,500,503]){const f=transport({error:'synthetic'},{status});await assert.rejects(()=>readContext({provenanceMode:'snapshot',fetchImpl:f.fetchImpl}),{code:`HTTP_${status}`});assert.equal(f.calls.length,3)}
  const huge=transport({...wire(),padding:'x'.repeat(SNAPSHOT_MAX_BYTES)});await assert.rejects(()=>readContext({provenanceMode:'snapshot',fetchImpl:huge.fetchImpl}),{code:'RESPONSE_TOO_LARGE'});assert.equal(huge.calls.at(-1).pathname,'/api/logout');
  const f=transport(wire());await assert.rejects(()=>readContext({provenanceMode:'snapshot',fetchImpl:(url,options)=>new URL(url).pathname==='/api/logout'?Response.json({error:'outage'},{status:503}):f.fetchImpl(url,options)}),{code:'HTTP_503'});
});
test('snapshot budget includes receipt and consistency while retaining whole prefix sources',async()=>{
  for(const sourceMode of ['inline','deduplicated']){
    const page=wire(),options={provenanceMode:'snapshot',sourceMode};page.sources[0].content+='边界'.repeat(20);
    const full=await readContext({...options,fetchImpl:transport(page).fetchImpl});
    const prefix={...full,facts:full.facts.slice(0,1),...(sourceMode==='deduplicated'?{sources:[full.sources[0]]}:{}),truncated:true,nextAfter:1,outputBudget:{maxBytes:5000,unit:'utf8-json-bytes',omittedFacts:2}};
    let budget=5000;for(let i=0;i<5;i++){prefix.outputBudget.maxBytes=budget;budget=bytes(prefix)}
    assert.equal(String(budget).length,String(budget-1).length,'one-byte boundary must not also shorten the budget metadata');
    const exact=await readContext({...options,maxOutputBytes:budget,fetchImpl:transport(page).fetchImpl});assert.deepEqual(exact,prefix);assert.equal(bytes(exact),budget);
    await assert.rejects(()=>readContext({...options,maxOutputBytes:budget-1,fetchImpl:transport(page).fetchImpl}),{code:'OUTPUT_BUDGET_TOO_SMALL'});
    const bad=structuredClone(page);bad.provenance[2].candidate.proposed_by=0;
    await assert.rejects(()=>readContext({...options,maxOutputBytes:budget,fetchImpl:transport(bad).fetchImpl}),{code:'INVALID_SNAPSHOT_RESPONSE'},'even an omitted proof is validated');
  }
});
test('empty snapshot returns empty dictionaries and preserves continuation semantics',async()=>{
  const f=transport(wire({count:0,after:99}));const result=await readContext({provenanceMode:'snapshot',sourceMode:'deduplicated',after:99,maxOutputBytes:2000,fetchImpl:f.fetchImpl});
  assert.deepEqual(result.facts,[]);assert.deepEqual(result.sources,[]);assert.equal(result.nextAfter,null);assert.equal(result.truncated,false);assert.equal(result.after,99);assert.equal(f.calls.length,3);
});
