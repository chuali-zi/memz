const {parseSearchQuery}=require('./search-query');

const PLANNER_MODE='label_template_v1';
const MAX_LABEL_ROWS=25;
// Public v1 grammar: {subject}{connector}{predicate}{ending}, optionally
// followed by one ? or ？. Only outer question whitespace is removed. Labels
// are literal strings, never regexes or instructions. This is current-view
// template planning, with no synonyms, semantic matching or history routing.
// The caller must obtain a complete label list from one authorized approved
// current-facts snapshot. This pure function cannot verify project permission,
// snapshot completeness or approval, and does not execute the proposed search.
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
function planLabelQuery(input){
  if(!exactObject(input,['question','labels'])||!Array.isArray(input.labels))invalid('INVALID_PLANNER_INPUT');
  const {question,labels}=input;
  if(!text(question,200))invalid('INVALID_PLANNER_QUESTION');
  const receipt={schemaVersion:1,mode:PLANNER_MODE,view:'current'};
  const decline=(status,reason)=>({...receipt,status,reason});
  // Bound work before validating or deduplicating individual label records.
  if(labels.length>MAX_LABEL_ROWS)return decline('needs_scope','SCOPE_TOO_LARGE');
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
    // Only predicates attached to a recognized subject participate in ambiguity
    // diagnostics. A different subject's vocabulary must not select a key.
    if(hasSubject&&normalized.includes(predicate))predicates.add(predicate);
    for(const connector of QUESTION_CONNECTORS)for(const ending of QUESTION_ENDINGS){
      if(normalized===subject+connector+predicate+ending)matches.push({subject,predicate,connector,ending});
    }
  }
  if(matches.length>1)return decline('needs_scope','AMBIGUOUS_LABEL_MATCH');
  if(matches.length===1){
    const {subject,predicate,connector,ending}=matches[0],query=subject+' '+predicate;
    let search;
    try{search=parseSearchQuery(query,'all_terms')}
    catch{return decline('unsupported','KEY_SEARCH_LIMIT')}
    return {...receipt,status:'planned',subject,predicate,query,search,template:{connector,ending}};
  }
  if(unique.size===0)return decline('no_match','NO_LABEL_MATCH');
  if(subjects.size===0)return decline('needs_scope','SUBJECT_REQUIRED');
  if(subjects.size>1)return decline('needs_scope','MULTIPLE_SUBJECTS');
  if(predicates.size>1)return decline('unsupported','MULTIPLE_PREDICATES');
  if(predicates.size===0)return decline('no_match','UNKNOWN_PREDICATE');
  return decline('unsupported','UNSUPPORTED_QUESTION_FORM');
}

module.exports={planLabelQuery,PLANNER_MODE,MAX_LABEL_ROWS,QUESTION_CONNECTORS,QUESTION_ENDINGS};
