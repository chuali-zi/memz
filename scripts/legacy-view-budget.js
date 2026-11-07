// HTTP compatibility-view limits. Internal readProject callers retain their
// existing full-result baseline; these are resource bounds, not character rules.
const LEGACY_VIEW_MAX_ROWS=512,LEGACY_VIEW_MAX_BYTES=4*1024*1024;
const LEGACY_VIEW_MESSAGE='聚合读取范围过大，请使用分页接口或检查导入数据';
const textBytes={subject:400,predicate:400,value:4000,title:600,content:16000,status:64,action:128,detail:4000};
function tooLarge(){return Object.assign(new Error(LEGACY_VIEW_MESSAGE),{status:422,code:'LEGACY_VIEW_TOO_LARGE'})}
function guard(name,from,fields,{filter='',order,limit=LEGACY_VIEW_MAX_ROWS+1,parameters}={}){
  const sizes=fields.map(([column,type])=>({expression:`COALESCE(octet_length(${column}),0)`,limit:textBytes[type]}));
  return {name,parameters,sql:`SELECT count(*)::int AS rows,COALESCE(sum(bytes),0)::text AS bytes,COALESCE(bool_or(bad),false) AS bad
    FROM (SELECT ${sizes.map(x=>`(${x.expression})::bigint`).join('+')} AS bytes,
      ${sizes.map(x=>`${x.expression}>${x.limit}`).join(' OR ')} AS bad
      FROM ${from} WHERE ${filter||'project_id=$1'} ORDER BY ${order} LIMIT ${limit}) AS bounded`};
}
const guards=[
  guard('facts','facts f JOIN revisions r ON r.id=f.current_revision_id JOIN sources s ON s.id=r.source_id',
    [['f.subject','subject'],['f.predicate','predicate'],['r.value','value'],['s.title','title']],
    {filter:"f.project_id=$1 AND CASE WHEN octet_length(f.subject)>400 OR octet_length(f.predicate)>400 OR octet_length(r.value)>4000 THEN true ELSE position(lower($2) in lower(f.subject||' '||f.predicate||' '||r.value))>0 END",order:'f.id',parameters:true}),
  guard('sources','sources',[['title','title'],['content','content']],{order:'id'}),
  guard('candidates','candidates c JOIN sources s ON s.id=c.source_id',
    [['c.subject','subject'],['c.predicate','predicate'],['c.value','value'],['c.status','status'],['s.title','title']],{filter:'c.project_id=$1',order:'c.id DESC'}),
  guard('history','revisions r JOIN facts f ON f.id=r.fact_id JOIN sources s ON s.id=r.source_id',
    [['f.subject','subject'],['f.predicate','predicate'],['r.value','value'],['s.title','title']],{filter:'r.project_id=$1',order:'r.id DESC'}),
  guard('audit','audit',[['action','action'],['detail','detail']],{order:'id DESC',limit:100})
];
async function assertLegacyScope(client,project,query,enabled){
  let bytes=0;
  for(const guard of guards){
    if(!enabled[guard.name])continue;
    const result=await client.query(guard.sql,guard.parameters?[project,query]:[project]),row=result.rows[0];
    const size=Number(row?.bytes);
    if(result.rows.length!==1||!Number.isInteger(row?.rows)||row.rows<0||row.rows>LEGACY_VIEW_MAX_ROWS||row.bad!==false||!Number.isSafeInteger(size)||size<0)throw tooLarge();
    bytes+=size;if(bytes>LEGACY_VIEW_MAX_BYTES)throw tooLarge();
  }
}
function assertLegacyJSONBudget(value){
  // Count complete rows before constructing the whole response. A rejected
  // escaped JSON result never requires one oversized envelope allocation.
  const envelope={...value};
  for(const key of Object.keys(envelope))if(Array.isArray(envelope[key]))envelope[key]=[];
  let bytes=Buffer.byteLength(JSON.stringify(envelope),'utf8');
  for(const rows of Object.values(value))if(Array.isArray(rows)){
    for(let i=0;i<rows.length;i++){
      bytes+=Buffer.byteLength(JSON.stringify(rows[i]),'utf8')+(i?1:0);
      if(bytes>LEGACY_VIEW_MAX_BYTES)throw tooLarge();
    }
  }
  if(bytes>LEGACY_VIEW_MAX_BYTES)throw tooLarge();
  return bytes;
}
module.exports={LEGACY_VIEW_MAX_ROWS,LEGACY_VIEW_MAX_BYTES,LEGACY_VIEW_MESSAGE,assertLegacyScope,assertLegacyJSONBudget};
