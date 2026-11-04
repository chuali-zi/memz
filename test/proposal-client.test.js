const {test}=require('node:test'),assert=require('node:assert/strict');
const {submitProposal}=require('../scripts/proposal-client');
const proposal={projectId:1,sourceId:2,subject:'合成',predicate:'状态',value:'待审',expectedVersion:0,idempotencyKey:'synthetic-key'};
test('proposal client rejects invalid input and nonlocal targets before login',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw new Error('must not fetch')};
  for(const changes of [{sourceId:0},{expectedVersion:-1},{idempotencyKey:''},{value:'x\0'},{subject:'\ud800'},{extra:true}])await assert.rejects(()=>submitProposal({proposal:{...proposal,...changes},fetchImpl}),e=>e.outcome==='not_attempted');
  for(const baseURL of ['https://example.com','http://localhost/path','http://user:password@localhost/'])await assert.rejects(()=>submitProposal({baseURL,proposal,fetchImpl}),e=>e.outcome==='not_attempted');
  assert.equal(calls,0);
});
test('proposal client bounds replies, never automatically retries writes, and separates logout failure',async()=>{
  for(const scenario of ['lost','oversized','malformed','logout']){
    const paths=[];const fetchImpl=async(url)=>{
      paths.push(url.pathname);
      if(url.pathname==='/api/login')return new Response(JSON.stringify({csrf:'synthetic-csrf'}),{headers:{'set-cookie':'sid=synthetic-session; HttpOnly'}});
      if(url.pathname==='/api/logout'){if(scenario==='logout')throw new Error('synthetic secret must not escape');return new Response('{}')}
      if(scenario==='lost')throw new Error('synthetic secret must not escape');
      if(scenario==='oversized')return new Response('x'.repeat(65537));
      if(scenario==='malformed')return new Response('{}');
      return new Response(JSON.stringify({id:1,project_id:1,source_id:2,subject:'合成',predicate:'状态',value:'待审',expected_version:0,status:'pending'}));
    };
    if(scenario==='logout'){const result=await submitProposal({proposal,fetchImpl});assert.equal(result.candidateId,1);assert.equal(result.sessionCleanup,'logout_failed')}
    else await assert.rejects(()=>submitProposal({proposal,fetchImpl}),e=>e.outcome==='unknown'&&!e.message.includes('secret'));
    assert.deepEqual(paths,['/api/login','/api/projects/1/candidates','/api/logout']);
  }
});
