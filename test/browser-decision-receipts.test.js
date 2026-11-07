// Complete app.js in a VM with a minimal DOM. Actual api/renderCandidate/
// perform/load code runs; five list loaders are explicit read-only stubs.
// Responses are synthetic, with no server, database, browser or commit claim.
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const filename=path.join(__dirname,'../public/app.js'),source=fs.readFileSync(filename,'utf8');
const sourceSha256=crypto.createHash('sha256').update(source).digest('hex');
let businessMockCalls=0,responseBytes=0,writeCalls=0,refreshCalls=0;
const observed=[];
function minimalDOM(){
  let document;
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.textContent='';this.disabled=false;this.hidden=false;this.isConnected=true;this.value='';this.elements={};this.username={value:'owner'};this.password={value:'demo-owner'};this.q={value:''};this.selectedOptions=[]}
    append(...nodes){for(const node of nodes){this.children.push(node);if(node&&typeof node==='object')node.parentElement=this}}
    replaceChildren(...nodes){this.children=[];this.append(...nodes)}
    setAttribute(key,value){this.attributes[key]=String(value)}getAttribute(key){return this.attributes[key]??null}
    focus(){document.activeElement=this}blur(){document.activeElement=document.body}
    contains(node){return node===this||this.children.some(child=>child?.contains?.(node))}
    querySelectorAll(selector){const result=[];for(const child of this.children){if(child?.tagName==='BUTTON'&&(selector==='button'||(selector==='button[data-mutation]'&&child.dataset.mutation)))result.push(child);if(child?.querySelectorAll)result.push(...child.querySelectorAll(selector))}return result}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  }
  const nodes=new Map();
  document={body:new Element('body'),activeElement:null,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),createDocumentFragment:()=>new Element('fragment'),
    querySelector(selector){if(!nodes.has(selector)){const node=new Element(selector.endsWith(' button')?'button':'div');if(selector==='#project'){node.selectedOptions=[Object.assign(new Element('option'),{dataset:{projectName:'Original synthetic project'}})];node.parentElement=new Element('label')}nodes.set(selector,node)}return nodes.get(selector)},
    querySelectorAll(selector){return selector==='#candidates button[data-mutation]'?document.querySelector('#candidates').querySelectorAll('button[data-mutation]'):[]}};
  document.activeElement=document.body;return {document,Element};
}
async function actualDecision({action,receipt,expectedVersion=2,accepted}){
  const {document,Element}=minimalDOM(),calls=[],listCalls=[],feedbackAtRefresh=[];
  let activeTimers=0;
  const timers=new Set();
  const context=vm.createContext({document,console,AbortController,TextDecoder,Uint8Array,FormData,crypto:crypto.webcrypto,location:{reload(){assert.fail('decision must not reload the page')}},
    setTimeout(...args){const timer=setTimeout(...args);timers.add(timer);activeTimers++;return timer},clearTimeout(timer){if(timers.delete(timer))activeTimers--;clearTimeout(timer)},
    fetch:async(url,options={})=>{
      assert.ok(businessMockCalls<40,'fixed suite-wide business mock-call budget');businessMockCalls++;
      const method=options.method||'GET';calls.push({method,path:url});let body,status;
      if(method==='POST'){
        writeCalls++;assert.equal(url,'/api/projects/1/candidates/10/'+action);assert.equal(options.headers['Idempotency-Key'],undefined,'decisions must not acquire creation keys');
        body=receipt;status=200;
      }else{
        refreshCalls++;assert.ok(url.startsWith('/api/projects/1/data?'));feedbackAtRefresh.push(document.querySelector('#candidateFeedback').textContent);
        // No authoritative new candidate row is supplied. A malformed decision
        // must be rejected before this refresh; red baseline returns 503 here.
        body=accepted?{sourceTextIsUntrusted:true,role:'owner'}:{error:'Original synthetic refresh unavailable'};status=accepted?200:503;
      }
      const text=JSON.stringify(body);responseBytes+=Buffer.byteLength(text);assert.ok(responseBytes<128*1024);
      return new Response(text,{status,headers:{'content-type':'application/json'}});
    }});
  try{
    // Evaluate all source, not an extracted/reimplemented event callback.
    vm.runInContext(source,context,{filename});context.listCalls=listCalls;context.expectedVersion=expectedVersion;
    vm.runInContext("csrf='synthetic-csrf';projectId=1;workspaceGeneration=7;data={role:'owner',sourceTextIsUntrusted:true};roleWorkspace=7;acceptedRole='owner';deniedWorkspace=null;for(const name of ['loadFacts','loadHistory','loadCandidates','loadSources','loadAudit'])globalThis[name]=async()=>{listCalls.push(name)};",context);
    const row=new Element('div');document.querySelector('#candidates').append(row);context.row=row;
    vm.runInContext("renderCandidate(row,{id:10,subject:'Original synthetic subject',predicate:'status',value:'Original pending value',expected_version:expectedVersion,source_id:1,source:'Original synthetic source',status:'pending'},'owner',1)",context);
    const button=row.querySelectorAll('button').find(node=>node.textContent===(action==='approve'?'批准':'驳回'));assert.ok(button);
    await button.onclick();
    const result={feedback:document.querySelector('#candidateFeedback').textContent,calls,listCalls,feedbackAtRefresh,pendingRowRetained:row.children[1].textContent==='待审批',activeTimers};
    observed.push({action,expectedVersion,expectedAccepted:accepted,feedback:result.feedback,businessMockCalls:calls.length,refreshCalls:calls.filter(call=>call.method==='GET').length});
    assert.equal(button.getAttribute('aria-busy'),'false');assert.equal(calls.filter(call=>call.method==='POST').length,1,'one explicit decision, no automatic retry');assert.equal(result.activeTimers,0,'actual api releases its request deadline');return result;
  }finally{for(const timer of timers)clearTimeout(timer)}
}
const invalidCases=[
  ['approve rejects the rejection status', 'approve',{status:'rejected',version:3},2],
  ['approve rejects an unrelated version', 'approve',{status:'approved',version:99},2],
  ['approve rejects an empty-object receipt', 'approve',{},2],
  ['reject rejects an approval status', 'reject',{status:'approved',version:3},2],
  ['approve rejects version beyond int32 even when expected+1 agrees', 'approve',{status:'approved',version:2147483648},2147483647]
];
for(const [name,action,receipt,expectedVersion] of invalidCases)test(name,async()=>{
  const result=await actualDecision({action,receipt,expectedVersion,accepted:false});
  assert.match(result.feedback,/回执.*异常/);assert.match(result.feedback,/未确认/);assert.match(result.feedback,/刷新.*核对/);
  assert.doesNotMatch(result.feedback,/批准成功|驳回成功|当前事实已更新|本次操作未修改/);
  assert.equal(result.calls.length,1,'malformed 2xx is not accepted into a refresh/success path');assert.deepEqual(result.listCalls,[]);assert.equal(result.pendingRowRetained,true);
});
test('approve accepts the first version and unused additive metadata',async()=>{
  const result=await actualDecision({action:'approve',receipt:{status:'approved',version:1,unused:'additive'},expectedVersion:0,accepted:true});
  assert.match(result.feedback,/批准成功：本次生成 v1/);assert.equal(result.calls.length,2);assert.equal(result.listCalls.length,5);assert.deepEqual(result.feedbackAtRefresh,['']);
});
test('approve accepts the last representable int32 version',async()=>{
  const result=await actualDecision({action:'approve',receipt:{status:'approved',version:2147483647},expectedVersion:2147483646,accepted:true});
  assert.match(result.feedback,/批准成功：本次生成 v2147483647/);assert.equal(result.calls.length,2);
});
test('reject accepts exact rejected status and does not consume an unused version',async()=>{
  const result=await actualDecision({action:'reject',receipt:{status:'rejected',version:99,unused:'additive'},accepted:true});
  assert.match(result.feedback,/驳回成功：/);assert.doesNotMatch(result.feedback,/v99/);assert.equal(result.calls.length,2);assert.equal(result.listCalls.length,5);
});
after(()=>{
  assert.ok(businessMockCalls<=40);console.log('Synthetic browser decision resources:',JSON.stringify({sourceSha256,businessMockCalls,writeCalls,refreshCalls,responseBytes,observed,mode:'full-source VM/minimal DOM; five independent list loaders stubbed',realServerCommitProven:false,postgresCalls:0,externalNetworkCalls:0,modelCalls:0}));
});
