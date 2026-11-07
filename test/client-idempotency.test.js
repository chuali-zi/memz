// Actual browser functions in an isolated VM. Every transport is synthetic:
// these tests make no HTTP/PG/model call and do not prove a real commit.
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const copy=value=>JSON.parse(JSON.stringify(value));
let mockRequests=0;

// Independent input/response examples, rather than a receipt generator derived
// from the validator or the request it is supposed to verify.
function example(operation){
  return operation==='sources'?{
    path:'/api/projects/1/sources',
    body:{title:' \n合成来源  ',content:'\t原创合成正文\r\n'},
    receipt:{id:17,project_id:1,title:'合成来源',content:'原创合成正文'}
  }:{
    path:'/api/projects/1/candidates',
    body:{subject:' 合成任务 ',predicate:'\t状态\n',value:' \n待审\t ',source_id:'00017',expected_version:'0000'},
    receipt:{id:21,project_id:1,subject:'合成任务',predicate:'状态',value:'待审',source_id:17,expected_version:0,proposed_by:2,status:'pending',created_at:'2026-11-07T00:00:00.000Z'}
  };
}
function client(receipt={}){
  const requests=[];let serial=0,reloads=0;
  const context=vm.createContext({TextDecoder,AbortController,setTimeout,clearTimeout,location:{reload:()=>{reloads++}},document:{querySelector:()=>({username:{}})},crypto:{randomUUID:()=>`test-key-${++serial}`},fetch:(url,options)=>new Promise((resolve,reject)=>{mockRequests++;requests.push({url,body:options.body,key:options.headers['Idempotency-Key'],resolve,reject})})});
  vm.runInContext(fs.readFileSync('public/app.js','utf8')+'\nglobalThis.clientTest={createRecord,pendingCreations,switchAccount};',context);
  const respond=(index,status=200,value=status<400?(requests[index].url==='/api/logout'?{ok:true}:copy(receipt)):{error:'controlled rejection'})=>requests[index].resolve(Response.json(value,{status}));
  return {...context.clientTest,requests,respond,reloads:()=>reloads};
}
async function rejected(pending,respond){
  const outcome=pending.then(value=>({ok:true,value}),error=>({ok:false,error}));respond();
  const result=await outcome;assert.equal(result.ok,false,'an unverified or rejected request must not return a creation receipt');return result.error;
}
function keysUnchanged(requests){assert.ok(requests.every(request=>request.key===requests[0].key));assert.ok(requests.every(request=>request.url===requests[0].url&&request.body===requests[0].body),'the same encoded intent is retried')}

for(const oldStatus of [200,400])test(`late ${oldStatus} from old key cannot erase newer uncertain creation key`,async()=>{
  const f=example('sources'),c=client(f.receipt);
  const a=c.createRecord(f.path,f.body),b=c.createRecord(f.path,f.body);
  assert.equal(c.requests[0].key,c.requests[1].key);
  c.respond(0);await a;
  const nextReceipt={id:19,project_id:1,title:'合成来源',content:'原创合成正文'};
  const newer=c.createRecord(f.path,f.body);assert.notEqual(c.requests[2].key,c.requests[0].key);
  if(oldStatus===400)assert.equal((await rejected(b,()=>c.respond(1,400))).status,400);else{c.respond(1);await b}
  const unknown=await rejected(newer,()=>c.requests[2].reject(new Error('synthetic response lost')));assert.match(unknown.message,/网络连接失败/);
  const retry=c.createRecord(f.path,f.body);
  assert.equal(c.requests[3].key,c.requests[2].key,'retry must preserve the newer uncertain key');
  c.respond(3,200,nextReceipt);await retry;assert.equal(c.pendingCreations.size,0);
});
test('the current key clears after verified success or a fresh client rejection',async()=>{
  for(const operation of ['sources','candidates'])for(const status of [200,403,409]){
    const f=example(operation),c=client(f.receipt),first=c.createRecord(f.path,f.body);
    if(status===200){c.respond(0);await first}else assert.equal((await rejected(first,()=>c.respond(0,status))).status,status);
    const next=c.createRecord(f.path,f.body);assert.notEqual(c.requests[0].key,c.requests[1].key);c.respond(1);await next;
    assert.equal(c.pendingCreations.size,0);
  }
});
test('account switching recovers expired sessions without hiding server or network errors',async()=>{
  for(const status of [200,401,403,503]){
    const c=client(),result=c.switchAccount();
    if(status===200||status===401){c.respond(0,status);await result;assert.equal(c.reloads(),1)}
    else{assert.equal((await rejected(result,()=>c.respond(0,status))).status,status);assert.equal(c.reloads(),0)}
  }
  const c=client(),result=c.switchAccount();const error=await rejected(result,()=>c.requests[0].reject(new Error('synthetic network unavailable')));assert.match(error.message,/网络连接失败/);assert.equal(c.reloads(),0);
});

for(const operation of ['sources','candidates'])for(const unknown of ['network','503'])for(const status of [403,409])test(`${operation}: ${unknown} then ${status} retains one key through verified retry`,async()=>{
  const f=example(operation),c=client(f.receipt),first=c.createRecord(f.path,f.body);
  const initial=await rejected(first,()=>unknown==='network'?c.requests[0].reject(new Error('synthetic response lost')):c.respond(0,503));
  assert.match(initial.message,/写入结果可能不确定/);assert.equal(c.pendingCreations.size,1);
  const next=c.createRecord(f.path,f.body),denied=await rejected(next,()=>c.respond(1,status));
  assert.equal(denied.status,status);assert.equal(c.pendingCreations.size,1,'this rejection cannot disprove the earlier unknown attempt');assert.match(denied.message,/写入结果可能不确定/);
  const retry=c.createRecord(f.path,f.body);keysUnchanged(c.requests);c.respond(2);const accepted=await retry;
  assert.equal(accepted.id,f.receipt.id);assert.equal(c.pendingCreations.size,0);
});

const invalidReceipts={
  sources:[
    ['null',()=>null],['empty',()=>({})],['zero id',receipt=>({...receipt,id:0})],['string id',receipt=>({...receipt,id:'17'})],
    ['wrong project',receipt=>({...receipt,project_id:2})],['wrong title',receipt=>({...receipt,title:'SYNTHETIC_INVALID_TITLE'})],
    ['wrong content',receipt=>({...receipt,content:'SYNTHETIC_INVALID_CONTENT'})],['untrimmed title',receipt=>({...receipt,title:' \n合成来源  '})]
  ],
  candidates:[
    ['empty',()=>({})],['zero id',receipt=>({...receipt,id:0})],['wrong project',receipt=>({...receipt,project_id:2})],
    ['wrong source',receipt=>({...receipt,source_id:999})],['string source',receipt=>({...receipt,source_id:'17'})],
    ['wrong expected version',receipt=>({...receipt,expected_version:1})],['wrong value',receipt=>({...receipt,value:'SYNTHETIC_INVALID_VALUE'})],
    ['wrong subject',receipt=>({...receipt,subject:'SYNTHETIC_INVALID_SUBJECT'})],['wrong predicate',receipt=>({...receipt,predicate:'SYNTHETIC_INVALID_PREDICATE'})],
    ['already approved status',receipt=>({...receipt,status:'approved'})]
  ]
};
for(const operation of ['sources','candidates'])for(const [name,invalid] of invalidReceipts[operation])test(`${operation}: unverified 2xx ${name} is unknown and preserves the original key`,async()=>{
  const f=example(operation),c=client(f.receipt),pending=c.createRecord(f.path,f.body);
  const error=await rejected(pending,()=>c.respond(0,200,invalid(copy(f.receipt))));
  assert.equal(error.status,undefined);assert.match(error.message,/回执/);assert.match(error.message,/写入结果可能不确定/);assert.ok(!error.message.includes('SYNTHETIC_INVALID'));
  assert.equal(c.pendingCreations.size,1);
  const retry=c.createRecord(f.path,f.body);keysUnchanged(c.requests);c.respond(1);assert.equal((await retry).id,f.receipt.id);assert.equal(c.pendingCreations.size,0);
});
for(const operation of ['sources','candidates'])test(`${operation}: additive and unused actor/time metadata do not become a verification promise`,async()=>{
  const f=example(operation),c=client(f.receipt),pending=c.createRecord(f.path,f.body);
  c.respond(0,200,{...f.receipt,proposed_by:'unused actor metadata',created_at:'unused timestamp metadata',extra:{synthetic:true}});
  assert.equal((await pending).id,f.receipt.id);assert.equal(c.pendingCreations.size,0);
});
for(const operation of ['sources','candidates'])for(const matchesSent of [true,false])test(`${operation}: receipt binds transmitted JSON after caller mutation (${matchesSent?'original accepted':'mutated rejected'})`,async()=>{
  const f=example(operation),c=client(f.receipt),sent=copy(f.body),pending=c.createRecord(f.path,f.body);
  const mutated=operation==='sources'?{title:'后改标题',content:'后改正文'}:{subject:'后改任务',predicate:'后改属性',value:'后改值',source_id:'99',expected_version:'7'};
  Object.assign(f.body,mutated);
  const mutatedReceipt=operation==='sources'?{id:17,project_id:1,title:'后改标题',content:'后改正文'}:{id:21,project_id:1,subject:'后改任务',predicate:'后改属性',value:'后改值',source_id:99,expected_version:7,status:'pending'};
  if(matchesSent){c.respond(0);assert.equal((await pending).id,f.receipt.id);assert.equal(c.pendingCreations.size,0)}
  else{const error=await rejected(pending,()=>c.respond(0,200,mutatedReceipt));assert.equal(error.status,undefined);assert.match(error.message,/写入结果可能不确定/);assert.equal(c.pendingCreations.size,1)}
  assert.equal(c.requests[0].body,JSON.stringify(sent));
  const retry=c.createRecord(f.path,sent);assert.equal(c.requests[1].body,c.requests[0].body);
  if(matchesSent)assert.notEqual(c.requests[1].key,c.requests[0].key);else assert.equal(c.requests[1].key,c.requests[0].key);
  c.respond(1);await retry;assert.equal(c.pendingCreations.size,0);
});
after(()=>console.log('Synthetic browser idempotency VM:',JSON.stringify({mockRequests,actualHttpRequests:0,databaseQueries:0,modelCalls:0,realCommitNotClaimed:true})));
