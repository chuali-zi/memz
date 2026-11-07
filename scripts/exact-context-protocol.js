const {validateContextEvidence}=require('./context-evidence');
const CURRENT_LABELS_SCHEMA='memz-current-labels-v1';
const CURRENT_LABELS_CONSISTENCY='single-transaction-current-labels';
const EXACT_CONTEXT_SCHEMA='memz-exact-context-v1';
const EXACT_CONTEXT_CONSISTENCY='single-transaction-current-exact-key';
const MAX_CURRENT_LABELS=512;
const CURRENT_LABELS_MAX_BYTES=1048576;
const EXACT_CONTEXT_MAX_BYTES=1048576;
const positive=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
const role=value=>['owner','member','viewer'].includes(value);
const text=value=>typeof value==='string'&&value.length>=1&&value.length<=100&&value.trim().length>0&&value.isWellFormed()&&!value.includes('\u0000');
function keys(value,names){
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
}
const assertCode=(condition,code)=>{if(!condition)throw Object.assign(new Error(code),{code})};
function currentLabelsReceipt(){return {schema:CURRENT_LABELS_SCHEMA,consistency:CURRENT_LABELS_CONSISTENCY}}
function exactContextReceipt(){return {schema:EXACT_CONTEXT_SCHEMA,consistency:EXACT_CONTEXT_CONSISTENCY}}
function validateExactSelector(selector){
  assertCode(keys(selector,['subject','predicate'])&&text(selector.subject)&&text(selector.predicate),'INVALID_EXACT_SELECTOR');
  // No trimming, case folding, normalization or query syntax is applied.
  return {subject:selector.subject,predicate:selector.predicate};
}
function validateExactContextRequest(body){
  assertCode(keys(body,['selector']),'INVALID_EXACT_SELECTOR');return validateExactSelector(body.selector);
}
function validateCurrentLabels(page,{projectId}){
  const valid=condition=>assertCode(condition,'INVALID_CURRENT_LABELS_RESPONSE');
  valid(keys(page,['schema','consistency','projectId','role','sourceTextIsUntrusted','limit','complete','labels']));
  valid(page.schema===CURRENT_LABELS_SCHEMA&&page.consistency===CURRENT_LABELS_CONSISTENCY&&positive(projectId)&&page.projectId===projectId&&role(page.role)&&page.sourceTextIsUntrusted===true&&page.limit===MAX_CURRENT_LABELS);
  valid(typeof page.complete==='boolean'&&Array.isArray(page.labels)&&page.labels.length<=MAX_CURRENT_LABELS&&(!page.complete?page.labels.length===0:true));
  const seen=new Set();
  for(const label of page.labels){
    valid(keys(label,['subject','predicate'])&&text(label.subject)&&text(label.predicate));
    const key=JSON.stringify([label.subject,label.predicate]);valid(!seen.has(key));seen.add(key);
  }
  return page;
}
function validateExactContext(page,{projectId,selector}){
  const expected=validateExactSelector(selector),valid=condition=>assertCode(condition,'INVALID_EXACT_CONTEXT_RESPONSE');
  valid(keys(page,['schema','consistency','projectId','selector','role','sourceTextIsUntrusted','facts','provenance','sources']));
  valid(page.schema===EXACT_CONTEXT_SCHEMA&&page.consistency===EXACT_CONTEXT_CONSISTENCY&&positive(projectId)&&page.projectId===projectId&&role(page.role)&&page.sourceTextIsUntrusted===true);
  valid(keys(page.selector,['subject','predicate'])&&page.selector.subject===expected.subject&&page.selector.predicate===expected.predicate);
  const proofs=validateContextEvidence(page,{maxFacts:1,requireValid:valid,keys});
  valid(page.facts.every(fact=>fact.subject===expected.subject&&fact.predicate===expected.predicate));
  return proofs;
}
module.exports={CURRENT_LABELS_SCHEMA,CURRENT_LABELS_CONSISTENCY,EXACT_CONTEXT_SCHEMA,EXACT_CONTEXT_CONSISTENCY,MAX_CURRENT_LABELS,CURRENT_LABELS_MAX_BYTES,EXACT_CONTEXT_MAX_BYTES,currentLabelsReceipt,exactContextReceipt,validateExactSelector,validateExactContextRequest,validateCurrentLabels,validateExactContext};
