const assert=require('node:assert/strict');
const {readContext}=require('../scripts/context-client');
const {parseSearchQuery}=require('../scripts/search-query');
const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,2)+'\n');
module.exports=async function lexicalRetrieval({baseURL,call,owner,member,viewer,other}){
  const tag='多词回归',subject=`${tag}项目 Alpha`,value="Friday 100%_ + C++ foo\\bar 😀 O'Reilly";
  async function create(auth,path,body){const r=await call(auth,path,body);assert.equal(r.status,200,JSON.stringify(r.data));return r.data}
  const source=await create(member,'/api/projects/1/sources',{title:'多词合成来源 SourceOnlyMarker',content:'SourceOnlyMarker：原文😀\n'.repeat(100)});
  async function propose(subject,predicate,value,expected_version=0,source_id=source.id){return create(member,'/api/projects/1/candidates',{subject,predicate,value,expected_version,source_id})}
  async function approve(subject,predicate,value,expected_version=0,source_id=source.id){const c=await propose(subject,predicate,value,expected_version,source_id);await create(owner,`/api/projects/1/candidates/${c.id}/approve`,{});return c}
  for(let i=0;i<3;i++)await approve(subject,`截止日字段${i}`,value);
  await approve(`${tag}缺词`,'截止日','Monday 100x');
  await approve(`${tag}历史`,'期限','OldOnlyMarker');await approve(`${tag}历史`,'期限','CurrentOnlyMarker',1);
  await propose(`${tag}待审`,'期限','PendingOnlyMarker');
  const rejected=await propose(`${tag}驳回`,'期限','RejectedOnlyMarker');await create(owner,`/api/projects/1/candidates/${rejected.id}/reject`,{});
  const boundary='界'.repeat(198)+'😀';assert.equal(boundary.length,200);await approve(`${tag}边界`,'完整查询',boundary);
  const foreignSource=await create(other,'/api/projects/2/sources',{title:'多词其他项目',content:'其他项目内容'});
  const foreign=await create(other,'/api/projects/2/candidates',{subject,predicate:'截止日字段0',value,expected_version:0,source_id:foreignSource.id});await create(other,`/api/projects/2/candidates/${foreign.id}/approve`,{});
  const query=`Friday 截止日 ${tag}`,url=(q,extra='')=>`/api/projects/1/facts?q=${encodeURIComponent(q)}${extra}`;
  const raw=await call(viewer,url(query));assert.equal(raw.status,200);assert.deepEqual(raw.data.facts,[],'old substring is sensitive to order/adjacency');assert.equal(raw.data.search,undefined);
  for(const q of ['',tag,query,'x'.repeat(201)])assert.deepEqual(await call(viewer,url(q)),await call(viewer,url(q,'&match=substring')),'explicit legacy mode has unchanged payload');
  const page=await call(viewer,url(query,'&match=all_terms'));assert.equal(page.status,200);assert.equal(page.data.facts.length,3);assert.deepEqual(page.data.search,parseSearchQuery(query,'all_terms'));
  const expectedIds=page.data.facts.map(f=>f.id);assert.deepEqual(expectedIds,[...expectedIds].sort((a,b)=>a-b));
  const boundaryPage=await call(viewer,url(boundary,'&match=all_terms'));assert.equal(boundaryPage.status,200);assert.equal(boundaryPage.data.facts.length,1);
  const boundaryFact=boundaryPage.data.facts[0];assert.equal(boundaryFact.value,boundary);
  for(const q of [`${tag} 截止日 friday`,`FRIDAY ${tag} Alpha`,` ${tag}\tFriday\nFriday\u3000截止日 `,`${tag} Friday 100%_ + C++ foo\\bar 😀 O'Reilly`]){
    const found=await call(viewer,url(q,'&match=all_terms'));assert.equal(found.status,200);assert.deepEqual(found.data.facts.map(f=>f.id),expectedIds,q);assert.deepEqual(found.data.search.terms,parseSearchQuery(q,'all_terms').terms);
  }
  for(const token of ['%','_','+','C++','foo\\bar','😀',"O'Reilly"]){const r=await call(viewer,url(`${tag} ${token}`,'&match=all_terms'));assert.equal(r.status,200);assert.deepEqual(r.data.facts.map(f=>f.id),token==='😀'?[...expectedIds,boundaryFact.id].sort((a,b)=>a-b):expectedIds,`${token} is literal`)}
  for(const token of ['%','_']){const r=await call(viewer,url(`${tag}缺词 ${token}`,'&match=all_terms'));assert.equal(r.status,200);assert.deepEqual(r.data.facts,[],'100x must not satisfy a literal wildcard-looking term')}
  for(const token of ['OldOnlyMarker','PendingOnlyMarker','RejectedOnlyMarker','SourceOnlyMarker','Alpha截止日',"' OR TRUE--"]){const r=await call(viewer,url(`${tag} ${token}`,'&match=all_terms'));assert.equal(r.status,200);assert.deepEqual(r.data.facts,[],token)}
  assert.equal((await call(viewer,url(`${tag} CurrentOnlyMarker`,'&match=all_terms'))).data.facts.length,1);
  for(const suffix of ['?match=all_terms','?q=&match=all_terms','?q=%20%09&match=all_terms','?q=a&match=unknown','?q=a&match=','?q=a&q=b&match=all_terms','?q=a&match=all_terms&match=all_terms',`?q=${'x'.repeat(201)}&match=all_terms`,'?q=a%00b&match=all_terms','?q=a+b+c+d+e+f+g+h+i&match=all_terms'])assert.equal((await call(viewer,'/api/projects/1/facts'+suffix)).status,400,suffix);
  for(const auth of [owner,member,viewer]){const r=await call(auth,url(query,'&match=all_terms'));assert.equal(r.status,200);assert.deepEqual(r.data.facts.map(f=>f.id),expectedIds)}
  assert.equal((await call(other,url(query,'&match=all_terms'))).status,403);
  assert.equal((await call(viewer,`/api/projects/2/facts?q=${encodeURIComponent(query)}&match=all_terms`)).status,403);
  const own=await call(other,`/api/projects/2/facts?q=${encodeURIComponent(query)}&match=all_terms`);assert.equal(own.status,200);assert.equal(own.data.facts.length,1);assert.ok(!expectedIds.includes(own.data.facts[0].id));
  assert.equal((await fetch(baseURL+url(query,'&match=all_terms'))).status,401);
  let after=0;const paged=[];
  do{const r=await call(viewer,url(query,`&match=all_terms&limit=1&after=${after}`));assert.equal(r.status,200);assert.deepEqual(r.data.search,page.data.search);paged.push(...r.data.facts.map(f=>f.id));after=r.data.next_after;assert.ok(paged.length<=3)}while(after!==null);
  assert.deepEqual(paged,expectedIds);assert.equal(new Set(paged).size,3);
  const end=await call(viewer,url(query,'&match=all_terms&after=2147483647'));assert.equal(end.status,200);assert.deepEqual(end.data.facts,[]);assert.equal(end.data.next_after,null);assert.deepEqual(end.data.search,page.data.search);
  const legacy=await readContext({baseURL,query:tag});assert.equal(legacy.search,undefined);assert.deepEqual(legacy,await readContext({baseURL,query:tag,searchMode:'substring'}));
  for(const provenanceMode of ['individual','batch'])for(const sourceMode of ['inline','deduplicated']){
    const options={baseURL,query,searchMode:'all_terms',provenanceMode,sourceMode};
    const full=await readContext(options);assert.deepEqual(full.search,page.data.search);assert.deepEqual(full.facts.map(f=>f.id),expectedIds);assert.equal(full.sourceTextIsUntrusted,true);
    const inline=full.facts.map(({sourceId,...f})=>sourceMode==='inline'?f:{...f,source:full.sources.find(s=>s.id===sourceId)});
    assert.deepEqual(inline,legacy.facts.filter(f=>expectedIds.includes(f.id)));
    const prefix={...full,facts:full.facts.slice(0,1),truncated:true,nextAfter:expectedIds[0],outputBudget:{maxBytes:10000,unit:'utf8-json-bytes',omittedFacts:2}};
    let budget=10000;for(let i=0;i<5;i++){prefix.outputBudget.maxBytes=budget;budget=bytes(prefix)}
    const first=await readContext({...options,maxOutputBytes:budget});assert.deepEqual(first,prefix);assert.equal(bytes(first),budget);
    await assert.rejects(()=>readContext({...options,maxOutputBytes:budget-1}),{code:'OUTPUT_BUDGET_TOO_SMALL'});
    const gathered=[...first.facts];let cursor=first.nextAfter;
    do{const next=await readContext({...options,after:cursor,maxOutputBytes:budget+64});assert.deepEqual(next.search,full.search);assert.ok(bytes(next)<=budget+64);gathered.push(...next.facts);cursor=next.nextAfter;assert.ok(gathered.length<=3)}while(cursor!==null);
    assert.deepEqual(gathered,full.facts);
  }
  // Search picks the current version at page-read time; later approval cannot change pinned evidence.
  const changedSource=await create(member,'/api/projects/1/sources',{title:'多词修订后来源',content:'更正为 Monday，旧版来源必须仍可固定读取。'});
  let advanced=false;
  const options={baseURL,query,searchMode:'all_terms',provenanceMode:'batch',sourceMode:'deduplicated'};
  const pinned=await readContext({...options,fetchImpl:async(url,init)=>{
    const response=await fetch(url,init);
    if(!advanced&&new URL(url).pathname==='/api/projects/1/facts'){await approve(subject,'截止日字段0','Monday changed',1,changedSource.id);advanced=true}
    return response;
  }});
  assert.ok(advanced);assert.equal(pinned.facts[0].version,1);assert.equal(pinned.facts[0].value,value);assert.equal(pinned.facts[0].sourceId,source.id);assert.equal(pinned.sources[0].content,source.content);
  const advancedProof=await call(viewer,`/api/projects/1/facts/${expectedIds[0]}/provenance?version=2`);assert.equal(advancedProof.status,200);assert.equal(advancedProof.data.source.id,changedSource.id);assert.equal(advancedProof.data.source.content,changedSource.content);
  const now=await readContext(options);assert.deepEqual(now.facts.map(f=>f.id),expectedIds.slice(1));
  // Cursor continuation is a fresh snapshot and may include facts approved between requests.
  const first=await readContext({...options,limit:1});assert.equal(first.facts[0].id,expectedIds[1]);
  await approve(subject,'截止日字段0',value,2);await approve(subject,'截止日字段3',value);
  const next=await readContext({...options,after:first.nextAfter});assert.equal(next.facts.length,2);assert.equal(next.facts[0].id,expectedIds[2]);assert.ok(next.facts[1].id>expectedIds[2]);
  assert.ok(next.facts.every(f=>f.id>first.nextAfter),'a newly matching fact behind the cursor is not replayed');
  const restarted=await readContext(options);assert.deepEqual(restarted.facts.map(f=>f.id),[...expectedIds,next.facts[1].id]);assert.equal(restarted.facts[0].version,3,'restart reveals the newly matching lower-ID version');
};
