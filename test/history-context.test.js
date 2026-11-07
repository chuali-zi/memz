const {test}=require('node:test'),assert=require('node:assert/strict');
const {readHistoryContext}=require('../scripts/history-context');
function fixture({mutatePage=()=>{},mutateProof=()=>{},empty=false,more=false}={}){
  const calls=[],history=empty?[]:[2,1].map(version=>({id:version+10,fact_id:4,subject:'中文😀',predicate:'截止日',version,value:`${version}号`,source:'完整依据',created_at:'2026-11-06T00:00:00.000Z'}));
  const page={role:'viewer',history,next_before:more?11:null};mutatePage(page);
  const proofs=history.map(row=>({sourceTextIsUntrusted:true,role:'viewer',fact:{id:4,subject:row.subject,predicate:row.predicate},revision:{id:row.id,version:row.version,value:row.value,created_at:row.created_at,approved_by:1},source:{id:row.version+20,title:row.source,content:`全文${row.version}😀\n"`},candidate:{id:row.version+30,proposed_by:2,expected_version:row.version-1}}));
  proofs.forEach(mutateProof);
  return {calls,fetchImpl:async(url,options)=>{
    const u=new URL(url);calls.push(u);assert.equal(options.redirect,'error');
    if(u.pathname==='/api/login')return Response.json({csrf:'unit'},{headers:{'set-cookie':'sid=unit; HttpOnly'}});
    assert.equal(options.headers.cookie,'sid=unit');
    if(u.pathname==='/api/logout'){assert.equal(options.headers['X-CSRF-Token'],'unit');return Response.json({})}
    if(u.pathname.endsWith('/history'))return Response.json(page);
    assert.equal(options.headers['X-CSRF-Token'],'unit');assert.deepEqual(JSON.parse(options.body).facts,history.map(r=>({id:r.fact_id,version:r.version})));
    return Response.json({sourceTextIsUntrusted:true,role:'viewer',provenance:proofs});
  }};
}
test('history context binds multiple versions of the same fact and preserves full sources and cursor',async()=>{
  const f=fixture({more:true}),result=await readHistoryContext({fetchImpl:f.fetchImpl});
  assert.deepEqual(result.revisions.map(r=>[r.id,r.version,r.revisionId]),[[4,2,12],[4,1,11]]);
  assert.equal(result.sources[1].content,'全文1😀\n"');assert.equal(result.nextBefore,11);assert.equal(result.truncated,true);assert.equal(f.calls.length,4);
  assert.equal(result.before,null);assert.equal(result.limit,25);
  const empty=fixture({empty:true});assert.deepEqual((await readHistoryContext({fetchImpl:empty.fetchImpl})).revisions,[]);assert.equal(empty.calls.length,3);
});
test('history protocol rejects swapped versions, audit/source corruption and malformed paging, then logs out',async()=>{
  const variants=[{mutatePage:p=>{p.history.reverse()}},{mutatePage:p=>{p.next_before=99}},
    ...[p=>{p.revision.version++},p=>{p.revision.id++},p=>{p.source.title='wrong'},p=>{p.sourceTextIsUntrusted=false},p=>{p.candidate.expected_version=99},p=>{p.revision.created_at='2020-01-01'}].map(mutateProof=>({mutateProof}))];
  for(const variant of variants){const f=fixture(variant);await assert.rejects(()=>readHistoryContext({fetchImpl:f.fetchImpl}),{code:'INVALID_HISTORY_RESPONSE'});assert.equal(f.calls.at(-1).pathname,'/api/logout')}
});
test('history rejects bad configuration before login and enforces both byte budgets',async()=>{
  for(const config of [{limit:26},{before:0},{before:'1'},{projectId:0},{baseURL:'https://user:pass@example.org'},{maxOutputBytes:0},{maxResponseBytes:1048577}]){
    await assert.rejects(()=>readHistoryContext({...config,fetchImpl:()=>assert.fail('no network')}),e=>e.code.startsWith('INVALID_'));
  }
  for(const [config,code] of [[{maxOutputBytes:1},'OUTPUT_BUDGET_TOO_SMALL'],[{maxResponseBytes:200},'RESPONSE_TOO_LARGE']]){
    const f=fixture();await assert.rejects(()=>readHistoryContext({...config,fetchImpl:f.fetchImpl}),{code});assert.equal(f.calls.at(-1).pathname,'/api/logout');
  }
});
test('history reports bounded timeout and authorization failures without raw errors or fallback',async()=>{
  const f=fixture();await assert.rejects(()=>readHistoryContext({fetchImpl:async(url,o)=>new URL(url).pathname.endsWith('/history')?Response.json({error:'private'},{status:403}):f.fetchImpl(url,o)}),{code:'HTTP_403'});
  await assert.rejects(()=>readHistoryContext({fetchImpl:()=>{throw new Error('secret-placeholder')}}),e=>e.code==='REQUEST_FAILED'&&!e.message.includes('secret'));
  const slow=fixture();await assert.rejects(()=>readHistoryContext({totalTimeoutMs:1,fetchImpl:async(...args)=>{await new Promise(r=>setTimeout(r,10));return slow.fetchImpl(...args)}}),{code:'TOTAL_TIMEOUT'});
  assert.equal(slow.calls.at(-1).pathname,'/api/logout');
});
test('optional native signal rejects pre-cancelled or invalid callers before any HTTP',async()=>{
  const controller=new AbortController();controller.abort(new Error('synthetic-private-cancel-reason'));let requests=0;
  const fetchImpl=async()=>{requests++;throw new Error('synthetic-unexpected-request')};
  await assert.rejects(()=>readHistoryContext({signal:controller.signal,fetchImpl}),{code:'REQUEST_CANCELLED',message:'REQUEST_CANCELLED'});
  for(const signal of [null,true,1,'signal',{},[],new AbortController()])await assert.rejects(()=>readHistoryContext({signal,fetchImpl}),{code:'INVALID_SIGNAL'});
  assert.equal(requests,0);
});
test('an uncancelled optional native signal preserves the original history JSON and request sequence',async()=>{
  const one=fixture(),two=fixture();
  const original=await readHistoryContext({fetchImpl:one.fetchImpl});
  assert.deepEqual(await readHistoryContext({fetchImpl:two.fetchImpl,signal:new AbortController().signal}),original);
  assert.deepEqual(two.calls.map(url=>url.href),one.calls.map(url=>url.href));
});

const {bounded,deferred,historyWire,respond,withHttp}=require('./mcp-history-fixture');
for(const phase of ['login','history','proof'])for(const body of [false,true])test(`native history cancellation aborts real ${phase} ${body?'body':'headers'} with bounded session cleanup`,{timeout:10000},async()=>{
  const caller=new AbortController(),started=deferred(),closed=deferred(),wire=historyWire();let independent=false;
  const target=path=>phase==='login'?path==='/api/login':phase==='history'?path.startsWith('/api/projects/7/history?'):path==='/api/projects/7/facts/provenance';
  await withHttp((request,reply)=>{
    if(target(request.path)){
      reply.res.once('close',closed.resolve);
      if(body){reply.res.writeHead(200,{'content-type':'application/json',...(phase==='login'?{'set-cookie':'sid=synthetic-unknown-login; HttpOnly'}:{})});reply.res.write('{"unfinished":')}
      if(!body)started.resolve();return;
    }
    respond(request,reply,wire);
  },async({baseURL,requests})=>{
    const fetchImpl=async(url,options)=>{
      if(new URL(url).pathname==='/api/logout')independent=caller.signal.aborted&&!options.signal.aborted;
      const response=await fetch(url,options);if(body&&target(new URL(url).pathname+new URL(url).search))started.resolve();return response;
    };
    const rejected=assert.rejects(readHistoryContext({baseURL,projectId:7,signal:caller.signal,fetchImpl,timeoutMs:1000,totalTimeoutMs:3000}),error=>error.code==='REQUEST_CANCELLED'&&error.message==='REQUEST_CANCELLED'&&error.cause===undefined);
    await bounded(started.promise,'observing real history cancellation target');caller.abort(new Error('synthetic-private-reason'));
    await rejected;await bounded(closed.promise,'closing cancelled history connection');
    assert.equal(requests.at(-1).path,phase==='login'?'/api/login':'/api/logout');
    assert.equal(requests.length,phase==='login'?1:phase==='history'?3:4);
    if(phase!=='login')assert.equal(independent,true);
  });
});
test('history cancellation during completed read cleanup cannot return data, and failed logout preserves the primary read error',{timeout:10000},async()=>{
  const caller=new AbortController();
  await withHttp((request,reply)=>{
    if(request.path==='/api/logout'){caller.abort(new Error('synthetic-private-late-cancel'));reply.send({ok:true});return}respond(request,reply);
  },async({baseURL})=>{await assert.rejects(()=>readHistoryContext({baseURL,projectId:7,signal:caller.signal}),{code:'REQUEST_CANCELLED'})});
  await withHttp((request,reply)=>{
    if(request.path.includes('/history?'))reply.send({error:'synthetic-private-read-error'},403);
    else if(request.path==='/api/logout')reply.send({error:'synthetic-private-cleanup-error'},500);
    else respond(request,reply);
  },async({baseURL})=>{await assert.rejects(()=>readHistoryContext({baseURL,projectId:7}),{code:'HTTP_403',message:'HTTP_403',status:403})});
});
test('history non-OK and logout401 unfinished bodies close without exposing raw errors',{timeout:10000},async()=>{
  const historyClosed=deferred(),logoutClosed=deferred();
  await withHttp((request,reply)=>{
    if(request.path.includes('/history?')){reply.res.once('close',historyClosed.resolve);reply.res.writeHead(403,{'content-type':'application/json'});reply.res.write('{"error":"synthetic-private-unfinished');return}
    if(request.path==='/api/logout'){reply.res.once('close',logoutClosed.resolve);reply.res.writeHead(401,{'content-type':'application/json'});reply.res.write('{"unfinished":');return}respond(request,reply);
  },async({baseURL})=>{await assert.rejects(()=>readHistoryContext({baseURL,projectId:7}),{code:'HTTP_403',message:'HTTP_403',status:403});await bounded(Promise.all([historyClosed.promise,logoutClosed.promise]),'closing failed history and logout401 bodies')});
});
test('a cancelled history read retains its primary error while independent logout times out',{timeout:10000},async()=>{
  const caller=new AbortController(),started=deferred(),closed=deferred();
  await withHttp((request,reply)=>{
    if(request.path.includes('/history?')){started.resolve();return}
    if(request.path==='/api/logout'){reply.res.once('close',closed.resolve);reply.res.writeHead(200,{'content-type':'application/json'});reply.res.write('{"unfinished":');return}respond(request,reply);
  },async({baseURL,requests})=>{
    const rejected=assert.rejects(readHistoryContext({baseURL,projectId:7,signal:caller.signal,timeoutMs:150,totalTimeoutMs:2000}),{code:'REQUEST_CANCELLED'});
    await bounded(started.promise,'waiting for held historical read');caller.abort();await rejected;await bounded(closed.promise,'bounded independent history logout');assert.equal(requests.at(-1).path,'/api/logout');
  });
});
test('history CLI rejects signal/stdin/unknown arguments before issuing HTTP',{timeout:10000},async()=>{
  const {spawnSync}=require('node:child_process'),path=require('node:path');
  await withHttp(()=>assert.fail('Unsupported CLI input must not call HTTP'),async({baseURL,requests})=>{
    for(const args of [['--stdin'],['--signal','synthetic-private'],['--unknown']]){
      const child=spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/history-context.js'),...args],{env:{MEMZ_BASE_URL:baseURL},input:'{"signal":"synthetic-private"}',encoding:'utf8',timeout:3000});
      assert.equal(child.status,1);assert.equal(child.stdout,'');assert.equal(child.stderr,'INVALID_ARGUMENTS\n');
    }
    assert.equal(requests.length,0);
  });
});
