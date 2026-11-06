// Explicit model-facing projection of validated current facts. No model calls.
const {readContext}=require('./context-client');
function invalid(){throw Object.assign(new Error('INVALID_READER_CONTEXT'),{code:'INVALID_READER_CONTEXT'})}
const positive=x=>Number.isInteger(x)&&x>0&&x<=2147483647;
function renderReaderContext(context){
  if(!context||![1,2].includes(context.schemaVersion)||context.sourceTextIsUntrusted!==true||
    !positive(context.projectId)||typeof context.consistency!=='string'||!context.consistency||
    typeof context.truncated!=='boolean'||!(context.nextAfter===null||positive(context.nextAfter))||
    !Array.isArray(context.facts)||context.facts.length>100)invalid();
  if(context.truncated!==(context.nextAfter!==null))invalid();
  const sources=new Map(),facts=[],ids=new Set();
  function addSource(source){
    if(!source||!positive(source.id)||typeof source.title!=='string'||source.title.length>150||
      typeof source.content!=='string'||source.content.length>4000)invalid();
    const clean={id:source.id,title:source.title,content:source.content},prior=sources.get(source.id);
    if(prior&&JSON.stringify(prior)!==JSON.stringify(clean))invalid();
    sources.set(source.id,clean);
  }
  if(context.schemaVersion===2){
    if(!Array.isArray(context.sources))invalid();
    for(const source of context.sources){if(sources.has(source?.id))invalid();addSource(source)}
  }
  const used=new Set();let previous=0;
  for(const fact of context.facts){
    if(!fact||!['id','version','revisionId','candidateId','approvedBy','proposedBy'].every(k=>positive(fact[k]))||
      fact.id<=previous||ids.has(fact.id)||!['subject','predicate','value'].every(k=>typeof fact[k]==='string'&&fact[k].length<=(k==='value'?1000:100)))invalid();
    previous=fact.id;ids.add(fact.id);
    if(context.schemaVersion===1)addSource(fact.source);
    const sourceId=context.schemaVersion===1?fact.source.id:fact.sourceId;
    if(!positive(sourceId)||!sources.has(sourceId))invalid();used.add(sourceId);
    facts.push({id:fact.id,revisionId:fact.revisionId,version:fact.version,sourceId,
      subject:fact.subject,predicate:fact.predicate,value:fact.value});
  }
  if(sources.size!==used.size||context.nextAfter!==null&&context.nextAfter!==context.facts.at(-1)?.id)invalid();
  return JSON.stringify({schema:'memz-reader-v1',projectId:context.projectId,
    sourceTextIsUntrusted:true,consistency:context.consistency,
    truncated:context.truncated,nextAfter:context.nextAfter,facts,sources:[...used].map(id=>sources.get(id))});
}
async function readReaderContext(options){return renderReaderContext(await readContext(options))}
module.exports={renderReaderContext,readReaderContext};
if(require.main===module){
  let size=0;const chunks=[];
  const timer=setTimeout(()=>{console.error('READER_INPUT_TIMEOUT');process.exit(1)},30000);
  process.stdin.on('data',chunk=>{size+=chunk.length;if(size>4194304){console.error('READER_INPUT_TOO_LARGE');process.exit(1)}chunks.push(chunk)});
  process.stdin.on('end',()=>{clearTimeout(timer);try{console.log(renderReaderContext(JSON.parse(Buffer.concat(chunks).toString('utf8'))))}catch{console.error('INVALID_READER_CONTEXT');process.exitCode=1}});
}
