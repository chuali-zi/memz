const {matchesSearchMetadata}=require('./search-query');
const SNAPSHOT_SCHEMA='memz-context-snapshot-v1';
const SNAPSHOT_CONSISTENCY='single-page-repeatable-read';
const SNAPSHOT_DESCRIPTION='One read-only repeatable-read transaction for authorization, current facts and provenance. A single-page transaction view; not necessarily current or still authorized at completion. Continuations use new snapshots.';
const SNAPSHOT_MAX_BYTES=1048576;
const positive=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
const text=(value,max)=>typeof value==='string'&&value.length<=max&&value.isWellFormed()&&!value.includes('\u0000');
const keys=(value,names)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
function requireSnapshot(condition){if(!condition)throw Object.assign(new Error('INVALID_SNAPSHOT_RESPONSE'),{code:'INVALID_SNAPSHOT_RESPONSE'})}
function snapshotReceipt(){return {schema:SNAPSHOT_SCHEMA,consistency:SNAPSHOT_CONSISTENCY}}
// Validate the complete page before any output-budget omission or provenance hydration.
function validateSnapshot(page,{projectId,query,limit,after,search}){
  requireSnapshot(keys(page,['schema','consistency','projectId','query','limit','after','role','sourceTextIsUntrusted','facts','provenance','sources','next_after',...(search?['search']:[])]));
  requireSnapshot(page.schema===SNAPSHOT_SCHEMA&&page.consistency===SNAPSHOT_CONSISTENCY&&page.projectId===projectId&&page.query===query&&page.limit===limit&&page.after===after&&page.sourceTextIsUntrusted===true&&['owner','member','viewer'].includes(page.role));
  requireSnapshot(!search||matchesSearchMetadata(page.search,search));
  requireSnapshot(Array.isArray(page.facts)&&page.facts.length<=limit&&Array.isArray(page.provenance)&&page.provenance.length===page.facts.length&&Array.isArray(page.sources)&&page.sources.length<=page.facts.length);
  requireSnapshot(page.next_after===null||(page.facts.length===limit&&positive(page.next_after)&&page.next_after===page.facts.at(-1)?.id));
  const sources=new Map();
  for(const source of page.sources){
    requireSnapshot(keys(source,['id','title','content'])&&positive(source.id)&&text(source.title,150)&&text(source.content,4000)&&!sources.has(source.id));
    sources.set(source.id,source);
  }
  const usedSources=new Set(),revisions=new Set(),candidates=new Set();let previousId=after;
  for(let i=0;i<page.facts.length;i++){
    const fact=page.facts[i],proof=page.provenance[i];
    requireSnapshot(keys(fact,['id','subject','predicate','version','value','revisionId','sourceId'])&&positive(fact.id)&&fact.id>previousId&&positive(fact.version)&&positive(fact.revisionId)&&positive(fact.sourceId)&&text(fact.subject,100)&&text(fact.predicate,100)&&text(fact.value,1000));previousId=fact.id;
    requireSnapshot(keys(proof,['sourceTextIsUntrusted','role','fact','revision','sourceId','candidate'])&&proof.sourceTextIsUntrusted===true&&proof.role===page.role&&proof.sourceId===fact.sourceId&&sources.has(proof.sourceId));
    requireSnapshot(keys(proof.fact,['id','subject','predicate'])&&proof.fact.id===fact.id&&proof.fact.subject===fact.subject&&proof.fact.predicate===fact.predicate);
    const revision=proof.revision,candidate=proof.candidate;
    requireSnapshot(keys(revision,['id','version','value','created_at','approved_by'])&&revision.id===fact.revisionId&&revision.version===fact.version&&revision.value===fact.value&&positive(revision.approved_by)&&!revisions.has(revision.id));
    requireSnapshot(typeof revision.created_at==='string'&&revision.created_at.length<=30&&Number.isFinite(Date.parse(revision.created_at)));
    requireSnapshot(keys(candidate,['id','expected_version','proposed_by'])&&positive(candidate.id)&&candidate.expected_version===fact.version-1&&positive(candidate.proposed_by)&&!candidates.has(candidate.id));
    usedSources.add(proof.sourceId);revisions.add(revision.id);candidates.add(candidate.id);
  }
  requireSnapshot(usedSources.size===sources.size&&[...usedSources].every((id,index)=>page.sources[index].id===id));
  return page.provenance.map(({sourceId,...proof})=>({...proof,source:sources.get(sourceId)}));
}
module.exports={SNAPSHOT_SCHEMA,SNAPSHOT_CONSISTENCY,SNAPSHOT_DESCRIPTION,SNAPSHOT_MAX_BYTES,snapshotReceipt,validateSnapshot};
