// Pure contract tests with synthetic artifacts; no HTTP service or model.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const a=require('../benchmarks/memory/scripts/memz_adapter');
const history=()=>({scope:'synthetic-a',documents:[{id:'D1',session_id:'S1',date:null,text:'Synthetic source text.'}]});
function fixture(){
  const prepared=a.prepareHistory(history());
  const sources=[{documentId:'D1',sourceId:1,sourceSha256:a.hash({id:1,title:'memz history D1',content:'Synthetic source text.'})}];
  const ingested=a.seal({kind:'memz-ingested-v1',prepared,binding:{baseURL:'http://127.0.0.1:3000',projectId:1},sources});
  return a.seal({kind:'memz-frozen-v1',ingested,readerPrincipal:'viewer',snapshot:{facts:[],sources:[]}});
}
const reader={username:'viewer',password:'demo-viewer'};
test('history preparation rejects gold/question/evidence at every schema boundary',()=>{
  for(const key of ['qa','query','questions','gold','answer','evidence','evidence_ids','category']){
    assert.throws(()=>a.prepareHistory({...history(),[key]:'GOLD_SENTINEL'}));
    const h=history();h.documents[0][key]='GOLD_SENTINEL';assert.throws(()=>a.prepareHistory(h));
  }
});
test('prepared histories are deterministic deep copies with no approval',()=>{
  const h=history(),one=a.prepareHistory(h);h.documents[0].text='changed';
  assert.equal(one.sha256,a.prepareHistory(history()).sha256);assert.equal(one.documents[0].text,'Synthetic source text.');
  assert.ok(Object.isFrozen(one.documents[0]));assert.equal(one.facts,undefined);assert.equal(one.candidates,undefined);
});
test('preparation bounds histories and preserves original text without lossy splitting',()=>{
  for(const mutate of [h=>h.documents.push(h.documents[0]),h=>h.documents[0].text='x'.repeat(4001),
    h=>h.documents[0].text='\ud800',h=>h.documents[0].text='x\0y',h=>h.documents=Array(101).fill(h.documents[0])]){
    const h=history();mutate(h);assert.throws(()=>a.prepareHistory(h));
  }
  const h=history();h.documents[0].text=' 原文😀\n';assert.equal(a.prepareHistory(h).documents[0].text,h.documents[0].text);
});
test('ingestion rejects contaminated or tampered inputs before writes',async()=>{
  let requests=0;const writer={fetchImpl:async()=>{requests++;throw Error('must not reach network')}};
  await assert.rejects(()=>a.ingestHistory({...a.prepareHistory(history()),gold:'GOLD_SENTINEL'},{baseURL:'http://127.0.0.1',projectId:1},writer));
  await assert.rejects(()=>a.ingestHistory(a.prepareHistory(history()),{baseURL:'https://elsewhere.invalid',projectId:1},writer));
  assert.equal(requests,0);
});
test('query violations and artifact tampering are retained as safe error rows',async()=>{
  let requests=0;const fetchImpl=async()=>{requests++;throw Error('SECRET')} ;
  for(const query of [{id:'q1',scope:'wrong',question:'color'},{id:'q2',scope:'synthetic-a',question:'x'.repeat(201)},
    {id:'q3',scope:'synthetic-a',question:'color',gold:'GOLD_SENTINEL'}]){
    const row=await a.queryFrozen(fixture(),query,reader,{fetchImpl});
    assert.equal(row.status,'error');assert.equal(row.context,null);assert.equal(row.answerQuality,null);
    assert.equal(row.error.code,'INVALID_QUERY_FIELDS');assert.ok(!JSON.stringify(row).includes('GOLD_SENTINEL'));
  }
  const tampered={...fixture(),sha256:'bad'};const row=await a.queryFrozen(tampered,{id:'q',scope:'synthetic-a',question:'color'},reader,{fetchImpl});
  assert.equal(row.error.code,'ARTIFACT_HASH_MISMATCH');assert.equal(requests,0);
});
test('programmatic query boundaries reject unknown and accessor fields without reading them',async()=>{
  for(const key of ['gold','answer','evidence_ids','id','question']){
    let reads=0,requests=0;
    const query={id:'q-sentinel',scope:'synthetic-a',question:'color'};
    Object.defineProperty(query,key,{enumerable:true,get(){reads++;return 'GOLD_SENTINEL'}});
    const row=await a.queryFrozen(fixture(),query,reader,{fetchImpl:async()=>{requests++}});
    assert.equal(reads,0,key);assert.equal(requests,0,key);
    assert.equal(row.status,'error');assert.equal(row.error.code,'INVALID_QUERY_FIELDS');
    assert.equal(row.context,null);assert.ok(!JSON.stringify(row).includes('GOLD_SENTINEL'));
  }
  const query={id:'q-hidden',scope:'synthetic-a',question:'color'};
  Object.defineProperty(query,'gold',{value:'GOLD_SENTINEL'});
  const row=await a.queryFrozen(fixture(),query,reader,{fetchImpl:async()=>assert.fail('no network')});
  assert.equal(row.error.code,'INVALID_QUERY_FIELDS');assert.equal(row.context,null);
});
test('reader binding prevents accidentally reusing frozen data for another user',async()=>{
  let requests=0;const row=await a.queryFrozen(fixture(),{id:'q',scope:'synthetic-a',question:'color'},
    {username:'other',password:'demo-other'},{method:'flat_same_facts',fetchImpl:async()=>{requests++}});
  assert.equal(row.error.code,'READER_BINDING_MISMATCH');assert.equal(row.context,null);assert.equal(requests,0);
});
test('CLI prepare reads only the supplied history and writes a private exclusive artifact',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memz-prepare-'));
  try{
    fs.writeFileSync(path.join(dir,'history.json'),JSON.stringify(history()));
    fs.writeFileSync(path.join(dir,'gold.private.json'),'GOLD_SENTINEL');
    const output=path.join(dir,'prepared.json'),opened=[],open=fs.openSync;
    fs.openSync=(p,...args)=>{opened.push(String(p));return open(p,...args)};
    try{assert.equal(await a.main(['prepare',path.join(dir,'history.json'),output]),0)}finally{fs.openSync=open}
    assert.ok(!opened.some(p=>p.includes('gold.private')));
    assert.equal(fs.statSync(output).mode&0o777,0o600);assert.ok(!fs.readFileSync(output,'utf8').includes('GOLD_SENTINEL'));
    await assert.rejects(()=>a.main(['prepare',path.join(dir,'history.json'),output]),{code:'OUTPUT_EXISTS'});
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('query CLI retains invalid scope/overlong rows for both paired methods',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memz-query-'));
  try{
    const input=path.join(dir,'queries.json'),output=path.join(dir,'rows.json');
    fs.writeFileSync(input,JSON.stringify({frozen:fixture(),queries:[{id:'q1',scope:'wrong',question:'color'},
      {id:'q2',scope:'synthetic-a',question:'x'.repeat(201)},null]}));
    assert.equal(await a.main(['query',input,output]),1);const rows=JSON.parse(fs.readFileSync(output));
    assert.equal(rows.length,6);assert.ok(rows.every(r=>r.error.code==='INVALID_QUERY_FIELDS'&&r.context===null));
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

const mutable=value=>JSON.parse(JSON.stringify(value));
function populatedFixture(){
  const frozen=mutable(fixture()),source={id:1,title:'memz history D1',content:'Synthetic source text.'};
  frozen.snapshot={facts:[{id:1,subject:'synthetic',predicate:'color',value:'blue',version:1,revisionId:11,source,candidateId:21,proposedBy:2,approvedBy:1}],sources:[source]};
  delete frozen.sha256;return a.seal(frozen);
}
async function rejectBoundary(phase,input){
  let requests=0,value,error;
  const fetchImpl=async()=>{requests++;throw new Error('BLOCKED_SYNTHETIC_FETCH')};
  try{
    if(phase==='prepare')value=a.prepareHistory(input);
    else if(phase==='ingest')value=await a.ingestHistory(input,{baseURL:'http://127.0.0.1:3000',projectId:1},{fetchImpl});
    else if(phase==='freeze')value=await a.freezeApproved(input,reader,{fetchImpl});
    else value=await a.queryFrozen(input,{id:'q-sentinel',scope:'synthetic-a',question:'color'},reader,{fetchImpl});
  }catch(e){error=e}
  assert.ok(error||value?.status==='error','invalid data must not become an accepted artifact');
  assert.equal(requests,0,'invalid data must be rejected before any HTTP, including source writes');
  assert.ok(!JSON.stringify(value||{code:error.code}).includes('SYNTHETIC_ACCESSOR_SENTINEL'));
  if(phase==='query'){assert.equal(value.id,'q-sentinel');assert.equal(value.context,null);assert.equal(value.modelCalls,0)}
}
const stageInput=phase=>phase==='prepare'?history():mutable(phase==='ingest'?fixture().ingested.prepared:phase==='freeze'?fixture().ingested:populatedFixture());
const documentsFor=(phase,input)=>phase==='prepare'?input.documents:phase==='ingest'?input.documents:phase==='freeze'?input.prepared.documents:input.ingested.prepared.documents;
test('prepared document indices must be enumerable before any hashing or HTTP',async t=>{
  const prepared=stageInput('ingest');Object.defineProperty(prepared.documents,'0',{enumerable:false});let hashes=0,requests=0;
  t.mock.method(require('node:crypto'),'createHash',()=>{hashes++;throw new Error('SYNTHETIC_HASH_MUST_NOT_RUN')});
  await assert.rejects(()=>a.ingestHistory(prepared,{baseURL:'http://127.0.0.1:3000',projectId:1},{fetchImpl:async()=>{requests++;throw new Error('SYNTHETIC_HTTP_MUST_NOT_RUN')}}),{code:'INVALID_HISTORY_DOCUMENT'});
  assert.equal(hashes,0);assert.equal(requests,0);
});
for(const phase of ['prepare','ingest','freeze','query'])test(`${phase} rejects label getters, hidden fields and symbols before reads or HTTP`,async()=>{
  for(const location of ['root','document'])for(const kind of ['getter','hidden','hidden-data','symbol','toJSON']){
    const input=stageInput(phase),target=location==='root'?input:documentsFor(phase,input)[0];let reads=0;
    const key=kind==='symbol'?Symbol('evidence'):kind==='toJSON'?'toJSON':location==='root'?'gold':'answer';
    Object.defineProperty(target,key,kind==='hidden-data'?{value:'SYNTHETIC_ACCESSOR_SENTINEL'}:{enumerable:kind!=='hidden',get(){reads++;return kind==='toJSON'?()=>{reads++;return {}}:'SYNTHETIC_ACCESSOR_SENTINEL'}});
    await rejectBoundary(phase,input);assert.equal(reads,0,`${location}/${kind}`);
  }
});
for(const phase of ['prepare','ingest','freeze','query'])test(`${phase} rejects allowed-field and array accessors without invoking them`,async()=>{
  for(const kind of ['text','index','array-extra','array-toJSON','array-toJSON-value']){
    const input=stageInput(phase),docs=documentsFor(phase,input),document=docs[0];let reads=0;
    if(kind==='text')Object.defineProperty(document,'text',{enumerable:true,get(){reads++;return 'SYNTHETIC_ACCESSOR_SENTINEL'}});
    else if(kind==='index')Object.defineProperty(docs,'0',{enumerable:true,get(){reads++;return document}});
    else if(kind==='array-toJSON-value')docs.toJSON=()=>{reads++;return []};
    else Object.defineProperty(docs,kind==='array-extra'?'evidence':'toJSON',{get(){reads++;return 'SYNTHETIC_ACCESSOR_SENTINEL'}});
    await rejectBoundary(phase,input);assert.equal(reads,0,kind);
  }
});
test('source maps, binding, frozen evidence and array metadata cannot hide rejected labels',async()=>{
  for(const phase of ['freeze','query'])for(const location of ['source-map','source-map-array','binding','fact','fact-array','source','source-array']){
    if(phase==='freeze'&&['fact','fact-array','source','source-array'].includes(location))continue;
    const input=stageInput(phase),ingested=phase==='freeze'?input:input.ingested;
    const target={'source-map':ingested.sources[0],'source-map-array':ingested.sources,binding:ingested.binding,fact:input.snapshot?.facts[0],'fact-array':input.snapshot?.facts,source:input.snapshot?.sources[0],'source-array':input.snapshot?.sources}[location];
    let reads=0;Object.defineProperty(target,'evidence',{get(){reads++;return 'SYNTHETIC_ACCESSOR_SENTINEL'}});
    await rejectBoundary(phase,input);assert.equal(reads,0,location);
  }
});
test('data-valued coercion objects and actual cycles fail without toString or toJSON calls',async()=>{
  let reads=0;
  const poisoned={toString(){reads++;return 'http://127.0.0.1:3000'},toJSON(){reads++;return 'SYNTHETIC_ACCESSOR_SENTINEL'}};
  await assert.rejects(()=>a.ingestHistory(fixture().ingested.prepared,{baseURL:poisoned,projectId:1},{fetchImpl:()=>assert.fail('no HTTP')}),{code:'INVALID_BINDING'});
  for(const phase of ['prepare','ingest','freeze','query']){
    const input=stageInput(phase);documentsFor(phase,input)[0].text=poisoned;await rejectBoundary(phase,input);
    const cyclic=stageInput(phase);documentsFor(phase,cyclic)[0].text=cyclic;await rejectBoundary(phase,cyclic);
    const ownToJSON=stageInput(phase);ownToJSON.toJSON=()=>{reads++;return {gold:'SYNTHETIC_ACCESSOR_SENTINEL'}};await rejectBoundary(phase,ownToJSON);
  }
  assert.equal(reads,0);
});

// Synthetic product transport for offline byte/hash and HTTP-sequence contracts.
function syntheticProduct(){
  const {snapshotReceipt}=require('../scripts/context-snapshot');
  const sources=[],calls=[];
  return {sources,calls,fetchImpl:async(url,options)=>{
    const u=new URL(url),body=options.body===undefined?undefined:JSON.parse(options.body);
    calls.push({method:options.method,path:u.pathname+u.search,...(body===undefined?{}:{body}),headers:options.headers});
    if(u.pathname==='/api/login')return Response.json({csrf:'synthetic-adapter-csrf'},{headers:{'set-cookie':'sid=synthetic-adapter-session; HttpOnly'}});
    if(u.pathname==='/api/logout')return Response.json({ok:true});
    if(u.pathname==='/api/projects/1/sources'&&options.method==='POST'){
      const source={id:sources.length+1,...body};sources.push(source);return Response.json({...source,project_id:1});
    }
    if(u.pathname.endsWith('/sources'))return Response.json({role:'viewer',sources,next_after:null});
    assert.equal(u.pathname,'/api/projects/1/context');
    const query=u.searchParams.get('q')||'',limit=Number(u.searchParams.get('limit'));
    const facts=[1,2].map(id=>({id,subject:'color'+id,predicate:'status',value:'blue',version:1,revisionId:id+10,sourceId:1})).filter(f=>`${f.subject} ${f.predicate} ${f.value}`.toLowerCase().includes(query.toLowerCase()));
    const provenance=facts.map(f=>({sourceTextIsUntrusted:true,role:'viewer',fact:{id:f.id,subject:f.subject,predicate:f.predicate},revision:{id:f.revisionId,version:f.version,value:f.value,created_at:'2026-11-07T00:00:00.000Z',approved_by:1},sourceId:1,candidate:{id:f.id+20,expected_version:0,proposed_by:2}}));
    return Response.json({...snapshotReceipt(),projectId:1,query,limit,after:0,role:'viewer',sourceTextIsUntrusted:true,facts,provenance,sources:facts.length?sources:[],next_after:null});
  }};
}
async function syntheticWorkflow(adapter){
  const transport=syntheticProduct(),h=history();h.documents[0].text=' Synthetic source text.😀\n';
  const prepared=adapter.prepareHistory(h),imported=await adapter.ingestHistory(prepared,{baseURL:'http://127.0.0.1:3000',projectId:1},{fetchImpl:transport.fetchImpl});
  assert.equal(imported.status,'prepared_for_review');assert.equal(imported.autoApproved,false);assert.equal(imported.candidatesCreated,0);
  const frozen=await adapter.freezeApproved(imported.artifact,reader,{fetchImpl:transport.fetchImpl});assert.equal(frozen.status,'frozen');
  const body=mutable(frozen.artifact);delete body.sha256;
  const shared=body.snapshot.sources[0];for(const fact of body.snapshot.facts)fact.source=shared;
  const alias=adapter.seal(body);assert.equal(alias.sha256,frozen.artifact.sha256,'shared source aliases must retain the same JSON hash');
  const query={id:'q-shared',scope:'synthetic-a',question:'color'};
  const memz=await adapter.queryFrozen(alias,query,reader,{fetchImpl:transport.fetchImpl});
  const flat=await adapter.queryFrozen(alias,query,reader,{method:'flat_same_facts',fetchImpl:transport.fetchImpl});
  assert.equal(memz.status,'context_ready_no_generation');assert.equal(flat.status,'context_ready_no_generation');assert.equal(memz.context,flat.context);assert.equal(memz.modelCalls,0);
  assert.ok(!transport.calls.some(call=>call.path.includes('candidates')||call.path.includes('approve')));
  return {prepared,ingested:imported.artifact,frozen:frozen.artifact,context:memz.context,contextSha256:memz.contextSha256,querySha256:memz.querySha256,provenance:memz.provenance,sourceHashes:imported.artifact.sources,trace:transport.calls};
}
test('ordinary artifacts and shared source aliases retain deterministic JSON, hashes, approval boundaries and HTTP flow',async()=>{
  const first=await syntheticWorkflow(a),second=await syntheticWorkflow(a);assert.deepEqual(second,first);
  assert.equal(first.trace.length,42);assert.equal(first.frozen.snapshot.facts.length,2);assert.equal(first.frozen.snapshot.sources.length,1);
  // Captured from the pre-fix adapter on this exact offline synthetic workflow.
  assert.deepEqual([first.prepared.sha256,first.ingested.sha256,first.frozen.sha256,first.contextSha256,first.querySha256],[
    'b71e251e3491fbe4d522faa841cefc042a41a2ac6272b88395c1a41d6219ae27',
    'df891fd56a9ddaf68d708ac5f6df35a3f642a05f198a430ee2da5ac1b42f97dc',
    '66352d096927cbba95feb20e6a7d14907f6a3ade65b56265e0e3bd57cf75bd3e',
    '138f7385549024ee63cf88117a739e6463e6c00f7c9c12edf494b31e4c8eac41',
    'c18fe48cc37ecf78a95ee0f16d8dea8d02007671507bbcdea041350bebf08bfc']);
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(first.trace)).digest('hex'),'829c3617d81495a4e77e6b52299596b4919a5e0e4ed189564668a3271fdbd337');
});
