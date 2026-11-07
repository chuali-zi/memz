const {test}=require('node:test');
const assert=require('node:assert/strict');
const {page,sampleFacts}=require('./label-context-fixture');
const {validateSnapshot}=require('../scripts/context-snapshot');
const {
  CURRENT_LABELS_SCHEMA,CURRENT_LABELS_CONSISTENCY,EXACT_CONTEXT_SCHEMA,EXACT_CONTEXT_CONSISTENCY,
  MAX_CURRENT_LABELS,CURRENT_LABELS_MAX_BYTES,EXACT_CONTEXT_MAX_BYTES,
  currentLabelsReceipt,exactContextReceipt,validateExactSelector,validateExactContextRequest,validateCurrentLabels,validateExactContext
}=require('../scripts/exact-context-protocol');
const selector={subject:'晨桥服务',predicate:'交付时间'};
const labelsWire=({labels=[selector],complete=true}={})=>({...currentLabelsReceipt(),projectId:7,role:'viewer',sourceTextIsUntrusted:true,limit:512,complete,labels});
function exactWire({empty=false,key=selector}={}){
  const snapshot=page({facts:empty?[]:[{...sampleFacts[0],subject:key.subject,predicate:key.predicate}]});
  return {...exactContextReceipt(),projectId:7,selector:{...key},role:'viewer',sourceTextIsUntrusted:true,facts:snapshot.facts,provenance:snapshot.provenance,sources:snapshot.sources};
}
const invalidLabels=value=>assert.throws(()=>validateCurrentLabels(value,{projectId:7}),{code:'INVALID_CURRENT_LABELS_RESPONSE'});
const invalidExact=(value,expected=selector)=>assert.throws(()=>validateExactContext(value,{projectId:7,selector:expected}),{code:'INVALID_EXACT_CONTEXT_RESPONSE'});

test('current labels have a separate project-bound metadata receipt and exactly fixed caps',()=>{
  assert.equal(MAX_CURRENT_LABELS,512);assert.equal(CURRENT_LABELS_MAX_BYTES,1048576);assert.equal(EXACT_CONTEXT_MAX_BYTES,1048576);
  assert.deepEqual(currentLabelsReceipt(),{schema:CURRENT_LABELS_SCHEMA,consistency:CURRENT_LABELS_CONSISTENCY});
  const wire=labelsWire();assert.equal(validateCurrentLabels(wire,{projectId:7}),wire);
  assert.equal(Object.hasOwn(wire,'query'),false);assert.equal(Object.hasOwn(wire,'sources'),false);
  for(const role of ['owner','member','viewer'])assert.equal(validateCurrentLabels({...wire,role},{projectId:7}).role,role);
  for(const changes of [{schema:'memz-context-snapshot-v1'},{consistency:'single-page-repeatable-read'},{projectId:8},{projectId:'7'},{role:'admin'},{sourceTextIsUntrusted:false},{limit:25},{complete:'true'},{query:''},{next_after:null}])invalidLabels({...wire,...changes});
});
test('empty complete and incomplete metadata are distinct, and incomplete metadata never contains a prefix',()=>{
  for(const complete of [true,false])assert.equal(validateCurrentLabels(labelsWire({labels:[],complete}),{projectId:7}).complete,complete);
  invalidLabels(labelsWire({complete:false}));
  const labels=Array.from({length:512},(_,i)=>({subject:'服务'+i,predicate:'字段'}));
  assert.equal(validateCurrentLabels(labelsWire({labels}),{projectId:7}).labels.length,512);
  const overflow=new Array(513);Object.defineProperty(overflow,0,{get(){throw new Error('OVERFLOW_SENTINEL_MUST_NOT_BE_READ')}});
  invalidLabels(labelsWire({labels:overflow}));
});
test('metadata labels are unique strict text pairs with no values, source data, gold or hidden fields',()=>{
  for(const labels of [[selector,selector],[{subject:'晨桥服务'}],[{...selector,predicate:''}],[{...selector,subject:'x'.repeat(101)}],[{...selector,predicate:'前\0后'}],[{...selector,predicate:'前\ud800后'}]])invalidLabels(labelsWire({labels}));
  for(const key of ['value','source','evidence','answer','gold']){
    for(const target of ['root','label']){
      const wire=labelsWire({labels:[{...selector}]});
      Object.defineProperty(target==='root'?wire:wire.labels[0],key,{get(){throw new Error('SENTINEL_MUST_NOT_BE_READ')}});
      invalidLabels(wire);
    }
  }
  invalidLabels(labelsWire({labels:[{...selector,[Symbol('gold')]:'sentinel'}]}));
  assert.equal(validateCurrentLabels(labelsWire({labels:[{subject:'gold',predicate:'evidence'}]}),{projectId:7}).labels[0].subject,'gold');
});
test('bounded metadata with maximally escaped valid labels remains below the one MiB wire cap',()=>{
  const labels=Array.from({length:512},(_,i)=>({subject:'\u0001'.repeat(100),predicate:'p'+String(i).padStart(3,'0')+'\u0001'.repeat(96)}));
  const wire=labelsWire({labels});assert.equal(validateCurrentLabels(wire,{projectId:7}).labels.length,512);
  assert.ok(Buffer.byteLength(JSON.stringify(wire),'utf8')<CURRENT_LABELS_MAX_BYTES);
});
test('selectors and readonly request envelopes preserve exact literal text without normalization',()=>{
  for(const key of [selector,{subject:" 服务[A].*' ",predicate:'字段\\+%_😀'},{subject:'a b c d e f g h',predicate:'i'},{subject:'é',predicate:'e\u0301'}]){
    assert.deepEqual(validateExactSelector(key),key);assert.deepEqual(validateExactContextRequest({selector:key}),key);
    assert.notEqual(validateExactSelector(key),key);
  }
  for(const key of [null,[],{}, {subject:'a'}, {...selector,gold:'sentinel'}, {subject:1,predicate:'x'}, {subject:' ',predicate:'x'}, {subject:'x',predicate:'x'.repeat(101)}, {subject:'前\ud800后',predicate:'x'}])assert.throws(()=>validateExactSelector(key),{code:'INVALID_EXACT_SELECTOR'});
  for(const body of [null,[],selector,{selector,value:'sentinel'},{selector,projectId:7},{selector,query:''},{selector,limit:1}])assert.throws(()=>validateExactContextRequest(body),{code:'INVALID_EXACT_SELECTOR'});
});
test('exact context has its own selector receipt and retains the complete existing evidence contract',()=>{
  assert.deepEqual(exactContextReceipt(),{schema:EXACT_CONTEXT_SCHEMA,consistency:EXACT_CONTEXT_CONSISTENCY});
  const wire=exactWire(),proofs=validateExactContext(wire,{projectId:7,selector});
  assert.equal(proofs.length,1);assert.deepEqual(proofs[0].source,wire.sources[0]);assert.equal(proofs[0].revision.id,wire.facts[0].revisionId);
  assert.deepEqual(validateExactContext(exactWire({empty:true}),{projectId:7,selector}),[]);
  for(const changes of [{schema:'memz-context-snapshot-v1'},{consistency:'single-page-repeatable-read'},{projectId:8},{projectId:'7'},{role:'admin'},{sourceTextIsUntrusted:false},{selector:{...selector,predicate:'值字段碰巧命中'}},{query:''},{search:{mode:'all_terms'}},{limit:1},{after:0},{next_after:null}])invalidExact({...wire,...changes});
  assert.throws(()=>validateSnapshot(wire,{projectId:7,query:'',limit:1,after:0,search:null}),{code:'INVALID_SNAPSHOT_RESPONSE'});
  invalidExact(page({facts:[sampleFacts[0]],limit:1}));
});
test('selector binding is case- and normalization-sensitive even with otherwise coherent provenance',()=>{
  const other={subject:'同项目其他事实',predicate:'交付时间'},wire=exactWire({key:other});
  wire.selector={...selector};invalidExact(wire);
  invalidExact(exactWire({key:{subject:'Service',predicate:'字段'}}),{subject:'service',predicate:'字段'});
  invalidExact(exactWire({key:{subject:'é',predicate:'字段'}}),{subject:'e\u0301',predicate:'字段'});
});
test('missing, mismatched or additional exact evidence fails rather than becoming not-found',()=>{
  for(const change of [
    wire=>{wire.provenance=[]},wire=>{wire.sources=[]},wire=>{wire.provenance[0].revision.value='wrong'},wire=>{wire.provenance[0].candidate.expected_version=99},
    wire=>{wire.provenance[0].role='owner'},wire=>{wire.facts[0].revisionId=999},wire=>{wire.sources[0].content='前\ud800后'},wire=>{wire.sources[0].content='x'.repeat(4001)},
    wire=>{wire.provenance[0].revision.created_at='not a date'},wire=>{wire.provenance[0].revision.approved_by=0},wire=>{wire.provenance[0].candidate.proposed_by=0}
  ]){const wire=exactWire();change(wire);invalidExact(wire)}
  const extra=exactWire({empty:true});extra.sources=[exactWire().sources[0]];invalidExact(extra);
  const multiple=exactWire();multiple.facts.push({...multiple.facts[0],id:9});invalidExact(multiple);
});
test('new exact nested structures reject hidden or unknown data fields without changing legacy header policy',()=>{
  for(const target of ['selector','fact','proof','proofFact','revision','candidate','source']){
    const wire=exactWire();
    const objects={selector:wire.selector,fact:wire.facts[0],proof:wire.provenance[0],proofFact:wire.provenance[0].fact,revision:wire.provenance[0].revision,candidate:wire.provenance[0].candidate,source:wire.sources[0]};
    Object.defineProperty(objects[target],'gold',{get(){throw new Error('HIDDEN_SENTINEL_MUST_NOT_BE_READ')}});invalidExact(wire);
  }
  const legacy=page({facts:[sampleFacts[0]],query:'原查询',after:0,limit:25});
  const expected={projectId:7,query:'原查询',limit:25,after:0,search:null};
  assert.equal(validateSnapshot(legacy,expected).length,1);
  for(const changes of [{query:''},{after:1},{limit:1},{schema:EXACT_CONTEXT_SCHEMA},{selector}])assert.throws(()=>validateSnapshot({...legacy,...changes},expected),{code:'INVALID_SNAPSHOT_RESPONSE'});
});
