// Shared payload checks. Each protocol separately validates its own header and
// passes its error constructor and key policy; no query receipt is synthesized.
const positive=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
const text=(value,max)=>typeof value==='string'&&value.length<=max&&value.isWellFormed()&&!value.includes('\u0000');
const legacyKeys=(value,names)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
function validateContextEvidence(page,{maxFacts,after=0,requireValid,keys=legacyKeys}){
  requireValid(Array.isArray(page.facts)&&page.facts.length<=maxFacts&&Array.isArray(page.provenance)&&page.provenance.length===page.facts.length&&Array.isArray(page.sources)&&page.sources.length<=page.facts.length);
  const sources=new Map();
  for(const source of page.sources){
    requireValid(keys(source,['id','title','content'])&&positive(source.id)&&text(source.title,150)&&text(source.content,4000)&&!sources.has(source.id));
    sources.set(source.id,source);
  }
  const usedSources=new Set(),revisions=new Set(),candidates=new Set();let previousId=after;
  for(let i=0;i<page.facts.length;i++){
    const fact=page.facts[i],proof=page.provenance[i];
    requireValid(keys(fact,['id','subject','predicate','version','value','revisionId','sourceId'])&&positive(fact.id)&&fact.id>previousId&&positive(fact.version)&&positive(fact.revisionId)&&positive(fact.sourceId)&&text(fact.subject,100)&&text(fact.predicate,100)&&text(fact.value,1000));previousId=fact.id;
    requireValid(keys(proof,['sourceTextIsUntrusted','role','fact','revision','sourceId','candidate'])&&proof.sourceTextIsUntrusted===true&&proof.role===page.role&&proof.sourceId===fact.sourceId&&sources.has(proof.sourceId));
    requireValid(keys(proof.fact,['id','subject','predicate'])&&proof.fact.id===fact.id&&proof.fact.subject===fact.subject&&proof.fact.predicate===fact.predicate);
    const revision=proof.revision,candidate=proof.candidate;
    requireValid(keys(revision,['id','version','value','created_at','approved_by'])&&revision.id===fact.revisionId&&revision.version===fact.version&&revision.value===fact.value&&positive(revision.approved_by)&&!revisions.has(revision.id));
    requireValid(typeof revision.created_at==='string'&&revision.created_at.length<=30&&Number.isFinite(Date.parse(revision.created_at)));
    requireValid(keys(candidate,['id','expected_version','proposed_by'])&&positive(candidate.id)&&candidate.expected_version===fact.version-1&&positive(candidate.proposed_by)&&!candidates.has(candidate.id));
    usedSources.add(proof.sourceId);revisions.add(revision.id);candidates.add(candidate.id);
  }
  requireValid(usedSources.size===sources.size&&[...usedSources].every((id,index)=>page.sources[index].id===id));
  return page.provenance.map(({sourceId,...proof})=>({...proof,source:sources.get(sourceId)}));
}
module.exports={validateContextEvidence};
