const {test}=require('node:test'),assert=require('node:assert/strict');
const {createSource}=require('../scripts/source-client');
const source={projectId:1,title:'合成来源',content:'中文与emoji😀原文',idempotencyKey:'synthetic-source'};
test('source creation rejects malformed and oversized intents before login',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw new Error('must not fetch')};
  for(const change of [{projectId:0},{title:''},{content:'\ud800'},{content:'x\0'},{content:'x'.repeat(4001)},{content:'\u0001'.repeat(4000)},{idempotencyKey:''},{extra:true}])await assert.rejects(()=>createSource({source:{...source,...change},fetchImpl}),e=>e.outcome==='not_attempted');
  assert.equal(calls,0);
});
test('source receipt must bind the exact project and normalized content',async()=>{
  for(const mismatch of [false,true]){
    const paths=[];const fetchImpl=async(url)=>{
      paths.push(url.pathname);
      if(url.pathname==='/api/login')return new Response(JSON.stringify({csrf:'synthetic'}),{headers:{'set-cookie':'sid=synthetic'}});
      if(url.pathname==='/api/logout')return new Response('{}');
      return new Response(JSON.stringify({id:7,project_id:1,title:source.title,content:mismatch?'different':source.content}));
    };
    if(mismatch)await assert.rejects(()=>createSource({source,fetchImpl}),e=>e.code==='INVALID_CREATION_RECEIPT'&&e.outcome==='unknown');
    else{const result=await createSource({source,fetchImpl});assert.equal(result.sourceId,7);assert.equal(result.candidateCreated,false)}
    assert.deepEqual(paths,['/api/login','/api/projects/1/sources','/api/logout']);
  }
});
