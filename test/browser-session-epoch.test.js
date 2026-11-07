// Full app.js in an isolated VM. Only DOM/FormData and the five independent
// list loaders are substituted. api/recovery/load/write gates run unchanged.
// All responses are synthetic: no real HTTP, PostgreSQL, model or commit claim.
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const filename=path.join(__dirname,'../public/app.js'),source=fs.readFileSync(filename,'utf8');
const sourceSha256=crypto.createHash('sha256').update(source).digest('hex');
let transports=0,responseBytes=0;
function dom(){
  const nodes=new Map();let document;
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.textContent='';this.disabled=false;this.hidden=false;this.isConnected=true;this.value='';this.fields={};this.username={value:'member'};this.password={value:''};this.q={value:''};this.selectedOptions=[]}
    append(...children){for(const child of children){this.children.push(child);if(child&&typeof child==='object')child.parentElement=this}}
    get firstChild(){return this.children[0]||null}
    replaceChildren(...children){this.children=[];this.append(...children)}
    setAttribute(key,value){this.attributes[key]=String(value)}getAttribute(key){return this.attributes[key]??null}
    focus(){document.activeElement=this}blur(){document.activeElement=document.body}
    contains(child){return child===this||this.children.some(node=>node?.contains?.(child))}
    querySelector(selector){if(selector==='button'){if(!this.button)this.button=new Element('button');return this.button}return null}
    querySelectorAll(){return []}
  }
  document={body:new Element('body'),activeElement:null,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),createDocumentFragment:()=>new Element('fragment'),querySelectorAll:()=>[],
    querySelector(selector){if(!nodes.has(selector)){const node=new Element(selector.endsWith(' button')?'button':'div');if(selector==='#project'){node.parentElement=new Element('label');node.selectedOptions=[Object.assign(new Element('option'),{dataset:{projectName:'Original synthetic project'}})]}nodes.set(selector,node)}return nodes.get(selector)}};
  document.activeElement=document.body;return document;
}
function client(){
  const document=dom(),requests=[],timers=new Set();let serial=0,reloads=0;
  class Fields{constructor(form){this.entries=Object.entries(form.fields)}[Symbol.iterator](){return this.entries[Symbol.iterator]()}}
  const context=vm.createContext({document,AbortController,TextDecoder,Uint8Array,FormData:Fields,crypto:{randomUUID:()=>`owned-synthetic-key-${++serial}`},location:{reload(){reloads++}},
    setTimeout(...args){const timer=setTimeout(...args);timers.add(timer);return timer},clearTimeout(timer){timers.delete(timer);clearTimeout(timer)},
    fetch(url,options={}){assert.ok(++transports<=80,'fixed suite-wide synthetic transport budget');return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))}});
  vm.runInContext(source,context,{filename});
  vm.runInContext("csrf='synthetic-original-token';acceptedUsername='member';sessionEpoch=4;sessionRecoveryRequired=false;sessionAccessPending=false;projectId=1;workspaceGeneration=7;data={role:'owner',sourceTextIsUntrusted:true};acceptedRole='owner';roleWorkspace=7;deniedWorkspace=null;selectedSource={id:17,title:'Original synthetic source',project:1};for(const name of ['loadFacts','loadHistory','loadCandidates','loadSources','loadAudit'])globalThis[name]=async()=>{};$('#identity').replaceChildren(document.createTextNode('Original synthetic account'));",context);
  document.querySelector('#sessionRecoveryForm').fields={password:'synthetic-password',username:'untrusted-other-account'};
  document.querySelector('#sessionRecoveryForm').password.value='synthetic-password';
  function respond(index,status,value){const text=JSON.stringify(value);responseBytes+=Buffer.byteLength(text);assert.ok(responseBytes<128*1024);requests[index].resolve(new Response(text,{status,headers:{'content-type':'application/json'}}))}
  return {document,requests,respond,run:code=>vm.runInContext(code,context),
    api:(...args)=>vm.runInContext('api',context)(...args),
    recover:()=>{const form=document.querySelector('#sessionRecoveryForm');form.password.value='synthetic-password';return form.onsubmit({preventDefault(){},target:form})},
    state:()=>JSON.parse(vm.runInContext("JSON.stringify({csrf,acceptedUsername,sessionEpoch,sessionRecoveryRequired,sessionAccessPending,keys:[...pendingCreations],uncertain:[...uncertainCreationKeys],selectedSource,problem:writeProblem(),retainedOwnerProblem:writeProblem(true,1,7,true),notice:$('#notice').textContent,sourceFeedback:$('#sourceFeedback').textContent,identity:$('#identity').children.map(node=>node.textContent).join('')})",context)),
    close(){for(const timer of timers)clearTimeout(timer);timers.clear();assert.equal(reloads,0,'same-account recovery must not reload or lose page state')}
  };
}
const settle=promise=>promise.then(value=>({ok:true,value}),error=>({ok:false,status:error.status,message:error.message}));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function waitRequest(c,index){for(let attempt=0;attempt<30&&!c.requests[index];attempt++)await tick();assert.ok(c.requests[index],'actual async path must issue its next request')}
async function expire(c){const index=c.requests.length,pending=settle(c.api('/api/projects/1/data'));c.respond(index,401,{error:'Synthetic session expired'});assert.equal((await pending).status,401);assert.equal(c.state().sessionRecoveryRequired,true);assert.ok(c.state().problem)}
async function uncertainSource(c){const index=c.requests.length,pending=settle(c.run("createRecord('/api/projects/1/sources',{title:'Original synthetic source',content:'Original synthetic content'})"));c.requests[index].reject(new Error('Synthetic response lost'));const error=await pending;assert.equal(error.ok,false);c.run('message('+JSON.stringify(error.message)+",'#sourceFeedback')");assert.match(c.state().sourceFeedback,/写入结果可能不确定/);assert.equal(c.state().keys.length,1)}
async function recovered(c,status=200,value={role:'member',sourceTextIsUntrusted:true}){const index=c.requests.length,pending=c.recover();await waitRequest(c,index);assert.equal(c.requests[index].url,'/api/login');assert.equal(JSON.parse(c.requests[index].options.body).username,'member','only the originally accepted account can be reauthenticated');c.respond(index,200,{name:'Original synthetic account',csrf:'synthetic/opaque:token~A'});await waitRequest(c,index+1);assert.match(c.requests[index+1].url,/^\/api\/projects\/1\/data\?/);assert.ok(c.requests[index+1].options.headers['X-CSRF-Token']==='synthetic/opaque:token~A','accepted opaque token is transmitted unchanged');c.respond(index+1,status,value);await pending}

test('complete current-session project 401 locks writes without erasing unknown creation state',async()=>{
  const c=client();try{await uncertainSource(c);const before=c.state();await expire(c);const after=c.state();assert.ok(JSON.stringify(after.keys)===JSON.stringify(before.keys),'the same uncertain intent/key must remain');assert.ok(JSON.stringify(after.uncertain)===JSON.stringify(before.uncertain),'uncertainty must remain attached to the same key');assert.equal(after.sourceFeedback,before.sourceFeedback);assert.deepEqual(after.selectedSource,before.selectedSource);assert.ok(after.retainedOwnerProblem,'retained owner actions are paused too');for(const selector of ['#sourceForm button','#proposal button','#stale','#injection'])assert.equal(c.document.querySelector(selector).disabled,true)}finally{c.close()}
});
test('login/logout 401 and incomplete project errors do not become a global recovery lock',async()=>{
  const c=client();try{for(const route of ['/api/login','/api/logout']){const index=c.requests.length,pending=settle(c.api(route,{method:'POST'}));c.respond(index,401,{error:'Synthetic authentication rejection'});assert.equal((await pending).status,401);assert.equal(c.state().sessionRecoveryRequired,false)}
    const index=c.requests.length,pending=settle(c.api('/api/projects/1/data'));c.requests[index].resolve(new Response('{',{status:401}));assert.equal((await pending).ok,false);assert.equal(c.state().sessionRecoveryRequired,false);assert.equal(c.state().problem,'');
  }finally{c.close()}
});
test('late old-session 401 cannot relock a newly verified session or erase original uncertainty',async()=>{
  const c=client();try{await uncertainSource(c);const before=c.state(),oldIndex=c.requests.length,old=settle(c.api('/api/projects/1/facts'));await expire(c);await recovered(c);const accepted=c.state();assert.equal(accepted.sessionRecoveryRequired,false);assert.equal(accepted.sessionAccessPending,false);assert.equal(accepted.problem,'');assert.ok(accepted.sessionEpoch>before.sessionEpoch);c.respond(oldIndex,401,{error:'Synthetic stale response'});assert.equal((await old).status,401);assert.equal(c.state().sessionRecoveryRequired,false);assert.equal(c.state().sessionEpoch,accepted.sessionEpoch);assert.ok(JSON.stringify(c.state().keys)===JSON.stringify(before.keys),'stale 401 cannot change the preserved key');assert.equal(c.state().sourceFeedback,before.sourceFeedback)}finally{c.close()}
});
for(const [name,receipt] of [['missing token',{name:'Original synthetic account'}],['header-unsafe token',{name:'Original synthetic account',csrf:'bad\nheader'}],['invalid identity',{name:[],csrf:'synthetic-new-token'}]])test(`invalid recovery receipt (${name}) cannot replace identity, token or uncertain key`,async()=>{
  const c=client();try{await uncertainSource(c);await expire(c);const before=c.state(),index=c.requests.length,pending=c.recover();await waitRequest(c,index);c.respond(index,200,receipt);await pending;const after=c.state();assert.ok(after.csrf===before.csrf,'an invalid receipt must not change the accepted token');assert.equal(after.acceptedUsername,before.acceptedUsername);assert.ok(after.identity===before.identity,'invalid login must not change the displayed identity');assert.equal(after.sessionEpoch,before.sessionEpoch);assert.equal(after.sessionRecoveryRequired,true);assert.ok(JSON.stringify(after.keys)===JSON.stringify(before.keys),'the same uncertain intent/key must remain');assert.equal(after.sourceFeedback,before.sourceFeedback);assert.equal(c.requests.length,index+1,'invalid login must not start a project refresh');assert.match(c.document.querySelector('#sessionFeedback').textContent,/回执/)}finally{c.close()}
});
for(const [name,status,receipt] of [['503',503,{error:'Synthetic project unavailable'}],['403',403,{error:'Synthetic project denied'}],['viewer',200,{role:'viewer',sourceTextIsUntrusted:true}]])test(`valid same-account login followed by fresh ${name} does not unlock writes`,async()=>{
  const c=client();try{await uncertainSource(c);await expire(c);const before=c.state();await recovered(c,status,receipt);const after=c.state();assert.ok(after.csrf!==before.csrf,'a valid login may rotate the token');assert.equal(after.acceptedUsername,'member');assert.ok(after.problem,'reauthentication alone must not grant a write role');assert.equal(c.document.querySelector('#sourceForm button').disabled,true);assert.equal(c.document.querySelector('#stale').disabled,true);assert.ok(JSON.stringify(after.keys)===JSON.stringify(before.keys),'the same uncertain intent/key must remain');assert.equal(after.sourceFeedback,before.sourceFeedback);assert.deepEqual(after.selectedSource,before.selectedSource)}finally{c.close()}
});
test('valid same-account login still waits for a fresh writable project receipt',async()=>{
  const c=client();try{await expire(c);const index=c.requests.length,pending=c.recover();await waitRequest(c,index);c.respond(index,200,{name:'Original synthetic account',csrf:'synthetic/opaque:token~A'});await waitRequest(c,index+1);assert.equal(c.state().sessionRecoveryRequired,false);assert.equal(c.state().sessionAccessPending,true);assert.ok(c.state().problem);c.respond(index+1,200,{role:'member',sourceTextIsUntrusted:true});await pending;assert.equal(c.state().sessionAccessPending,false);assert.equal(c.state().problem,'');assert.equal(c.document.querySelector('#sourceForm button').disabled,false)}finally{c.close()}
});
after(()=>console.log('Synthetic session epoch resources:',JSON.stringify({sourceSha256,syntheticTransports:transports,responseBytes,realHttpRequests:0,postgresQueries:0,modelCalls:0,scope:'full app source; minimal DOM/FormData, five list loaders stubbed; no real session/commit proof'})));
