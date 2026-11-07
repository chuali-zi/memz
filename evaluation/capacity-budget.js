// Benchmark-only application byte accounting. This does not measure PG wire,
// HTTP headers, heap or IPC, and never records SQL/parameter/result contents.
const {snapshotReceipt}=require('../scripts/context-snapshot');
const MIB=1024*1024;
const SMOKE_PROFILE='node-pair-smoke-v1';
const fail=code=>Object.assign(new Error(code),{code});
const jsonBytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
function capacityProfile(name){
  if(name===undefined||name===''||name==='legacy')return Object.freeze({id:'legacy',pageSize:25,perLevel:80,budgeted:false});
  if(name!==SMOKE_PROFILE)throw fail('UNKNOWN_CAPACITY_PROFILE');
  return Object.freeze({id:SMOKE_PROFILE,pageSize:10,perLevel:32,maxHttpRequests:138,budgeted:true,parentBytes:5*MIB,childBytes:3*MIB,cleanupBytes:16*1024,httpResponseBytes:32*1024,smallResponseBytes:1024,pairBytes:16*MIB});
}
class ByteLedger{
  constructor(limit){if(!Number.isSafeInteger(limit)||limit<=0)throw fail('INVALID_BYTE_LIMIT');this.limit=limit;this.used=0;this.reserved=0;this.peakCommitted=0;this.operations=0;this.denied=0;this.overruns=0;this.overrunBytes=0;this.unmeasured=0}
  reserve(bound){
    if(!Number.isSafeInteger(bound)||bound<0)throw fail('INVALID_BYTE_BOUND');
    if(this.used+this.reserved+bound>this.limit){this.denied++;throw fail('BYTE_BUDGET_EXCEEDED')}
    this.reserved+=bound;this.peakCommitted=Math.max(this.peakCommitted,this.used+this.reserved);let settled=false;
    return {settle:actual=>{
      if(settled||!Number.isSafeInteger(actual)||actual<0)throw fail('INVALID_BYTE_SETTLEMENT');settled=true;
      this.reserved-=bound;this.used+=actual;this.operations++;this.peakCommitted=Math.max(this.peakCommitted,this.used+this.reserved);
      if(actual>bound){this.overruns++;this.overrunBytes+=actual-bound;throw fail('BYTE_PROJECTION_EXCEEDED')}
    },unmeasured:()=>{if(settled)return;settled=true;this.reserved-=bound;this.used+=bound;this.operations++;this.unmeasured++}};
  }
  snapshot(){return {limit:this.limit,used:this.used,reserved:this.reserved,peakCommitted:this.peakCommitted,operations:this.operations,denied:this.denied,overruns:this.overruns,overrunBytes:this.overrunBytes,unmeasured:this.unmeasured}}
}
function budgetGroup(limit,cleanupBytes){
  if(cleanupBytes>=limit)throw fail('INVALID_CLEANUP_BUDGET');
  const work=new ByteLedger(limit-cleanupBytes),cleanup=new ByteLedger(cleanupBytes);
  return {work,cleanup,snapshot:()=>({limit,used:work.used+cleanup.used,reserved:work.reserved+cleanup.reserved,work:work.snapshot(),cleanup:cleanup.snapshot()})};
}
function rowsJSON(result){
  if(Array.isArray(result)){
    if(result.some(part=>!part||!Array.isArray(part.rows)))throw fail('UNMEASURABLE_PG_RESULT');
    return result.map(part=>part.rows);
  }
  if(!result||!Array.isArray(result.rows))throw fail('UNMEASURABLE_PG_RESULT');
  return result.rows;
}
const meteredClients=new WeakMap();
function meterClient(client,group,boundForQuery,onFailure=()=>{}){
  if(meteredClients.has(client)){if(meteredClients.get(client)!==group)throw fail('DUPLICATE_BUDGET_CLIENT');return client}
  meteredClients.set(client,group);const query=client.query;
  // Preserve both native query shapes, including pg-pool's internal callback
  // even when its public pool.query caller requested a Promise. Never wrap
  // pool.connect or introduce another handoff before tx's error listener.
  client.query=function(sql,params,callback){
    if(typeof params==='function'){callback=params;params=undefined}
    let token,input;
    const notify=error=>onFailure(error);
    const finish=(error,result)=>{
      if(!token)return error;
      try{
        if(error){token.settle(input);token=null;return error}
        const actual=input+jsonBytes(rowsJSON(result));token.settle(actual);token=null;return null;
      }catch(problem){token.unmeasured();token=null;notify(problem);return error||problem}
    };
    try{
      if(typeof sql!=='string'||(params!==undefined&&!Array.isArray(params))||(callback!==undefined&&typeof callback!=='function'))throw fail('UNSUPPORTED_BUDGET_QUERY');
      const maxRows=boundForQuery(sql,params||[]);
      if(!Number.isSafeInteger(maxRows)||maxRows<0)throw fail('INVALID_PG_RESULT_BOUND');
      input=Buffer.byteLength(sql,'utf8')+jsonBytes(params||[]);
      const ledger=/^\s*(ROLLBACK|DROP DATABASE)\b/i.test(sql)?group.cleanup:group.work;
      token=ledger.reserve(input+maxRows);
    }catch(error){notify(error);if(typeof callback==='function'){queueMicrotask(()=>callback(error));return}return Promise.reject(error)}
    if(typeof callback==='function'){
      try{return query.call(this,sql,params,(error,result)=>callback(finish(error,result),result))}
      catch(error){throw finish(error)}
    }
    let operation;
    try{operation=query.call(this,sql,params)}catch(error){return Promise.reject(finish(error))}
    return Promise.resolve(operation).then(result=>{const error=finish(null,result);if(error)throw error;return result},error=>{throw finish(error)});
  };
  return client;
}
function fixtureBounds(records,profile){
  if(!Array.isArray(records)||records.length!==512||profile.pageSize!==10)throw fail('INVALID_CAPACITY_FIXTURE');
  const text=field=>'x'.repeat(Math.max(...records.map(row=>jsonBytes(row[field])))-2),id=2147483647;
  const subject=text('subject'),predicate=text('predicate'),value=text('value'),title=text('title'),content=text('content');
  const source={id,title,content};
  const selected={id,subject,predicate,version:1,value,revision_id:id,source_id:id};
  const proof={fact_id:id,subject,predicate,revision_id:id,version:1,value,created_at:'2026-11-07T00:00:00.000Z',approved_by:1,source_id:id,candidate_id:id,expected_version:0,proposed_by:1,candidate_source_id:id,candidate_subject:subject,candidate_predicate:predicate,candidate_value:value,candidate_status:'approved'};
  const arrayBound=(row,count)=>2+count*jsonBytes(row)+Math.max(0,count-1);
  const n=profile.pageSize;
  const snapshot={...snapshotReceipt(),projectId:1,query:'容量基准',limit:n,after:id,role:'viewer',sourceTextIsUntrusted:true,
    facts:Array.from({length:n},()=>({id,subject,predicate,value,version:1,revisionId:id,sourceId:id})),
    provenance:Array.from({length:n},()=>({sourceTextIsUntrusted:true,role:'viewer',fact:{id,subject,predicate},revision:{id,version:1,value,created_at:proof.created_at,approved_by:1},sourceId:id,candidate:{id,expected_version:0,proposed_by:1}})),
    sources:Array.from({length:n},()=>source),next_after:id};
  if(jsonBytes(snapshot)>profile.httpResponseBytes)throw fail('HTTP_PROJECTION_TOO_LARGE');
  const workloadRow={id,subject,predicate,value,version:1,source_id:id,title,content};
  const fixtureRowsBytes=jsonBytes(records);records=null;
  const parent=(sql)=>{
    const flat=sql.replace(/\s+/g,' ').trim();
    if(/^SELECT f\.project_id,f\.subject,f\.predicate,r\.value,s\.title,s\.content,c\.proposed_by AS actor_id /i.test(flat))return fixtureRowsBytes;
    if(/^SELECT f\.id,f\.subject,f\.predicate,r\.value,f\.version,s\.id AS source_id,s\.title,s\.content /i.test(flat))return arrayBound(workloadRow,256);
    if(/^SELECT count\(\*\) AS n FROM (projects|memberships|sources|facts|candidates|revisions|audit|idempotency_requests)$/i.test(flat))return 64;
    if(/^SELECT count\(\*\)::int AS connections,/i.test(flat))return 256;
    if(/^SHOW (server_version|max_connections)$/i.test(flat))return 1024;
    if(flat.includes('CREATE TABLE projects')&&flat.startsWith('-- Run as migration owner'))return 4096;
    if(/^(BEGIN|COMMIT|ROLLBACK|ANALYZE)$/i.test(flat)||/^(CREATE|DROP) DATABASE memz_capacity_[a-f0-9]{16}( WITH \(FORCE\))?$/i.test(flat))return 2;
    if(/^(INSERT INTO (sources|facts|candidates|revisions|audit)|UPDATE facts)\b/i.test(flat)&&!(/\bRETURNING\b/i.test(flat)))return 2;
    throw fail('UNSUPPORTED_BUDGET_QUERY');
  };
  const child=(sql,params)=>{
    const flat=sql.replace(/\s+/g,' ').trim();
    if(/^(BEGIN(?: ISOLATION LEVEL REPEATABLE READ READ ONLY)?|COMMIT|ROLLBACK)$/i.test(flat))return 2;
    if(flat==="SELECT pg_catalog.set_config('app.user_id',$1,true)")return 128;
    if(flat.startsWith('SELECT role FROM memberships WHERE '))return 128;
    if(flat.startsWith('SELECT f.id,f.subject,f.predicate,f.version,r.value, r.id AS revision_id,r.source_id FROM facts f LEFT JOIN revisions r ')){
      if(params[3]!==n+1)throw fail('UNSUPPORTED_BUDGET_QUERY');return arrayBound(selected,n+1);
    }
    if(flat.startsWith('SELECT f.id AS fact_id,f.subject,f.predicate, r.id AS revision_id,r.version,r.value,r.created_at,r.approved_by,r.source_id, ')){
      if(!Array.isArray(params[1])||!Array.isArray(params[2])||params[1].length>n||params[2].length>n)throw fail('UNSUPPORTED_BUDGET_QUERY');return arrayBound(proof,n);
    }
    if(flat==='SELECT id,title,content FROM sources WHERE project_id=$1 AND id=ANY($2::int[])'){
      if(!Array.isArray(params[1])||params[1].length>n)throw fail('UNSUPPORTED_BUDGET_QUERY');return arrayBound(source,n);
    }
    throw fail('UNSUPPORTED_BUDGET_QUERY');
  };
  return {parent,child,httpSnapshotMaxBytes:jsonBytes(snapshot),fixtureRowsBytes,workloadRowsBytes:arrayBound(workloadRow,256)};
}
module.exports={SMOKE_PROFILE,capacityProfile,ByteLedger,budgetGroup,meterClient,fixtureBounds,jsonBytes,rowsJSON};
