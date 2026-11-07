const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {decide,pool}=require('../server');
after(()=>pool.end());
test('the exported decision helper requires an explicit exact action before any business query',async()=>{
  let queries=0,coercions=0;const client={query:async()=>{queries++;assert.fail('invalid decisions must not query roles, candidates or facts')}};
  const object={toString(){coercions++;return 'approve'}};
  for(const decision of [undefined,null,'','skip','APPROVE','approve ',' reject',true,0,{},[],object,Symbol('synthetic-private')]){
    await assert.rejects(()=>decide(client,1,1,1,decision),error=>error.status===400&&error.message==='操作无效'&&error.cause===undefined);
  }
  assert.equal(queries,0);assert.equal(coercions,0);
});
