const {selectLabelTemplate}=require('./label-template-core');
const {MAX_CURRENT_LABELS}=require('./exact-context-protocol');
const EXACT_PLANNER_MODE='label_template_exact_v2';
// Pure fixed policy. The caller must supply a complete authorized current-label
// response, not a prefix or a vocabulary assembled from pagination or evidence.
function planExactLabelQuery(input){
  const selected=selectLabelTemplate(input,MAX_CURRENT_LABELS);
  const receipt={schemaVersion:1,mode:EXACT_PLANNER_MODE,view:'current'};
  if(selected.status!=='selected')return {...receipt,...selected};
  return {...receipt,status:'planned',selector:{subject:selected.subject,predicate:selected.predicate},template:selected.template};
}
module.exports={planExactLabelQuery,EXACT_PLANNER_MODE};
