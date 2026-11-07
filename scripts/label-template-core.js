// Internal pure template selection shared by the fixed v1 and v2 policies.
const QUESTION_CONNECTORS=Object.freeze(['的','当前的','目前的','已批准的','目前批准的','当前批准的']);
const QUESTION_ENDINGS=Object.freeze(['是什么','是多少','是谁','是哪一天']);
function invalid(code){throw Object.assign(new Error(code),{code})}
function exactObject(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)return false;
  const actual=Reflect.ownKeys(value);
  return actual.length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
}
function text(value,max){
  return typeof value==='string'&&value.length<=max&&value.trim().length>0&&value.isWellFormed()&&!value.includes('\u0000');
}
function selectLabelTemplate(input,maxRows,questionMaxLength=200){
  if(!exactObject(input,['question','labels'])||!Array.isArray(input.labels))invalid('INVALID_PLANNER_INPUT');
  const {question,labels}=input;
  if(!text(question,questionMaxLength))invalid('INVALID_PLANNER_QUESTION');
  const decline=(status,reason)=>({status,reason});
  if(labels.length>maxRows)return decline('needs_scope','SCOPE_TOO_LARGE');
  const unique=new Map();
  for(const label of labels){
    if(!exactObject(label,['subject','predicate'])||!text(label.subject,100)||!text(label.predicate,100))invalid('INVALID_PLANNER_LABEL');
    unique.set(JSON.stringify([label.subject,label.predicate]),{subject:label.subject,predicate:label.predicate});
  }
  const normalized=question.trim().replace(/[?？]$/u,''),matches=[];
  const subjects=new Set(),predicates=new Set();
  for(const {subject,predicate} of unique.values()){
    const hasSubject=normalized.includes(subject);
    if(hasSubject)subjects.add(subject);
    if(hasSubject&&normalized.includes(predicate))predicates.add(predicate);
    for(const connector of QUESTION_CONNECTORS)for(const ending of QUESTION_ENDINGS){
      if(normalized===subject+connector+predicate+ending)matches.push({subject,predicate,connector,ending});
    }
  }
  if(matches.length>1)return decline('needs_scope','AMBIGUOUS_LABEL_MATCH');
  if(matches.length===1){
    const {subject,predicate,connector,ending}=matches[0];
    return {status:'selected',subject,predicate,template:{connector,ending}};
  }
  if(unique.size===0)return decline('no_match','NO_LABEL_MATCH');
  if(subjects.size===0)return decline('needs_scope','SUBJECT_REQUIRED');
  if(subjects.size>1)return decline('needs_scope','MULTIPLE_SUBJECTS');
  if(predicates.size>1)return decline('unsupported','MULTIPLE_PREDICATES');
  if(predicates.size===0)return decline('no_match','UNKNOWN_PREDICATE');
  return decline('unsupported','UNSUPPORTED_QUESTION_FORM');
}
module.exports={selectLabelTemplate,QUESTION_CONNECTORS,QUESTION_ENDINGS};
