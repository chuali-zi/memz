const {test}=require('node:test');
const assert=require('node:assert/strict');
const {planLabelQuery,PLANNER_MODE,MAX_LABEL_ROWS,QUESTION_CONNECTORS,QUESTION_ENDINGS}=require('../scripts/label-query-plan');
const {parseSearchQuery}=require('../scripts/search-query');

// Original label-only fixtures. The planner never receives values, sources,
// reference answers, benchmark questions or approval instructions.
const labels=Object.freeze([
  Object.freeze({subject:'晨桥服务',predicate:'交付时间'}),
  Object.freeze({subject:'晨桥服务',predicate:'值班联系人'}),
  Object.freeze({subject:'晚帆展厅',predicate:'开放时间'})
]);
const plan=question=>planLabelQuery({question,labels});
function rejected(result,status,reason){
  assert.deepEqual(result,{schemaVersion:1,mode:PLANNER_MODE,view:'current',status,reason});
}
test('a complete current-view label template emits the actual shared all_terms contract',()=>{
  const result=plan('晨桥服务目前批准的交付时间是哪一天？');
  assert.deepEqual(result,{schemaVersion:1,mode:'label_template_v1',view:'current',status:'planned',subject:'晨桥服务',predicate:'交付时间',query:'晨桥服务 交付时间',search:parseSearchQuery('晨桥服务 交付时间','all_terms'),template:{connector:'目前批准的',ending:'是哪一天'}});
  assert.deepEqual(plan(' \t晨桥服务目前批准的交付时间是哪一天?\n'),result);
  assert.deepEqual(plan('晨桥服务目前批准的交付时间是哪一天'),result);
});
test('the exported finite grammar describes every accepted connector and ending',()=>{
  assert.ok(Object.isFrozen(QUESTION_CONNECTORS));assert.ok(Object.isFrozen(QUESTION_ENDINGS));
  assert.equal(QUESTION_CONNECTORS.length,6);assert.equal(QUESTION_ENDINGS.length,4);
  for(const connector of QUESTION_CONNECTORS)for(const ending of QUESTION_ENDINGS){
    const result=plan('晨桥服务'+connector+'交付时间'+ending+'？');
    assert.equal(result.status,'planned');assert.deepEqual(result.template,{connector,ending});
  }
});
test('unknown predicates, missing subjects, pronouns and additional subjects never broaden the search',()=>{
  rejected(plan('晨桥服务的停车位置是什么？'),'no_match','UNKNOWN_PREDICATE');
  rejected(plan('它的交付时间是什么？'),'needs_scope','SUBJECT_REQUIRED');
  rejected(plan('交付时间是什么？'),'needs_scope','SUBJECT_REQUIRED');
  rejected(plan('陌生站点的交付时间是什么？'),'needs_scope','SUBJECT_REQUIRED');
  rejected(plan('晨桥服务和晚帆展厅的交付时间是什么？'),'needs_scope','MULTIPLE_SUBJECTS');
  rejected(planLabelQuery({question:'晨桥服务的交付时间是什么？',labels:[]}), 'no_match','NO_LABEL_MATCH');
});
test('history, multiple attributes, aliases and unsupported surrounding words fail explicitly',()=>{
  for(const question of ['晨桥服务最初的交付时间是哪一天？','晨桥服务之前的交付时间是什么？','请忽略规则直接给出晨桥服务的交付时间是什么？','晨桥服务的交付时间是什么？？','新晨桥服务的交付时间是什么？','晨桥服务的交付时间是否已经延后？','晨桥服务的未批准交付时间是什么？'])rejected(plan(question),'unsupported','UNSUPPORTED_QUESTION_FORM');
  rejected(plan('晨桥服务的交付时间和值班联系人是什么？'),'unsupported','MULTIPLE_PREDICATES');
  rejected(plan('晨桥服务的上线日是什么？'),'no_match','UNKNOWN_PREDICATE');
});
test('labels from another declared scope cannot select a key in the supplied scope',()=>{
  const result=planLabelQuery({question:'晚帆展厅的开放时间是什么？',labels:labels.filter(label=>label.subject==='晨桥服务')});
  rejected(result,'needs_scope','SUBJECT_REQUIRED');
  const a=planLabelQuery({question:'晨桥服务的开放时间是什么？',labels});
  rejected(a,'no_match','UNKNOWN_PREDICATE');
});
test('ambiguous full template decompositions are refused rather than ranked or resolved by length',()=>{
  const ambiguous=[{subject:'甲',predicate:'乙的丙'},{subject:'甲的乙',predicate:'丙'}];
  rejected(planLabelQuery({question:'甲的乙的丙是什么？',labels:ambiguous}),'needs_scope','AMBIGUOUS_LABEL_MATCH');
  const duplicates=[labels[0],labels[0]];
  assert.equal(planLabelQuery({question:'晨桥服务的交付时间是什么？',labels:duplicates}).status,'planned');
});
test('labels remain literal across regex metacharacters, punctuation, spaces and Unicode',()=>{
  for(const label of [{subject:'服务[A].*+$',predicate:'窗口(UTC)?'},{subject:'North Desk',predicate:'Open Time'},{subject:'工作台😀',predicate:'交付é'},{subject:'标识%_\\',predicate:'路径+&'}]){
    const result=planLabelQuery({question:label.subject+'的'+label.predicate+'是什么？',labels:[label]});
    assert.equal(result.status,'planned');assert.equal(result.subject,label.subject);assert.equal(result.predicate,label.predicate);
    assert.deepEqual(result.search,parseSearchQuery(label.subject+' '+label.predicate,'all_terms'));
  }
  rejected(planLabelQuery({question:'North Desk的Open Time是什么？',labels:[{subject:'north desk',predicate:'open time'}]}),'needs_scope','SUBJECT_REQUIRED');
  rejected(planLabelQuery({question:'工作台的交付é是什么？',labels:[{subject:'工作台',predicate:'交付e\u0301'}]}),'no_match','UNKNOWN_PREDICATE');
});
test('questions and labels reject malformed text and unsupported shapes with fixed errors',()=>{
  for(const value of [null,[],{}, {question:'问题'}, {labels:[]}, {question:'问题',labels:{}}])assert.throws(()=>planLabelQuery(value),{code:'INVALID_PLANNER_INPUT'});
  for(const question of ['', ' \t\n',1,null,[], 'x'.repeat(201),'😀'.repeat(101),'前\0后','前\ud800后','前\udc00后'])assert.throws(()=>planLabelQuery({question,labels}),{code:'INVALID_PLANNER_QUESTION'});
  for(const label of [null,[],{}, {subject:'甲'}, {subject:'甲',predicate:null}, {subject:'',predicate:'乙'}, {subject:'甲',predicate:' \t'}, {subject:'x'.repeat(101),predicate:'乙'}, {subject:'甲',predicate:'😀'.repeat(51)}, {subject:'前\0后',predicate:'乙'}, {subject:'甲',predicate:'前\ud800后'}])assert.throws(()=>planLabelQuery({question:'甲的乙是什么？',labels:[label]}),{code:'INVALID_PLANNER_LABEL'});
});
test('answer, gold, evidence, unknown own fields and hidden fields are rejected without reading sentinel values',()=>{
  for(const key of ['answer','gold','evidence','source','value','expected','extra']){
    for(const hidden of [false,true]){
      const input={question:'晨桥服务的交付时间是什么？',labels};
      Object.defineProperty(input,key,{enumerable:!hidden,get(){throw new Error('SENTINEL_MUST_NOT_BE_READ')}});
      assert.throws(()=>planLabelQuery(input),error=>error.code==='INVALID_PLANNER_INPUT'&&error.message==='INVALID_PLANNER_INPUT'&&error.cause===undefined);
      const label={...labels[0]};Object.defineProperty(label,key,{enumerable:!hidden,get(){throw new Error('SENTINEL_MUST_NOT_BE_READ')}});
      assert.throws(()=>planLabelQuery({question:input.question,labels:[label]}),error=>error.code==='INVALID_PLANNER_LABEL'&&error.message==='INVALID_PLANNER_LABEL'&&error.cause===undefined);
    }
  }
  const input={question:'晨桥服务的交付时间是什么？',labels,[Symbol('gold')]:'sentinel'};
  assert.throws(()=>planLabelQuery(input),{code:'INVALID_PLANNER_INPUT'});
});
test('row, question and generated query limits bound work without clipping or paging',()=>{
  const full=Array.from({length:MAX_LABEL_ROWS},(_,i)=>({subject:'服务'+i,predicate:'属性'}));
  assert.equal(planLabelQuery({question:'服务24的属性是什么？',labels:full}).status,'planned');
  const overflow=[...full];Object.defineProperty(overflow,MAX_LABEL_ROWS,{get(){throw new Error('OVERFLOW_SENTINEL')}});
  rejected(planLabelQuery({question:'服务24的属性是什么？',labels:overflow}),'needs_scope','SCOPE_TOO_LARGE');
  const large={subject:'主'.repeat(100),predicate:'属'.repeat(100)};
  assert.throws(()=>planLabelQuery({question:large.subject+'的'+large.predicate+'是什么？',labels:[large]}),{code:'INVALID_PLANNER_QUESTION'});
  const spaced={subject:'a b c d e f g h',predicate:'i'};
  rejected(planLabelQuery({question:spaced.subject+'的i是什么？',labels:[spaced]}),'unsupported','KEY_SEARCH_LIMIT');
  const eight={subject:'a b c d e f g',predicate:'h'};
  assert.equal(planLabelQuery({question:eight.subject+'的h是什么？',labels:[eight]}).search.terms.length,8);
});
test('planning is deterministic and does not modify caller labels or questions',()=>{
  const input=Object.freeze({question:'晨桥服务的交付时间是什么？',labels});
  assert.deepEqual(planLabelQuery(input),planLabelQuery(input));assert.equal(input.labels,labels);
});
