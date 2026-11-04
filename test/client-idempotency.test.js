const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function client(){
  const requests=[];let serial=0;
  const context=vm.createContext({document:{querySelector:()=>({username:{}})},crypto:{randomUUID:()=>`test-key-${++serial}`},fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,key:options.headers['Idempotency-Key'],resolve,reject}))});
  vm.runInContext(fs.readFileSync('public/app.js','utf8')+'\nglobalThis.clientTest={createRecord,pendingCreations};',context);
  const respond=(index,status=200)=>requests[index].resolve({ok:status<400,status,json:async()=>status<400?{id:index+1}:{error:'controlled rejection'}});
  return {...context.clientTest,requests,respond};
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
