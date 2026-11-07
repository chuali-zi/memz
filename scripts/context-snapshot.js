const {matchesSearchMetadata}=require('./search-query');
const {validateContextEvidence}=require('./context-evidence');
const SNAPSHOT_SCHEMA='memz-context-snapshot-v1';
const SNAPSHOT_CONSISTENCY='single-page-repeatable-read';
const SNAPSHOT_DESCRIPTION='One read-only repeatable-read transaction for authorization, current facts and provenance. A single-page transaction view; not necessarily current or still authorized at completion. Continuations use new snapshots.';
const SNAPSHOT_MAX_BYTES=1048576;
const positive=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
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
  return validateContextEvidence(page,{maxFacts:limit,after,requireValid:requireSnapshot});
}
module.exports={SNAPSHOT_SCHEMA,SNAPSHOT_CONSISTENCY,SNAPSHOT_DESCRIPTION,SNAPSHOT_MAX_BYTES,snapshotReceipt,validateSnapshot};
