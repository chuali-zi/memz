const {parseSearchQuery}=require('./search-query');
const {selectLabelTemplate,QUESTION_CONNECTORS,QUESTION_ENDINGS}=require('./label-template-core');

const PLANNER_MODE='label_template_v1';
const MAX_LABEL_ROWS=25;
// Public v1 grammar: {subject}{connector}{predicate}{ending}, optionally
// followed by one ? or ？. Only outer question whitespace is removed. Labels
// are literal strings, never regexes or instructions. This is current-view
// template planning, with no synonyms, semantic matching or history routing.
// The caller must obtain a complete label list from one authorized approved
// current-facts snapshot. This pure function cannot verify project permission,
// snapshot completeness or approval, and does not execute the proposed search.
function planLabelQuery(input){
  const selected=selectLabelTemplate(input,MAX_LABEL_ROWS);
  const receipt={schemaVersion:1,mode:PLANNER_MODE,view:'current'};
  if(selected.status!=='selected')return {...receipt,...selected};
  const {subject,predicate,template}=selected,query=subject+' '+predicate;
  let search;
  try{search=parseSearchQuery(query,'all_terms')}
  catch{return {...receipt,status:'unsupported',reason:'KEY_SEARCH_LIMIT'}}
  return {...receipt,status:'planned',subject,predicate,query,search,template};
}

module.exports={planLabelQuery,PLANNER_MODE,MAX_LABEL_ROWS,QUESTION_CONNECTORS,QUESTION_ENDINGS};
