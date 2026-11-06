// Shared, deterministic query contract. Matching/case conversion belongs to PostgreSQL.
function invalid(code){throw Object.assign(new Error(code),{code})}
function parseSearchQuery(query,mode='substring'){
  if(!['substring','all_terms'].includes(mode))invalid('INVALID_SEARCH_MODE');
  // The legacy caller owns its existing validation/truncation behavior.
  if(mode==='substring')return null;
  if(typeof query!=='string'||query.length>200||!query.isWellFormed()||query.includes('\u0000')||!query.trim())invalid('INVALID_QUERY');
  // Exact duplicates only: JavaScript case conversion can differ from database lower().
  const terms=[...new Set(query.trim().split(/\s+/u))];
  if(terms.length>8)invalid('TOO_MANY_SEARCH_TERMS');
  return {mode:'all_terms',terms,order:'fact_id_asc',matching:'all_terms_any_field_substring',caseHandling:'postgresql_lower',fields:['subject','predicate','value']};
}
function matchesSearchMetadata(actual,expected){
  return !!actual&&typeof actual==='object'&&!Array.isArray(actual)&&Object.keys(actual).length===Object.keys(expected).length&&Object.entries(expected).every(([key,value])=>
    Array.isArray(value)?Array.isArray(actual[key])&&actual[key].length===value.length&&value.every((item,index)=>actual[key][index]===item):actual[key]===value);
}
module.exports={parseSearchQuery,matchesSearchMetadata};
