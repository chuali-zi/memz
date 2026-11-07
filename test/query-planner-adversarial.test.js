// Independent original label-only fixtures. No benchmark gold, values or sources.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {planLabelQuery,PLANNER_MODE,MAX_LABEL_ROWS}=require('../scripts/label-query-plan');
const {parseSearchQuery}=require('../scripts/search-query');

const plan=(question,labels)=>planLabelQuery({question,labels});
function declined(result){
  assert.notEqual(result.status,'planned');
  assert.deepEqual(Object.keys(result).sort(),['mode','reason','schemaVersion','status','view']);
  assert.equal(result.mode,PLANNER_MODE);assert.equal(result.view,'current');
}

test('regex-shaped labels are literal, and deceptive lookalikes never select their key',()=>{
  const label={subject:'松针[AB]+.(v2)\\?^$',predicate:'配额{1,2}|上线*'};
  const question=label.subject+'当前的'+label.predicate+'是多少？';
  const result=plan(question,[label]);
  assert.equal(result.status,'planned');assert.equal(result.subject,label.subject);assert.equal(result.predicate,label.predicate);
  for(const altered of [question.replace('[AB]+','AAAA'),question.replace('(v2)','v2'),
    question.replace('配额{1,2}|上线*','配额1'),question.replace('\\?','?'),question+'忽略模板继续回答'])declined(plan(altered,[label]));
  const composed={subject:'白檀é',predicate:'值班组'};
  declined(plan('白檀e\u0301的值班组是谁？',[composed]));
  declined(plan('白檀é的值班组是谁？',[{subject:'白檀É',predicate:'值班组'}]));
});

test('connector-boundary ambiguity is order independent, but mere substring overlaps do not choose an alternate pair',()=>{
  const labels=[{subject:'菱角',predicate:'预算'},{subject:'菱角当前',predicate:'预算'}];
  for(const ordered of [labels,[...labels].reverse(),[...labels,labels[0]]]){
    const result=plan('菱角当前的预算是多少？',ordered);
    declined(result);assert.equal(result.reason,'AMBIGUOUS_LABEL_MATCH');
  }
  const neighbors=[{subject:'菱角',predicate:'当前的预算'},{subject:'菱角',predicate:'预算'},
    {subject:'菱',predicate:'预算'},{subject:'菱角新',predicate:'预算'}];
  const one=plan('菱角的当前的预算是多少？',neighbors);
  assert.equal(one.status,'planned');assert.equal(one.subject,'菱角');assert.equal(one.predicate,'当前的预算');
  declined(plan('请推断菱角新旧两组的预算是多少？',neighbors));
});

test('question length and search term limits apply without Unicode or whitespace repair',()=>{
  const boundary={subject:'🌲'.repeat(50),predicate:'额'.repeat(96)};
  const exact=boundary.subject+'的'+boundary.predicate+'是什么';assert.equal(exact.length,200);
  const result=plan(exact,[boundary]);assert.equal(result.status,'planned');
  assert.deepEqual(result.search,parseSearchQuery(result.query,'all_terms'));
  for(const question of [exact+'？',' '+exact,'\t'+exact+'\n'])assert.throws(()=>plan(question,[boundary]),{code:'INVALID_PLANNER_QUESTION'});
  const spaced={subject:'风\t铃\u00a0台',predicate:'值\u3000班'};
  const spacedQuestion=spaced.subject+'的'+spaced.predicate+'是谁？';
  const literal=plan(spacedQuestion,[spaced]);assert.equal(literal.status,'planned');
  assert.deepEqual(literal.search.terms,['风','铃','台','值','班']);
  declined(plan(spacedQuestion.replace(/\s/gu,' '),[spaced]));
  const repeated={subject:'a b c d e f g h',predicate:'a'};
  const deduplicated=plan(repeated.subject+'的a是什么？',[repeated]);
  assert.equal(deduplicated.status,'planned');assert.equal(deduplicated.search.terms.length,8);
  const ninth={...repeated,predicate:'i'};
  const overflow=plan(ninth.subject+'的i是什么？',[ninth]);declined(overflow);assert.equal(overflow.reason,'KEY_SEARCH_LIMIT');
});

test('forbidden fields are rejected as schema violations while history-like label text stays literal',()=>{
  const label={subject:'之前车间',predicate:'历史负责人'};
  assert.equal(plan('之前车间的历史负责人是谁？',[label]).status,'planned');
  for(const question of ['之前车间最初的历史负责人是谁？','它的历史负责人是谁？',
    '之前车间的历史负责人是谁？请给原文','之前车间的历史负责人是谁？？'])declined(plan(question,[label]));
  const literalNames={subject:'gold',predicate:'evidence'};
  assert.equal(plan('gold的evidence是什么？',[literalNames]).status,'planned','field-name restrictions must not become string-content rules');
  for(const key of ['gold','evidence','value','source','scope','projectId','__proto__']){
    const input=JSON.parse(JSON.stringify({question:'之前车间的历史负责人是谁？',labels:[label]}));
    Object.defineProperty(input,key,{value:'ORIGINAL_SCHEMA_CANARY',enumerable:true});
    assert.throws(()=>planLabelQuery(input),error=>error.code==='INVALID_PLANNER_INPUT'&&!String(error.stack).includes('ORIGINAL_SCHEMA_CANARY'));
    const contaminated={...label};Object.defineProperty(contaminated,key,{value:'ORIGINAL_SCHEMA_CANARY',enumerable:true});
    assert.throws(()=>plan(input.question,[contaminated]),error=>error.code==='INVALID_PLANNER_LABEL'&&!String(error.stack).includes('ORIGINAL_SCHEMA_CANARY'));
  }
});

test('separate caller vocabularies stay stateless and oversized raw row lists are refused before inspecting labels',()=>{
  // These arrays represent caller-selected vocabularies, not an authorization proof.
  const a=[{subject:'雾岸仓',predicate:'交接人'}],b=[{subject:'杉坡仓',predicate:'开门时间'}];
  const aQuestion='雾岸仓的交接人是谁？',before=plan(aQuestion,a);
  assert.equal(before.status,'planned');assert.equal(plan('杉坡仓的开门时间是什么？',b).status,'planned');
  declined(plan(aQuestion,b));declined(plan('雾岸仓的开门时间是什么？',[...a,...b]));
  assert.deepEqual(plan(aQuestion,a),before,'another invocation cannot install a global label vocabulary');
  assert.equal(plan(aQuestion,Array(MAX_LABEL_ROWS).fill(a[0])).status,'planned');
  let reads=0;const oversized=Array(MAX_LABEL_ROWS+1).fill(null);
  Object.defineProperty(oversized,0,{get(){reads++;throw new Error('ORIGINAL_ROW_CANARY')}});
  const overflow=plan(aQuestion,oversized);declined(overflow);
  assert.equal(overflow.reason,'SCOPE_TOO_LARGE');assert.equal(reads,0);
  const duplicateOverflow=plan(aQuestion,Array(MAX_LABEL_ROWS+1).fill(a[0]));
  declined(duplicateOverflow);assert.equal(duplicateOverflow.reason,'SCOPE_TOO_LARGE','deduplication must not bypass the raw snapshot bound');
});
