const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {EventEmitter,once}=require('node:events');
const {spawnSync}=require('node:child_process');
const os=require('node:os'),path=require('node:path');
const contract=require('../contracts/openapi-local-v1.json');
const {readContext}=require('../scripts/context-client');
const {createSource}=require('../scripts/source-client');
const {submitProposal}=require('../scripts/proposal-client');
const {app,pool}=require('../server');
const schemas=contract.components.schemas,parameters=contract.components.parameters;
const ref=value=>value.$ref?value.$ref.split('/').slice(1).reduce((node,key)=>node[key],contract):value;
function requiredKeys(schema){schema=ref(schema);return [...new Set([...(schema.required||[]),...(schema.allOf||[]).flatMap(requiredKeys)])]}
function assertRequired(name,value){for(const key of requiredKeys(schemas[name]))assert.ok(Object.hasOwn(value,key),`${name}.${key} absent`)}
const queries=[],originalConnect=pool.connect,originalLog=console.error;
let databaseFailure=null,facts=[],proofs=[],checkouts=0;
const source={id:17,title:'原创合成依据',content:'同名标题不能替代固定版本依据。'};
const proof={fact_id:11,subject:'合成任务',predicate:'状态',revision_id:31,version:7,value:'已确认',title:source.title,content:source.content,created_at:'2026-11-07T00:00:00.000Z',approved_by:1,source_id:17,candidate_id:21,expected_version:6,proposed_by:2};
pool.connect=async()=>{
  checkouts++;if(databaseFailure)throw Object.assign(new Error('synthetic-private-detail'),{code:databaseFailure});
  const client=new EventEmitter();client.release=()=>{};
  client.query=async(sql,values=[])=>{
    queries.push({sql,values});
    if(sql==='COMMIT')return {command:'COMMIT',rows:[]};
    if(sql.startsWith('BEGIN')||sql==='ROLLBACK'||sql.includes('set_config')||sql.startsWith('INSERT INTO audit')||sql.startsWith('INSERT INTO idempotency_requests')||sql.startsWith('SELECT pg_advisory_xact_lock'))return {rows:[]};
    if(sql.startsWith('SELECT role FROM memberships'))return {rows:[{role:'owner'}]};
    if(sql.includes('FROM unnest($2::int[]'))return {rows:proofs};
    if(sql.startsWith('SELECT id,title,content FROM sources'))return {rows:[source]};
    if(sql.startsWith('SELECT f.id AS fact_id'))return {rows:proofs};
    if(sql.includes('FROM facts f'))return {rows:facts};
    if(sql.startsWith('SELECT id FROM sources'))return {rowCount:1,rows:[{id:17}]};
    if(sql.startsWith('SELECT request_hash,response FROM idempotency_requests'))return {rows:[]};
    if(sql.startsWith('INSERT INTO sources'))return {rows:[{id:41,project_id:values[0],title:values[1],content:values[2]}]};
    if(sql.startsWith('INSERT INTO candidates'))return {rows:[{id:51,project_id:values[0],subject:values[1],predicate:values[2],value:values[3],source_id:values[4],expected_version:values[5],proposed_by:values[6],status:'pending',created_at:proof.created_at}]};
    throw new Error('Unexpected synthetic SQL');
  };
  return client;
};
const server=app.listen(0,'127.0.0.1'),ready=once(server,'listening');
let auth;
after(async()=>{console.error=originalLog;pool.connect=originalConnect;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end()});
async function request(path,{body,headers={},anonymous=false}={}){
  await ready;
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{
    method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(2000),
    headers:{...(!anonymous&&auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers},
    ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})
  });
  return {status:response.status,data:await response.json(),headers:response.headers};
}
async function login(){
  const result=await request('/api/login',{anonymous:true,body:{username:'owner',password:'demo-owner'}});
  assert.equal(result.status,200);assertRequired('LoginResponse',result.data);
  auth={cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.data.csrf};
}
const sourceInput={title:'原创合成来源',content:'仅用于离线合同回归'};
const candidateInput={subject:'合成任务',predicate:'状态',value:'待审',source_id:17,expected_version:0};
const sourceIntent={projectId:1,...sourceInput,idempotencyKey:'synthetic-source-key'};
const proposalIntent={projectId:1,sourceId:17,subject:'合成任务',predicate:'状态',value:'待审',expectedVersion:0,idempotencyKey:'synthetic-proposal-key'};
function fakeWrite(scenario,paths){
  return async(url,options)=>{
    paths.push(url.pathname);
    if(url.pathname==='/api/login')return Response.json({csrf:'synthetic-csrf'},{headers:{'set-cookie':'sid=synthetic-session; HttpOnly'}});
    if(url.pathname==='/api/logout'){if(scenario==='logout')throw new Error('synthetic-private-detail');return Response.json({ok:true})}
    if(scenario==='lost')throw new Error('synthetic-private-detail');
    if(Number.isInteger(scenario))return Response.json({error:'synthetic failure'},{status:scenario});
    if(scenario==='malformed')return Response.json({});
    if(scenario==='oversized')return new Response('x'.repeat(65537));
    const body=JSON.parse(options.body);
    return Response.json({id:71,project_id:1,...body,...(url.pathname.endsWith('/candidates')?{status:'pending'}:{})});
  };
}

test('OpenAPI subset has eight existing operations and resolves only local references',()=>{
  assert.equal(contract.openapi,'3.1.0');
  const source=fs.readFileSync(require.resolve('../server'),'utf8');
  const ids=[];
  for(const [path,item] of Object.entries(contract.paths))for(const [method,operation] of Object.entries(item)){
    ids.push(operation.operationId);
    assert.ok(source.includes(`app.${method}('${path.replace(/\{([^}]+)\}/g,':$1')}'`),'route registration absent');
    assert.ok(operation['x-memz-effect']);
    assert.deepEqual(operation.security,operation.operationId==='login'?[]:[{sid:[],...(method==='post'?{csrf:[]}:{})}],'authenticated POST requires cookie AND CSRF in one security requirement');
  }
  assert.equal(ids.length,8);assert.equal(new Set(ids).size,8);
  function visit(value){if(!value||typeof value!=='object')return;if(value.$ref){assert.ok(value.$ref.startsWith('#/components/'));assert.ok(ref(value))}for(const child of Object.values(value))visit(child)}
  visit(contract);
  assert.deepEqual(Object.keys(schemas.Error.properties),['error']);
});
test('real login/logout and read-only POST retain cookie, CSRF and JSON body gates',{timeout:10000},async()=>{
  const before=checkouts;
  assert.equal((await request('/api/projects/1/facts',{anonymous:true})).status,401);
  await login();
  assert.equal((await request('/api/projects/1/facts/provenance',{body:{facts:[{id:11,version:7}]},headers:{'x-csrf-token':'forged'}})).status,403);
  assert.equal((await request('/api/projects/1/sources',{body:sourceInput,headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await request('/api/projects/1/sources',{body:JSON.stringify(sourceInput)+' '.repeat(contract['x-memz-requestJsonMaxBytes'])})).status,413);
  assert.equal(checkouts,before);
  const out=await request('/api/logout',{body:{}});assert.equal(out.status,200);assertRequired('LogoutResponse',out.data);
  assert.equal((await request('/api/projects/1/facts')).status,401);await login();
});
test('actual facts and snapshot routes enforce distinct defaults and maxima before SQL',{timeout:10000},async()=>{
  facts=[];proofs=[];
  for(const [route,parameter,schema] of [['facts','FactsLimit','FactsPage'],['context','SnapshotLimit','SnapshotPage']]){
    const limits=parameters[parameter].schema;
    for(const limit of [undefined,limits.maximum]){
      queries.length=0;
      const result=await request(`/api/projects/1/${route}${limit===undefined?'':'?limit='+limit}`);
      assert.equal(result.status,200);assertRequired(schema,result.data);assert.equal(result.data.next_after,null);
      const query=queries.find(q=>q.sql.includes('FROM facts f'));
      assert.equal(query.values[3],(limit??limits.default)+1,'actual SQL limit+1 must follow the contract');
    }
    const before=checkouts;assert.equal((await request(`/api/projects/1/${route}?limit=${limits.maximum+1}`)).status,400);assert.equal(checkouts,before);
  }
});
test('actual facts pagination emits last-id continuation and applies after with a new request',{timeout:10000},async()=>{
  facts=Array.from({length:3},(_,i)=>({id:11+i,subject:'合成任务',predicate:'状态',version:7,value:'已确认',source:source.title}));
  const first=await request('/api/projects/1/facts?limit=2');assert.equal(first.status,200);assert.equal(first.data.next_after,12);
  for(const fact of first.data.facts)assertRequired('FactsListFact',fact);
  facts=[facts[2]];queries.length=0;
  const last=await request('/api/projects/1/facts?limit=2&after='+first.data.next_after);assert.equal(last.status,200);assert.equal(last.data.next_after,null);assert.equal(queries.find(q=>q.sql.includes('FROM facts f')).values[2],12);
  const before=checkouts;for(const query of ['after=1&after=2','after=1e0','limit=0','q=a&q=b'])assert.equal((await request('/api/projects/1/facts?'+query)).status,400);assert.equal(checkouts,before);facts=[];
});
test('actual query validation distinguishes substring truncation and bounded all_terms',{timeout:10000},async()=>{
  queries.length=0;
  assert.equal((await request('/api/projects/1/facts?q='+encodeURIComponent('a'.repeat(199)+'😀tail'))).status,200);
  assert.equal(queries.find(q=>q.sql.includes('FROM facts f')).values[1],'a'.repeat(199));
  queries.length=0;const valid=await request('/api/projects/1/facts?match=all_terms&q='+encodeURIComponent('甲 乙 甲'));
  assert.equal(valid.status,200);assert.deepEqual(valid.data.search.terms,['甲','乙']);assertRequired('Search',valid.data.search);
  const before=checkouts;
  for(const q of [' ', 'a'.repeat(parameters.Query['x-memz-allTermsMaxUtf16']+1),Array.from({length:parameters.Query['x-memz-allTermsMaxTerms']+1},(_,i)=>'term'+i).join(' '),'前\0后'])assert.equal((await request('/api/projects/1/facts?match=all_terms&q='+encodeURIComponent(q))).status,400);
  assert.equal(checkouts,before);
});
test('actual source/candidate validators count raw UTF-16 before trim and preserve normalized receipts',{timeout:10000},async()=>{
  for(const [route,input,schema,field,cap] of [
    ['sources',sourceInput,'SourceRecord','title',schemas.SourceRequest.properties.title['x-memz-maxUtf16CodeUnits']],
    ['sources',sourceInput,'SourceRecord','content',schemas.SourceRequest.properties.content['x-memz-maxUtf16CodeUnits']],
    ['candidates',candidateInput,'CandidateRecord','subject',schemas.CandidateRequest.properties.subject['x-memz-maxUtf16CodeUnits']],
    ['candidates',candidateInput,'CandidateRecord','predicate',schemas.CandidateRequest.properties.predicate['x-memz-maxUtf16CodeUnits']],
    ['candidates',candidateInput,'CandidateRecord','value',schemas.CandidateRequest.properties.value['x-memz-maxUtf16CodeUnits']]
  ]){
    const valid=await request('/api/projects/1/'+route,{body:{...input,[field]:'😀'.repeat(cap/2)}});assert.equal(valid.status,200);assertRequired(schema,valid.data);
    const before=checkouts;
    for(const text of ['😀'.repeat(cap/2+1),' '+('x'.repeat(cap-1))+' ','前\0后','前\ud800后'])assert.equal((await request('/api/projects/1/'+route,{body:{...input,[field]:text}})).status,400);
    assert.equal(checkouts,before);
    const trimmed=await request('/api/projects/1/'+route,{body:{...input,[field]:'  合成值  '}});assert.equal(trimmed.status,200);assert.equal(trimmed.data[field],'合成值');
    const key=parameters.IdempotencyKey.schema;
    assert.equal((await request('/api/projects/1/'+route,{body:input,headers:{'Idempotency-Key':'x'.repeat(key.maxLength+1)}})).status,400);
  }
});
test('actual individual and batch provenance preserve requested version and reject excessive references',{timeout:10000},async()=>{
  proofs=[proof];queries.length=0;
  const single=await request('/api/projects/1/facts/11/provenance?version=7');assert.equal(single.status,200);assertRequired('Provenance',single.data);assert.equal(single.data.revision.version,7);assert.equal(single.data.source.content,source.content);assert.equal(queries.find(q=>q.sql.startsWith('SELECT f.id AS fact_id')).values[2],7);
  const batch=await request('/api/projects/1/facts/provenance',{body:{facts:[{id:11,version:7}]}});assert.equal(batch.status,200);assertRequired('BatchResponse',batch.data);assert.deepEqual(batch.data.provenance,[single.data]);
  const before=checkouts;
  assert.equal((await request('/api/projects/1/facts/provenance',{body:{facts:Array.from({length:schemas.BatchRequest.properties.facts.maxItems+1},(_,i)=>({id:i+1,version:7}))}})).status,400);
  assert.equal((await request('/api/projects/1/facts/provenance',{body:{facts:[{id:'11',version:7}]}})).status,400);assert.equal(checkouts,before);proofs=[];
});
test('read routes return existing text beyond write caps without an invented read-schema cap',{timeout:10000},async()=>{
  const legacy={subject:'s'.repeat(101),predicate:'p'.repeat(101),value:'v'.repeat(1001),title:'t'.repeat(151),content:'c'.repeat(4001)};
  facts=[{id:11,subject:legacy.subject,predicate:legacy.predicate,version:7,value:legacy.value,source:legacy.title}];
  proofs=[{...proof,...legacy}];
  try{
    const page=await request('/api/projects/1/facts');assert.equal(page.status,200);
    for(const field of ['subject','predicate','value'])assert.equal(page.data.facts[0][field],legacy[field]);
    const provenance=await request('/api/projects/1/facts/11/provenance?version=7');assert.equal(provenance.status,200);
    assert.equal(provenance.data.fact.subject,legacy.subject);assert.equal(provenance.data.revision.value,legacy.value);
    assert.deepEqual(provenance.data.source,{id:17,title:legacy.title,content:legacy.content});
    for(const definition of [schemas.FactKey.properties.subject,schemas.FactKey.properties.predicate,schemas.Fact.allOf[1].properties.value,schemas.Revision.properties.value,schemas.Source.properties.title,schemas.Source.properties.content]){
      assert.equal(definition.type,'string');assert.equal(Object.hasOwn(definition,'x-memz-maxUtf16CodeUnits'),false);assert.equal(Object.hasOwn(definition,'maxLength'),false);
    }
  }finally{facts=[];proofs=[]}
});
test('HTTP failures keep the declared error-only shape without invented code or outcome',{timeout:10000},async()=>{
  databaseFailure='ECONNRESET';console.error=()=>{};
  try{
    for(const [path,body] of [['/api/projects/1/facts',undefined],['/api/projects/1/facts/provenance',{facts:[{id:11,version:7}]}],['/api/projects/1/sources',sourceInput],['/api/projects/1/candidates',candidateInput]]){
      const result=await request(path,{body});assert.equal(result.status,503);assert.deepEqual(Object.keys(result.data),Object.keys(schemas.Error.properties));assert.ok(!JSON.stringify(result.data).includes('synthetic-private'));
    }
  }finally{databaseFailure=null;console.error=originalLog}
});
test('real readContext sends bounded cursor and pins returned fact version rather than following current',{timeout:10000},async()=>{
  const paths=[];
  const result=await readContext({projectId:1,query:'合成',after:10,limit:1,fetchImpl:async url=>{
    paths.push(url.pathname+url.search);
    if(url.pathname==='/api/login')return Response.json({csrf:'synthetic'},{headers:{'set-cookie':'sid=synthetic'}});
    if(url.pathname==='/api/logout')return Response.json({ok:true});
    if(url.pathname.endsWith('/facts'))return Response.json({role:'viewer',facts:[{id:11,subject:proof.subject,predicate:proof.predicate,version:7,value:proof.value}],next_after:11});
    assert.equal(url.searchParams.get('version'),'7');return Response.json({role:'viewer',sourceTextIsUntrusted:true,fact:{id:11,subject:proof.subject,predicate:proof.predicate},revision:{id:31,version:7,value:proof.value,approved_by:1,created_at:proof.created_at},candidate:{id:21,proposed_by:2,expected_version:6},source});
  }});
  assert.equal(result.nextAfter,11);assert.equal(result.facts[0].version,7);assert.equal(result.facts[0].source.id,17);assert.equal(paths.length,4);assert.match(paths[1],/after=10/);
});
test('real write clients separate 4xx rejection, 5xx uncertainty, lost reply and verified receipt cleanup',{timeout:10000},async()=>{
  for(const [submit,intent] of [[createSource,{source:sourceIntent}],[submitProposal,{proposal:proposalIntent}]])for(const scenario of [403,409,503,'lost','malformed','oversized','logout']){
    const paths=[],fetchImpl=fakeWrite(scenario,paths);
    if(scenario==='logout'){const result=await submit({...intent,fetchImpl});assert.equal(result.sessionCleanup,'logout_failed');assert.equal(result.autoApproved,false)}
    else await assert.rejects(()=>submit({...intent,fetchImpl}),error=>error.outcome===(Number.isInteger(scenario)&&scenario<500?'rejected':'unknown')&&!error.message.includes('synthetic-private'));
    assert.equal(paths.filter(path=>!['/api/login','/api/logout'].includes(path)).length,1,'no automatic business retry');
  }
});
test('real write clients reject missing keys and pre-cancel before transport; post-dispatch cancel stays unknown',{timeout:10000},async()=>{
  for(const [submit,key,intent] of [[createSource,'source',sourceIntent],[submitProposal,'proposal',proposalIntent]]){
    let calls=0;const forbidden=async()=>{calls++;throw new Error('must not send')};
    await assert.rejects(()=>submit({[key]:{...intent,idempotencyKey:''},fetchImpl:forbidden}),e=>e.outcome==='not_attempted');
    await assert.rejects(()=>submit({[key]:intent,signal:AbortSignal.abort(),fetchImpl:forbidden}),e=>e.code==='REQUEST_CANCELLED'&&e.outcome==='not_attempted');assert.equal(calls,0);
    const controller=new AbortController(),paths=[];
    await assert.rejects(()=>submit({[key]:intent,signal:controller.signal,fetchImpl:async(url,options)=>{
      if(!['/api/login','/api/logout'].includes(url.pathname)){controller.abort();throw new Error('synthetic-private-detail')}
      return fakeWrite('success',paths)(url,options);
    }}),e=>e.code==='REQUEST_CANCELLED'&&e.outcome==='unknown');assert.equal(paths.at(-1),'/api/logout');
  }
});

test('real source/proposal clients fail closed on invalid session receipts before business transport',{timeout:10000},async()=>{
  for(const [submit,intent] of [[createSource,{source:sourceIntent}],[submitProposal,{proposal:proposalIntent}]])for(const scenario of ['cookie','csrf']){
    let business=0;
    await assert.rejects(()=>submit({...intent,fetchImpl:async url=>{
      if(url.pathname==='/api/login')return Response.json({csrf:scenario==='csrf'?'':'synthetic'},{headers:scenario==='cookie'?{}:{'set-cookie':'sid=synthetic'}});
      if(url.pathname==='/api/logout')return Response.json({ok:true});
      business++;throw new Error('must not submit');
    }}),e=>e.code==='INVALID_LOGIN_RESPONSE'&&e.outcome==='not_attempted');
    assert.equal(business,0);
  }
});
test('real source client reserves serialized body bytes before login even when character limits fit',{timeout:10000},async()=>{
  let calls=0;
  await assert.rejects(()=>createSource({source:{...sourceIntent,content:'\u0001'.repeat(schemas.SourceRequest.properties.content['x-memz-maxUtf16CodeUnits'])},fetchImpl:async()=>{calls++;throw new Error('must not fetch')}}),e=>e.code==='REQUEST_TOO_LARGE'&&e.outcome==='not_attempted');
  assert.equal(calls,0);
});
test('real source/proposal CLI stdin accepts exactly 16KiB and rejects one byte more without network',{timeout:10000},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memz-consumer-contract-'));
  try{
    const guard=path.join(dir,'synthetic-transport.cjs'),calls=path.join(dir,'transport-calls');
    fs.writeFileSync(guard,`require('node:net').Socket.prototype.connect=function(){process.stderr.write('UNEXPECTED_NETWORK');process.exit(94)};
const fs=require('node:fs');
globalThis.fetch=async function(url,options){
  fs.appendFileSync(${JSON.stringify(calls)},'call\\n');
  if(url.pathname==='/api/login')return Response.json({csrf:'synthetic'},{headers:{'set-cookie':'sid=synthetic'}});
  if(url.pathname==='/api/logout')return Response.json({ok:true});
  const body=JSON.parse(options.body);return Response.json({id:91,project_id:1,...body,...(url.pathname.endsWith('/candidates')?{status:'pending'}:{})});
};\n`);
    for(const [script,intent] of [['source-client',sourceIntent],['proposal-client',proposalIntent]])for(const extra of [0,1]){
      fs.rmSync(calls,{force:true});
      const json=JSON.stringify(intent),input=json+' '.repeat(contract['x-memz-requestJsonMaxBytes']-Buffer.byteLength(json)+extra);
      const child=spawnSync(process.execPath,['--require',guard,require.resolve('../scripts/'+script),'--stdin'],{env:{PATH:'/usr/local/bin:/usr/bin:/bin'},input,encoding:'utf8',timeout:3000,maxBuffer:8192});
      assert.equal(child.error,undefined);assert.equal(child.signal,null);
      if(extra){assert.equal(child.status,1);assert.equal(child.stdout,'');assert.deepEqual(JSON.parse(child.stderr),{code:'INPUT_TOO_LARGE',outcome:'not_attempted'});assert.equal(fs.existsSync(calls),false)}
      else {assert.equal(child.status,0);assert.equal(child.stderr,'');assert.equal(JSON.parse(child.stdout).autoApproved,false);assert.equal(fs.readFileSync(calls,'utf8').trim().split('\n').length,3)}
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('actual numeric-string inputs retain post-parse int32 bounds and normalize response numbers',{timeout:10000},async()=>{
  const range=schemas.PositiveIdInput.oneOf[1]['x-memz-decimalRange'];
  for(const value of ['00017',String(range[1])]){
    const response=await request('/api/projects/1/candidates',{body:{...candidateInput,source_id:value,expected_version:'0'}});assert.equal(response.status,200);assert.equal(typeof response.data.source_id,'number');assert.equal(response.data.expected_version,0);
  }
  const before=checkouts;
  for(const value of ['0',String(range[1]+1),'1e0'])assert.equal((await request('/api/projects/1/candidates',{body:{...candidateInput,source_id:value}})).status,400);
  assert.equal(checkouts,before);
});
