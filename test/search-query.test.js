const {test}=require('node:test'),assert=require('node:assert/strict');
const {parseSearchQuery,matchesSearchMetadata}=require('../scripts/search-query');
const {readContext}=require('../scripts/context-client');
test('all_terms preserves literal terms and deduplicates exact strings in first-seen order',()=>{
  const search=parseSearchQuery('  截止日\t项目\nAPI API api % _ \\ 😀  ','all_terms');
  assert.deepEqual(search,{mode:'all_terms',terms:['截止日','项目','API','api','%','_','\\','😀'],order:'fact_id_asc',matching:'all_terms_any_field_substring',caseHandling:'postgresql_lower',fields:['subject','predicate','value']});
  assert.deepEqual(parseSearchQuery('İ I i ı Σ σ ς','all_terms').terms,['İ','I','i','ı','Σ','σ','ς'],'no JavaScript Unicode lower/case folding');
  assert.deepEqual(parseSearchQuery('é e\u0301','all_terms').terms,['é','e\u0301'],'no Unicode normalization');
  assert.deepEqual(parseSearchQuery('甲\u3000乙\u00a0丙\u2028丁','all_terms').terms,['甲','乙','丙','丁']);
  assert.deepEqual(parseSearchQuery('项目截止日','all_terms').terms,['项目截止日'],'no Chinese tokenizer');
});
test('all_terms validates original length, term count and Unicode without truncation',()=>{
  for(const query of ['', ' \t\n\u3000',null,[],2,'前\0后','前\ud800后','前\udc00后','x'.repeat(201),'😀'.repeat(101)])assert.throws(()=>parseSearchQuery(query,'all_terms'),{code:'INVALID_QUERY'});
  assert.equal(parseSearchQuery('x'.repeat(200),'all_terms').terms[0].length,200);
  assert.equal(parseSearchQuery('😀'.repeat(100),'all_terms').terms[0].length,200);
  assert.equal(parseSearchQuery('a b c d e f g h h a','all_terms').terms.length,8);
  assert.throws(()=>parseSearchQuery('a b c d e f g h i','all_terms'),{code:'TOO_MANY_SEARCH_TERMS'});
  assert.throws(()=>parseSearchQuery('a b c d e f g h A','all_terms'),{code:'TOO_MANY_SEARCH_TERMS'});
  for(const mode of ['',null,true,[],['all_terms'],'ranked'])assert.throws(()=>parseSearchQuery('q',mode),{code:'INVALID_SEARCH_MODE'});
  assert.equal(parseSearchQuery('', 'substring'),null);assert.equal(parseSearchQuery('x'.repeat(201)),null,'legacy validation/truncation stays with the caller');
});
function transport(search){
  const calls=[];
  return {calls,fetchImpl:async(url)=>{
    const u=new URL(url);calls.push(u);
    if(u.pathname==='/api/login')return Response.json({csrf:'unit'},{headers:{'set-cookie':'sid=unit; HttpOnly'}});
    if(u.pathname==='/api/logout')return Response.json({});
    return Response.json({role:'viewer',facts:[],next_after:null,...(search===undefined?{}:{search})});
  }};
}
test('client rejects invalid search configuration before login',async()=>{
  const f=transport();
  for(const options of [{searchMode:'ranked'},{searchMode:null},{searchMode:'all_terms'},{searchMode:'all_terms',query:'   '},{searchMode:'all_terms',query:'a b c d e f g h i'}])await assert.rejects(()=>readContext({...options,fetchImpl:f.fetchImpl}),e=>['INVALID_SEARCH_MODE','INVALID_QUERY','TOO_MANY_SEARCH_TERMS'].includes(e.code));
  assert.equal(f.calls.length,0);
});
test('client requires exact matching receipt and fails closed against a server ignoring match',async()=>{
  const query='截止日 项目',expected=parseSearchQuery(query,'all_terms');
  const invalid=[undefined,null,[],{...expected,mode:'substring'},{...expected,terms:['项目','截止日']},{...expected,terms:['截止日']},{...expected,order:'rank_desc'},{...expected,matching:'or'},{...expected,caseHandling:'javascript_lower'},{...expected,fields:['value']},{...expected,extra:true}];
  for(const search of invalid){
    assert.equal(matchesSearchMetadata(search,expected),false);
    const f=transport(search);await assert.rejects(()=>readContext({query,searchMode:'all_terms',fetchImpl:f.fetchImpl}),{code:'INVALID_SEARCH_RESPONSE'});
    assert.equal(f.calls[1].searchParams.get('match'),'all_terms');assert.equal(f.calls.at(-1).pathname,'/api/logout');assert.equal(f.calls.length,3);
  }
});
test('client preserves a validated search receipt independent of object key order',async()=>{
  const query='截止日 项目',search=parseSearchQuery(query,'all_terms');
  const reordered=Object.fromEntries(Object.entries(search).reverse()),f=transport(reordered);
  const result=await readContext({query,searchMode:'all_terms',fetchImpl:f.fetchImpl});assert.deepEqual(result.search,search);assert.equal(result.query,query);assert.deepEqual(result.facts,[]);
  const implicit=transport(),explicit=transport();
  assert.deepEqual(await readContext({query,fetchImpl:implicit.fetchImpl}),await readContext({query,searchMode:'substring',fetchImpl:explicit.fetchImpl}));
  assert.equal(implicit.calls[1].searchParams.has('match'),false);assert.equal(explicit.calls[1].searchParams.has('match'),false);
});
test('opt-in receipt is included in exact UTF-8 output budget accounting',async()=>{
  const query='中文 😀',search=parseSearchQuery(query,'all_terms'),f=transport(search);
  const full=await readContext({query,searchMode:'all_terms',maxOutputBytes:5000,fetchImpl:f.fetchImpl});
  const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,2)+'\n');
  let budget=5000;for(let i=0;i<5;i++){full.outputBudget.maxBytes=budget;budget=bytes(full)}
  const result=await readContext({query,searchMode:'all_terms',maxOutputBytes:budget,fetchImpl:transport(search).fetchImpl});assert.deepEqual(result,full);assert.equal(bytes(result),budget);
  await assert.rejects(()=>readContext({query,searchMode:'all_terms',maxOutputBytes:budget-1,fetchImpl:transport(search).fetchImpl}),{code:'OUTPUT_BUDGET_TOO_SMALL'});
});
