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
