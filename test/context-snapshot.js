const assert=require('node:assert/strict');
const {readContext}=require('../scripts/context-client');
const {snapshotReceipt,SNAPSHOT_DESCRIPTION}=require('../scripts/context-snapshot');
const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,2)+'\n');
module.exports=async function contextSnapshot({baseURL,call,owner,member,viewer,other,pool,tx}){
  const subject='单页事务快照 Project😀',path='/api/projects/1/context';
  async function create(auth,url,body){const response=await call(auth,url,body);assert.equal(response.status,200,JSON.stringify(response.data));return response.data}
  const source=await create(member,'/api/projects/1/sources',{title:'同名快照来源',content:'界😀\n"'.repeat(800)});
  const second=await create(member,'/api/projects/1/sources',{title:'同名快照来源',content:'第二份完整来源，保持不同ID。'});
  const probeSource=await create(member,'/api/projects/1/sources',{title:'同名快照来源',content:'后页独有来源，不得提前传出。'});
  async function propose(predicate,value,expected_version=0,source_id=source.id){return create(member,'/api/projects/1/candidates',{subject,predicate,value,expected_version,source_id})}
  async function approve(predicate,value,expected_version=0,source_id=source.id){const candidate=await propose(predicate,value,expected_version,source_id);await create(owner,`/api/projects/1/candidates/${candidate.id}/approve`,{});return candidate}
  await approve('字段0','SnapshotOldOnly',0,second.id);
  for(let i=0;i<26;i++)await approve(`字段${i}`,`${i<3?'SharedGroup ':''}Friday 中文😀 \" ${i}`,i===0?1:0,i<24?source.id:i===24?second.id:probeSource.id);
  await propose('字段0','SnapshotPendingOnly',2);
  const rejected=await propose('字段0','SnapshotRejectedOnly',2);await create(owner,`/api/projects/1/candidates/${rejected.id}/reject`,{});
  // The schema permits a version-zero placeholder; it is never an approved fact.
  await tx(1,c=>c.query('INSERT INTO facts(project_id,subject,predicate) VALUES(1,$1,$2)',[subject,'未批准占位']));
  const url=(q,extra='')=>`${path}?q=${encodeURIComponent(q)}${extra}`;
  const page=await call(viewer,url(subject));assert.equal(page.status,200);assert.deepEqual({schema:page.data.schema,consistency:page.data.consistency},snapshotReceipt());assert.equal(page.data.limit,25);assert.equal(page.data.after,0);assert.equal(page.data.facts.length,25);assert.equal(page.data.provenance.length,25);assert.equal(page.data.next_after,page.data.facts.at(-1).id);
  assert.deepEqual(page.data.sources,[{id:source.id,title:source.title,content:source.content},{id:second.id,title:second.title,content:second.content}]);assert.ok(page.data.sources.every(s=>s.id!==probeSource.id));
  assert.ok(page.data.facts.every(f=>f.version>0&&f.predicate!=='未批准占位'));assert.equal(page.data.facts[0].version,2);
  for(let i=0;i<page.data.facts.length;i++){
    const fact=page.data.facts[i],proof=page.data.provenance[i];assert.equal(proof.revision.id,fact.revisionId);assert.equal(proof.sourceId,fact.sourceId);assert.equal(proof.source,undefined);
    const original=await call(viewer,`/api/projects/1/facts/${fact.id}/provenance?version=${fact.version}`);assert.equal(original.status,200);
    const {source:oldSource,...rest}=original.data;assert.deepEqual(proof,{...rest,sourceId:oldSource.id});
  }
  const rest=await call(viewer,url(subject,`&after=${page.data.next_after}`));assert.equal(rest.status,200);assert.equal(rest.data.facts.length,1);assert.equal(rest.data.next_after,null);assert.deepEqual(rest.data.sources,[{id:probeSource.id,title:probeSource.title,content:probeSource.content}]);
  const allIds=[...page.data.facts,...rest.data.facts].map(f=>f.id);assert.equal(new Set(allIds).size,26);assert.deepEqual(allIds,[...allIds].sort((a,b)=>a-b));
  const empty=await call(viewer,url(subject,'&after=2147483647'));assert.equal(empty.status,200);assert.deepEqual(empty.data.facts,[]);assert.deepEqual(empty.data.provenance,[]);assert.deepEqual(empty.data.sources,[]);assert.equal(empty.data.next_after,null);
  for(const q of ['SnapshotOldOnly','SnapshotPendingOnly','SnapshotRejectedOnly']){const result=await call(viewer,url(q));assert.equal(result.status,200);assert.deepEqual(result.data.facts,[])}
  const oldProof=await call(viewer,`/api/projects/1/facts/${allIds[0]}/provenance?version=1`);assert.equal(oldProof.status,200);assert.equal(oldProof.data.source.id,second.id);
  for(const suffix of ['&limit=26','&limit=0','&limit=1&limit=2','&after=-1','&after=1&after=2','&match=unknown','&match=all_terms&match=substring','&q=duplicate'])assert.equal((await call(viewer,url(subject,suffix))).status,400,suffix);
  assert.equal((await call(viewer,path+'?match=all_terms')).status,400);
  assert.equal((await call(viewer,path+'?match=all_terms&q='+('x'.repeat(201)))).status,400);
  assert.equal((await call(viewer,path+'?q=%00')).status,400);
  for(const [auth,role] of [[owner,'owner'],[member,'member'],[viewer,'viewer']]){const result=await call(auth,url(subject,'&limit=1'));assert.equal(result.status,200);assert.equal(result.data.role,role);assert.deepEqual(result.data.facts,page.data.facts.slice(0,1));assert.equal(result.data.provenance[0].role,role)}
  assert.equal((await call(other,url(subject))).status,403);assert.equal((await call(viewer,'/api/projects/2/context')).status,403);assert.equal((await fetch(baseURL+url(subject))).status,401);
  const foreignSource=await create(other,'/api/projects/2/sources',{title:source.title,content:'OtherProjectSnapshotOnly'});
  const foreign=await create(other,'/api/projects/2/candidates',{subject,predicate:'字段0',value:'OtherProjectSnapshotOnly',source_id:foreignSource.id,expected_version:0});await create(other,`/api/projects/2/candidates/${foreign.id}/approve`,{});
  const own=await call(other,`/api/projects/2/context?q=${encodeURIComponent(subject)}`);assert.equal(own.status,200);assert.equal(own.data.facts.length,1);assert.equal(own.data.sources[0].id,foreignSource.id);assert.ok(!allIds.includes(own.data.facts[0].id));
  // Frozen synthetic state: count HTTP responses and actual body bytes, without timing/model claims.
  const query='Friday SharedGroup 单页事务快照',common={baseURL,query,searchMode:'all_terms',sourceMode:'deduplicated'};
  const measurements=[];let baseline;
  for(const provenanceMode of ['individual','batch','snapshot']){
    let requests=0,responseBodyBytes=0;
    const result=await readContext({...common,provenanceMode,fetchImpl:async(url,init)=>{requests++;const response=await fetch(url,init);responseBodyBytes+=(await response.clone().arrayBuffer()).byteLength;return response}});
    assert.equal(result.facts.length,3);assert.deepEqual(result.search.terms,['Friday','SharedGroup','单页事务快照']);
    const expanded=result.facts.map(({sourceId,...fact})=>({...fact,source:result.sources.find(s=>s.id===sourceId)}));
    if(!baseline)baseline=expanded;else assert.deepEqual(expanded,baseline);
    assert.equal(requests,{individual:6,batch:4,snapshot:3}[provenanceMode]);
    measurements.push({provenanceMode,requests,responseBodyBytes,facts:result.facts.length,sources:result.sources.length});
  }
  assert.ok(measurements[2].responseBodyBytes<measurements[0].responseBodyBytes);assert.ok(measurements[2].responseBodyBytes<measurements[1].responseBodyBytes);
  console.log('Synthetic snapshot transport comparison:',JSON.stringify({synthetic:true,unit:'http-response-body-bytes',measurements}));
  for(const sourceMode of ['inline','deduplicated']){
    const options={...common,sourceMode,provenanceMode:'snapshot'},full=await readContext(options);assert.deepEqual(full.snapshot,snapshotReceipt());assert.equal(full.consistency,SNAPSHOT_DESCRIPTION);
    const inline=full.facts.map(({sourceId,...fact})=>sourceMode==='inline'?fact:{...fact,source:full.sources.find(s=>s.id===sourceId)});assert.deepEqual(inline,baseline);
    const prefix={...full,facts:full.facts.slice(0,1),truncated:true,nextAfter:full.facts[0].id,outputBudget:{maxBytes:20000,unit:'utf8-json-bytes',omittedFacts:2}};
    let budget=20000;for(let i=0;i<5;i++){prefix.outputBudget.maxBytes=budget;budget=bytes(prefix)}
    assert.equal(String(budget).length,String(budget-1).length);
    const bounded=await readContext({...options,maxOutputBytes:budget});assert.deepEqual(bounded,prefix);assert.equal(bytes(bounded),budget);
    await assert.rejects(()=>readContext({...options,maxOutputBytes:budget-1}),{code:'OUTPUT_BUDGET_TOO_SMALL'});
    const collected=[...bounded.facts];let after=bounded.nextAfter;
    do{const next=await readContext({...options,after,maxOutputBytes:budget+64});assert.deepEqual(next.snapshot,full.snapshot);assert.deepEqual(next.search,full.search);assert.ok(bytes(next)<=budget+64);collected.push(...next.facts);after=next.nextAfter;assert.ok(collected.length<=3)}while(after!==null);
    assert.deepEqual(collected,full.facts);
  }
  // Interpose only in this test, restoring the pool and client even on failure.
  async function interceptQuery(predicate,observe,run){
    const connect=pool.connect;let interceptedClient,originalQuery,intercepted=false;
    pool.connect=async function(...args){
      pool.connect=connect;const client=await connect.apply(pool,args);interceptedClient=client;originalQuery=client.query;
      client.query=async function(...queryArgs){
        const result=await originalQuery.apply(client,queryArgs);
        if(!intercepted&&typeof queryArgs[0]==='string'&&predicate(queryArgs[0])){intercepted=true;client.query=originalQuery;return observe({client,query:originalQuery.bind(client),result})}
        return result;
      };
      return client;
    };
    try{const result=await run();assert.ok(intercepted,'target query must actually execute');return result}
    finally{pool.connect=connect;if(interceptedClient)interceptedClient.query=originalQuery}
  }
  const isFactQuery=sql=>sql.includes('LEFT JOIN revisions r ON r.id=f.current_revision_id');
  const isProofQuery=sql=>sql.includes('c.source_id AS candidate_source_id');
  const isSourceQuery=sql=>sql.includes('SELECT id,title,content FROM sources WHERE project_id=$1 AND id=ANY');
  // A pinned proof alone also works under READ COMMITTED. Observe the *current* row
  // in the original connection after a committed writer to distinguish real RR.
  const change=await propose('字段0','SnapshotNewOnly',2,probeSource.id);let observation,beforeSnapshot;
  const pinned=await interceptQuery(isFactQuery,async({query:dbQuery,result})=>{
    beforeSnapshot=(await dbQuery('SELECT pg_current_snapshot()::text AS snapshot')).rows[0].snapshot;
    await create(owner,`/api/projects/1/candidates/${change.id}/approve`,{});
    observation=(await dbQuery(`SELECT f.version,r.value,current_setting('transaction_isolation') AS isolation,
      current_setting('transaction_read_only') AS read_only,pg_current_snapshot()::text AS snapshot
      FROM facts f JOIN revisions r ON r.id=f.current_revision_id WHERE f.id=$1`,[allIds[0]])).rows[0];
    return result;
  },()=>readContext({...common,provenanceMode:'snapshot'}));
  assert.deepEqual(observation,{version:2,value:baseline[0].value,isolation:'repeatable read',read_only:'on',snapshot:beforeSnapshot});
  assert.equal(pinned.facts[0].version,2);assert.equal(pinned.facts[0].sourceId,source.id);assert.equal(pinned.sources[0].content,source.content);
  const changed=await readContext({baseURL,query:'SnapshotNewOnly',provenanceMode:'snapshot',sourceMode:'deduplicated'});assert.equal(changed.facts[0].version,3);assert.equal(changed.facts[0].sourceId,probeSource.id);assert.equal(changed.sources[0].content,probeSource.content);
  // Simulate missing/corrupt evidence in actual query results, without corrupting DB data.
  for(const [predicate,mutate] of [[isFactQuery,result=>{result.rows[0].revision_id=null}],[isProofQuery,result=>{result.rows[0].candidate_id=null}],[isSourceQuery,result=>{result.rows=[]}],[isSourceQuery,result=>{result.rows[0].content='x'.repeat(1048576)}]]){
    const response=await interceptQuery(predicate,async({result})=>{mutate(result);return result},()=>call(viewer,url('SnapshotNewOnly','&limit=1')));
    assert.equal(response.status,500);assert.deepEqual(response.data,{error:'请求无法处理'},'failure must contain neither partial facts nor a raw source');
  }
  const afterFault=await readContext({baseURL,query:'SnapshotNewOnly',provenanceMode:'snapshot'});assert.equal(afterFault.facts[0].source.content,probeSource.content,'query-result fault injection never modifies stored sources');
};
