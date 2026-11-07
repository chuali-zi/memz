const {test}=require('node:test');
const assert=require('node:assert/strict');
const {planLabelQuery,MAX_LABEL_ROWS}=require('../scripts/label-query-plan');
const {planExactLabelQuery,EXACT_PLANNER_MODE}=require('../scripts/label-query-plan-v2');
const {MAX_CURRENT_LABELS}=require('../scripts/exact-context-protocol');
const labels=[{subject:'晨桥服务',predicate:'交付时间'},{subject:'晨桥服务',predicate:'值班联系人'}];
const question='晨桥服务的交付时间是什么？';
test('v2 emits an explicit literal selector without query, search or a legacy snapshot receipt',()=>{
  const result=planExactLabelQuery({question,labels});
  assert.deepEqual(result,{schemaVersion:1,mode:EXACT_PLANNER_MODE,view:'current',status:'planned',selector:labels[0],template:{connector:'的',ending:'是什么'}});
  for(const key of ['query','search','after','limit'])assert.equal(Object.hasOwn(result,key),false);
  assert.equal(planLabelQuery({question,labels}).search.mode,'all_terms');
});
test('v2 supports 256 and 512 label rows without changing the fixed v1 limit of 25',()=>{
  assert.equal(MAX_LABEL_ROWS,25);assert.equal(MAX_CURRENT_LABELS,512);
  for(const count of [256,512]){
    const rows=Array.from({length:count},(_,i)=>({subject:'合成窗口'+i,predicate:'开放时间'}));
    const input={question:'合成窗口'+(count-1)+'的开放时间是什么？',labels:rows};
    assert.equal(planExactLabelQuery(input).status,'planned');assert.equal(planExactLabelQuery(input).selector.subject,rows.at(-1).subject);
    assert.equal(planLabelQuery(input).status,'needs_scope');
  }
});
test('v2 overflow refuses before reading labels, including duplicate rows or sentinel getters',()=>{
  const rows=new Array(513);Object.defineProperty(rows,0,{get(){throw new Error('OVERFLOW_SENTINEL_MUST_NOT_BE_READ')}});
  const result=planExactLabelQuery({question,labels:rows});assert.equal(result.status,'needs_scope');assert.equal(result.reason,'SCOPE_TOO_LARGE');
  assert.equal(planExactLabelQuery({question,labels:Array(513).fill(labels[0])}).reason,'SCOPE_TOO_LARGE');
});
test('an exact v2 selector does not apply all_terms token limits or alter literal key text',()=>{
  const label={subject:'a b c d e f g h',predicate:'i'},input={question:label.subject+'的i是什么？',labels:[label]};
  assert.deepEqual(planExactLabelQuery(input).selector,label);
  assert.equal(planLabelQuery(input).reason,'KEY_SEARCH_LIMIT');
  const punctuation={subject:"服务[A].*'",predicate:'路径\\+%_😀'};
  assert.deepEqual(planExactLabelQuery({question:punctuation.subject+'的'+punctuation.predicate+'是什么？',labels:[punctuation]}).selector,punctuation);
});
test('v2 retains conservative history, pronoun, unknown, multi-key and ambiguity failures',()=>{
  for(const input of [{question:'晨桥服务最初的交付时间是什么？',labels},{question:'它的交付时间是什么？',labels},{question:'晨桥服务的地点是什么？',labels},{question:'晨桥服务的交付时间和值班联系人是什么？',labels},{question:'甲的乙的丙是什么？',labels:[{subject:'甲',predicate:'乙的丙'},{subject:'甲的乙',predicate:'丙'}]}]){
    const old=planLabelQuery(input),current=planExactLabelQuery(input);assert.equal(current.status,old.status);assert.equal(current.reason,old.reason);assert.equal(Object.hasOwn(current,'selector'),false);
  }
});
test('v2 accepts no evidence or caller policy fields and remains stateless across supplied scopes',()=>{
  for(const name of ['gold','answer','evidence','value','source','projectId','maxRows']){
    const input={question,labels};Object.defineProperty(input,name,{get(){throw new Error('TOP_SENTINEL_MUST_NOT_BE_READ')}});
    assert.throws(()=>planExactLabelQuery(input),{code:'INVALID_PLANNER_INPUT'});
    const label={...labels[0]};Object.defineProperty(label,name,{get(){throw new Error('LABEL_SENTINEL_MUST_NOT_BE_READ')}});
    assert.throws(()=>planExactLabelQuery({question,labels:[label]}),{code:'INVALID_PLANNER_LABEL'});
  }
  assert.equal(planExactLabelQuery({question,labels}).status,'planned');
  assert.equal(planExactLabelQuery({question,labels:[{subject:'晚帆窗口',predicate:'交付时间'}]}).reason,'SUBJECT_REQUIRED');
  assert.equal(planExactLabelQuery({question,labels}).status,'planned');
});
