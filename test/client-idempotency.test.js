const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function client(){
  const requests=[];let serial=0,reloads=0;
  const context=vm.createContext({location:{reload:()=>{reloads++}},document:{querySelector:()=>({username:{}})},crypto:{randomUUID:()=>`test-key-${++serial}`},fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,key:options.headers['Idempotency-Key'],resolve,reject}))});
  vm.runInContext(fs.readFileSync('public/app.js','utf8')+'\nglobalThis.clientTest={createRecord,pendingCreations,switchAccount};',context);
  const respond=(index,status=200)=>requests[index].resolve({ok:status<400,status,json:async()=>status<400?{id:index+1}:{error:'controlled rejection'}});
  return {...context.clientTest,requests,respond,reloads:()=>reloads};
}
for(const oldStatus of [200,400])test(`late ${oldStatus} from old key cannot erase newer uncertain creation key`,async()=>{
  const {createRecord,requests,respond}=client(),path='/api/projects/1/sources',body={title:'same intent',content:'synthetic'};
  const a=createRecord(path,body),b=createRecord(path,body);
  assert.equal(requests[0].key,requests[1].key);
  respond(0);await a;
  const c=createRecord(path,body);assert.notEqual(requests[2].key,requests[0].key);
  if(oldStatus===400){const rejection=assert.rejects(b,/400/);respond(1,400);await rejection}else{respond(1);await b}
  const uncertain=assert.rejects(c,/response lost/);requests[2].reject(new Error('response lost'));await uncertain;
  const retry=createRecord(path,body);
  assert.equal(requests[3].key,requests[2].key,'retry must preserve the key belonging to the newer failed response');
  respond(3);await retry;
});
test('the current key still clears on success or definitive client rejection',async()=>{
  for(const status of [200,409]){
    const {createRecord,requests,respond}=client();const first=createRecord('/sources',{title:'x'});
    if(status===409){const rejection=assert.rejects(first,/409/);respond(0,409);await rejection}else{respond(0);await first}
    const next=createRecord('/sources',{title:'x'});assert.notEqual(requests[0].key,requests[1].key);respond(1);await next;
  }
});

test('account switching recovers expired sessions without hiding server or network errors',async()=>{
  for(const status of [200,401,403,503]){
    const c=client(),result=c.switchAccount();
    if(status===200||status===401){c.respond(0,status);await result;assert.equal(c.reloads(),1)}
    else{const rejected=assert.rejects(result,new RegExp(String(status)));c.respond(0,status);await rejected;assert.equal(c.reloads(),0)}
  }
  const c=client(),result=c.switchAccount(),rejected=assert.rejects(result,/network unavailable/);
  c.requests[0].reject(new Error('network unavailable'));await rejected;assert.equal(c.reloads(),0);
});
