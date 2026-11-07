const {selectLabelTemplate,QUESTION_CONNECTORS,QUESTION_ENDINGS}=require('./label-template-core');
const {MAX_CURRENT_LABELS}=require('./exact-context-protocol');
const EXACT_PLANNER_MODE='label_template_exact_v2';
// Two legal 100-unit keys, the longest fixed grammar, and one optional mark.
// This is an internal v2 policy, never a caller-provided capacity option.
const EXACT_QUESTION_MAX_LENGTH=100*2+Math.max(...QUESTION_CONNECTORS.map(text=>text.length))+Math.max(...QUESTION_ENDINGS.map(text=>text.length))+1;
// Pure fixed policy. The caller must supply a complete authorized current-label
// response, not a prefix or a vocabulary assembled from pagination or evidence.
function planExactLabelQuery(input){
  const selected=selectLabelTemplate(input,MAX_CURRENT_LABELS,EXACT_QUESTION_MAX_LENGTH);
  const receipt={schemaVersion:1,mode:EXACT_PLANNER_MODE,view:'current'};
  if(selected.status!=='selected')return {...receipt,...selected};
  return {...receipt,status:'planned',selector:{subject:selected.subject,predicate:selected.predicate},template:selected.template};
}
module.exports={planExactLabelQuery,EXACT_PLANNER_MODE,EXACT_QUESTION_MAX_LENGTH};
