const assert=require('node:assert/strict');
const {readContext}=require('../scripts/context-client');
const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,2)+'\n');
module.exports=async function contextOptimization({baseURL,call,owner,member,viewer,other}){
  const subject='批量去重合成验证',path='/api/projects/1/facts/provenance';
  async function create(auth,url,body){const response=await call(auth,url,body);assert.equal(response.status,200,JSON.stringify(response.data));return response.data}
  const content='界😀\n"'.repeat(800);
  const source=await create(member,'/api/projects/1/sources',{title:'同名批量来源',content});
  const second=await create(member,'/api/projects/1/sources',{title:'同名批量来源',content:'另一份来源原文😀'});
  async function approve(predicate,value,expected_version=0,source_id=source.id){
    const candidate=await create(member,'/api/projects/1/candidates',{subject,predicate,value,expected_version,source_id});
    await create(owner,`/api/projects/1/candidates/${candidate.id}/approve`,{});
  }
  for(let i=0;i<27;i++)await approve(`字段${i}`,`合成值${i}`,0,i===1?second.id:source.id);
  const original=await readContext({baseURL,query:subject,limit:100});assert.equal(original.facts.length,27);
  const refs=original.facts.map(({id,version})=>({id,version}));
  for(const provenanceMode of ['individual','batch'])for(const sourceMode of ['inline','deduplicated']){
    let requests=0;
    const context=await readContext({baseURL,query:subject,limit:100,provenanceMode,sourceMode,fetchImpl:async(...args)=>{requests++;return fetch(...args)}});
    assert.equal(requests,provenanceMode==='batch'?5:30);
    assert.equal(context.sourceTextIsUntrusted,true);assert.equal(context.consistency,original.consistency);
    if(sourceMode==='inline')assert.deepEqual(context,original);
    else{
      assert.equal(context.schemaVersion,2);assert.deepEqual(context.sources,[{id:source.id,title:source.title,content},{id:second.id,title:second.title,content:second.content}]);
      assert.deepEqual(context.facts.map(({sourceId,...fact})=>({...fact,source:context.sources.find(s=>s.id===sourceId)})),original.facts);
      assert.ok(bytes(context)<bytes(original));
    }
  }
  const firstRefs=[refs[2],refs[0],refs[1]],batch=await create(viewer,path,{facts:firstRefs});
  assert.equal(batch.sourceTextIsUntrusted,true);assert.equal(batch.role,'viewer');
  for(let i=0;i<firstRefs.length;i++){
    const ref=firstRefs[i];assert.deepEqual(batch.provenance[i],(await call(viewer,`/api/projects/1/facts/${ref.id}/provenance?version=${ref.version}`)).data);
  }
  assert.equal((await call(viewer,path,{facts:refs.slice(0,25)})).status,200);
  const invalid=[{}, {facts:[]},{facts:refs.slice(0,26)},{facts:[refs[0],refs[0]]},{facts:[refs[0]],extra:true},{facts:{}},{facts:[null]},{facts:[[]]},{facts:[{id:refs[0].id}]},{facts:[{...refs[0],extra:1}]}];
  for(const field of ['id','version'])for(const value of [0,-1,1.5,2147483648,'1',null,true])invalid.push({facts:[{...refs[0],[field]:value}]});
  for(const body of invalid){const result=await call(viewer,path,body);assert.equal(result.status,400,JSON.stringify(body));assert.equal(result.data.provenance,undefined)}
  assert.equal((await call(viewer,path,{facts:[refs[0]]},{'x-csrf-token':''})).status,403);
  assert.equal((await fetch(baseURL+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({facts:[refs[0]]})})).status,401);
  assert.equal((await call(viewer,path,{facts:[refs[0]]},{'content-type':'text/plain'})).status,415);
  assert.equal((await call(other,path,{facts:[refs[0]]})).status,403);
  assert.equal((await call(other,'/api/projects/2/facts/provenance',{facts:[refs[0]]})).status,404);
  assert.equal((await call(viewer,'/api/projects/2/facts/provenance',{facts:[refs[0]]})).status,403);
  const foreignSource=await create(other,'/api/projects/2/sources',{title:'批量隔离来源',content:'另项目专有内容'});
  const foreignCandidate=await create(other,'/api/projects/2/candidates',{subject,predicate:'字段0',value:'另项目值',source_id:foreignSource.id,expected_version:0});
  await create(other,`/api/projects/2/candidates/${foreignCandidate.id}/approve`,{});
  const foreignFact=(await call(other,`/api/projects/2/facts?q=${encodeURIComponent(subject)}`)).data.facts[0];
  for(const ref of [{id:refs[0].id,version:999},{id:2147483647,version:1},{id:foreignFact.id,version:1}]){
    const result=await call(viewer,path,{facts:[refs[1],ref]});assert.equal(result.status,404);assert.deepEqual(Object.keys(result.data),['error'],'no partial provenance escapes a failed batch');
  }
  // Budget a complete prefix with just one shared source, then resume without loss.
  const options={baseURL,query:subject,limit:100,provenanceMode:'batch',sourceMode:'deduplicated'};
  const full=await readContext(options),prefix={...full,facts:full.facts.slice(0,1),sources:[full.sources[0]],truncated:true,nextAfter:full.facts[0].id,outputBudget:{maxBytes:20000,unit:'utf8-json-bytes',omittedFacts:26}};
  let budget=20000;for(let i=0;i<5;i++){prefix.outputBudget.maxBytes=budget;budget=bytes(prefix)}
  const bounded=await readContext({...options,maxOutputBytes:budget});assert.deepEqual(bounded,prefix);assert.equal(bytes(bounded),budget);assert.equal(bounded.sources[0].content,content);
  await assert.rejects(()=>readContext({...options,maxOutputBytes:budget-1}),e=>e.code==='OUTPUT_BUDGET_TOO_SMALL');
  const continued=await readContext({...options,after:bounded.nextAfter});assert.deepEqual([...bounded.facts,...continued.facts],full.facts);assert.equal(continued.nextAfter,null);
  assert.deepEqual(continued.sources.map(s=>s.id),[second.id,source.id]);
  // A broken proof in the omitted final chunk must still fail the entire read.
  let batches=0;
  await assert.rejects(()=>readContext({...options,maxOutputBytes:budget,fetchImpl:async(url,init)=>{
    if(new URL(url).pathname===path&&++batches===2)return Response.json({error:'synthetic failure'},{status:503});
    return fetch(url,init);
  }}),e=>e.status===503);assert.equal(batches,2);
  // The facts page pins v1 even when approval advances it before batch retrieval.
  let raced=false,sessionCookie;
  const racedContext=await readContext({...options,fetchImpl:async(url,init)=>{
    const response=await fetch(url,init),pathname=new URL(url).pathname;
    if(pathname==='/api/login')sessionCookie=response.headers.get('set-cookie').split(';')[0];
    if(!raced&&pathname==='/api/projects/1/facts'){await approve('字段0','批准第二版',1,second.id);raced=true}
    return response;
  }});
  assert.ok(raced);assert.deepEqual(racedContext,full);
  assert.equal((await fetch(baseURL+'/api/projects',{headers:{cookie:sessionCookie}})).status,401);
  const historical=await create(viewer,path,{facts:[{id:refs[0].id,version:2},refs[0]]});
  assert.deepEqual(historical.provenance.map(p=>[p.revision.version,p.source.id]),[[2,second.id],[1,source.id]],'distinct versions of one fact are allowed and keep input order');
  const now=await readContext(options);assert.equal(now.facts[0].version,2);assert.equal(now.facts[0].value,'批准第二版');assert.equal(now.facts[0].sourceId,second.id);
};
