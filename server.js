const express=require('express'), cookieParser=require('cookie-parser'), crypto=require('crypto');
const {Pool}=require('pg');
const {requestKey,createOnce}=require('./idempotency');
const {parseSearchQuery}=require('./scripts/search-query');
const {SNAPSHOT_MAX_BYTES,snapshotReceipt}=require('./scripts/context-snapshot');
const {SessionStore,SESSION_TTL_MS}=require('./scripts/session-store');
const {databasePoolOptions,databaseErrorKind,safeErrorCode,runTransaction}=require('./scripts/database');
const app=express();
const pool=new Pool(databasePoolOptions(process.env.DATABASE_URL || 'postgres://memz_app:memz_demo_only@127.0.0.1:5432/memz'));
// pg removes failed idle clients before emitting this event; later requests reconnect.
// Do not log the error/client object: it can contain connection credentials.
pool.on('error',()=>console.error('Database idle connection lost; future requests will reconnect.'));
const accounts={owner:{id:1,password:'demo-owner',name:'负责人'},member:{id:2,password:'demo-member',name:'成员'},viewer:{id:3,password:'demo-viewer',name:'只读者'},other:{id:4,password:'demo-other',name:'另一项目用户'}};
const sessions=new SessionStore();
app.disable('x-powered-by');
app.use((req,res,next)=>{res.set('X-Content-Type-Options','nosniff');res.set('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"); next()});
// The public-account demo accepts only literal loopback host names, independent of Origin.
app.use((req,res,next)=>{
  const match=typeof req.headers.host==='string'&&/^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(req.headers.host);
  if(!match||(match[2]!==undefined&&(Number(match[2])<1||Number(match[2])>65535)))return res.status(403).json({error:'仅支持本机演示地址'});
  next();
});
app.use(express.json({limit:'16kb',verify:(req,res,buffer)=>{req.jsonBodyBytes=buffer.length}})); app.use(cookieParser());
app.post('/api/login',requireJsonObject,(req,res)=>{
  if(req.get('origin')&&req.get('origin')!==`${req.protocol}://${req.get('host')}`)return res.status(403).json({error:'请求来源无效'});
  const a=typeof req.body.username==='string'&&Object.hasOwn(accounts,req.body.username)?accounts[req.body.username]:null;
  if(!a||typeof req.body.password!=='string'||a.password!==req.body.password)return res.status(401).json({error:'账号或密码错误'});
  const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');
  if(!sessions.create(token,{id:a.id,name:a.name,csrf},{replaceToken:req.cookies.sid}))return res.set('Retry-After','60').status(503).json({error:'登录会话已满，请稍后重试'});
  res.cookie('sid',token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',maxAge:SESSION_TTL_MS});
  res.json({name:a.name,csrf});
});
app.use('/api',(req,res,next)=>{req.user=sessions.get(req.cookies.sid);if(!req.user)return res.status(401).json({error:'请先登录'});if(!['GET','HEAD'].includes(req.method)&&req.get('x-csrf-token')!==req.user.csrf)return res.status(403).json({error:'请求校验失败'});next()});
app.post('/api/logout',(req,res)=>{sessions.delete(req.cookies.sid);res.clearCookie('sid');res.json({ok:true})});
app.get('/api/me',(req,res)=>res.json({name:req.user.name,csrf:req.user.csrf}));
const tx=(user,fn,options)=>runTransaction(pool,user,fn,options);
const fail=(status,message)=>Object.assign(new Error(message),{status});
// Required only where a JSON object carries business input. Decisions and
// logout intentionally remain valid without a request body.
function requireJsonObject(req,res,next){
  const mediaType=req.get('content-type')?.split(';',1)[0].trim().toLowerCase();
  if(mediaType!=='application/json')return next(fail(415,'Content-Type 必须为 application/json'));
  if(!req.jsonBodyBytes||!req.body||typeof req.body!=='object'||Array.isArray(req.body))return next(fail(400,'请求体必须为 JSON 对象'));
  next();
}
function integer(x,min,message){
  if(typeof x!=='number' && !(typeof x==='string' && /^[0-9]+$/.test(x)))throw fail(400,message);
  const n=Number(x);
  if(!Number.isInteger(n)||n<min||n>2147483647)throw fail(400,message);
  return n;
}
function num(x){return integer(x,1,'编号无效')}
function queryText(x,max){if(x.includes('\u0000'))throw fail(400,'文本不能包含空字符 U+0000');if(!x.isWellFormed())throw fail(400,'文本包含未配对的 Unicode 代理字符');let result=x.slice(0,max);if(/[\uD800-\uDBFF]$/.test(result))result=result.slice(0,-1);return result}
function str(x,max=500){if(typeof x!=='string'||!x.trim()||x.length>max)throw fail(400,'内容为空或过长');queryText(x,max);return x.trim()}
async function role(c,p,allowed){const r=(await c.query('SELECT role FROM memberships WHERE project_id=$1 AND user_id=nullif(current_setting(\'app.user_id\',true),\'\')::int',[p])).rows[0];if(!r||!allowed.includes(r.role))throw fail(403,'无权访问此项目或执行此操作');return r.role}
const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
app.get('/api/projects',route(async(req,res)=>res.json(await tx(req.user.id,async c=>(await c.query('SELECT p.id,p.name,m.role FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=$1 ORDER BY p.id',[req.user.id])).rows))));
async function readProject(user,p,q,{includeFacts=true,includeHistory=true,includeCandidates=true,includeSources=true,includeAudit=true}={}){return tx(user,async c=>{const r=await role(c,p,['owner','member','viewer']);const facts=includeFacts?(await c.query(`SELECT f.id,f.subject,f.predicate,f.version,r.value,s.title source FROM facts f JOIN revisions r ON r.id=f.current_revision_id JOIN sources s ON s.id=r.source_id WHERE f.project_id=$1 AND position(lower($2) in lower(f.subject||' '||f.predicate||' '||r.value))>0 ORDER BY f.id`,[p,q])).rows:[];const sources=includeSources?(await c.query('SELECT id,title,content FROM sources WHERE project_id=$1 ORDER BY id',[p])).rows:[];const candidates=includeCandidates?(await c.query('SELECT c.*,s.title source FROM candidates c JOIN sources s ON s.id=c.source_id WHERE c.project_id=$1 ORDER BY c.id DESC',[p])).rows:[];const history=includeHistory?(await c.query('SELECT f.subject,f.predicate,r.version,r.value,s.title source,r.created_at FROM revisions r JOIN facts f ON f.id=r.fact_id JOIN sources s ON s.id=r.source_id WHERE r.project_id=$1 ORDER BY r.id DESC',[p])).rows:[];const audit=includeAudit?(await c.query('SELECT * FROM audit WHERE project_id=$1 ORDER BY id DESC LIMIT 100',[p])).rows:[];return {sourceTextIsUntrusted:true,role:r,...(includeFacts?{facts}:{}),...(includeSources?{sources}:{}),...(includeCandidates?{candidates}:{}),...(includeHistory?{history}:{}),...(includeAudit?{audit}:{})}},{snapshot:true})}
function factsSearch(q,searchMode){
  let search;try{search=parseSearchQuery(q,searchMode)}catch(error){throw fail(400,error.code)}
  const matching=search?`NOT EXISTS (SELECT 1 FROM unnest($2::text[]) AS terms(term)
    WHERE NOT (position(lower(term) in lower(f.subject))>0
      OR position(lower(term) in lower(f.predicate))>0
      OR position(lower(term) in lower(r.value))>0))`:
    "position(lower($2) in lower(f.subject||' '||f.predicate||' '||r.value))>0";
  return {search,matching,parameter:search?search.terms:q};
}
async function readFactsPage(user,p,q,{limit=50,after=0,searchMode='substring'}={}){
  const {search,matching,parameter}=factsSearch(q,searchMode);
  return tx(user,async c=>{
    const r=await role(c,p,['owner','member','viewer']);
    const rows=(await c.query(`SELECT f.id,f.subject,f.predicate,f.version,r.value,s.title source
      FROM facts f JOIN revisions r ON r.id=f.current_revision_id JOIN sources s ON s.id=r.source_id
      WHERE f.project_id=$1 AND f.id>$3
        AND ${matching}
      ORDER BY f.id LIMIT $4`,[p,parameter,after,limit+1])).rows;
    const more=rows.length>limit,facts=rows.slice(0,limit);
    return {role:r,facts,next_after:more?facts[facts.length-1].id:null,...(search?{search}:{})};
  },{snapshot:true});
}
function provenanceRecord(row,access,{sourceReference=false}={}){
  return {sourceTextIsUntrusted:true,role:access,fact:{id:row.fact_id,subject:row.subject,predicate:row.predicate},
    revision:{id:row.revision_id,version:row.version,value:row.value,created_at:row.created_at,approved_by:row.approved_by},
    ...(sourceReference?{sourceId:row.source_id}:{source:{id:row.source_id,title:row.title,content:row.content}}),
    candidate:{id:row.candidate_id,expected_version:row.expected_version,proposed_by:row.proposed_by}};
}
// Read-only POST: explicit version pairs avoid URL limits, but retain session CSRF checks.
app.post('/api/projects/:p/facts/provenance',requireJsonObject,route(async(req,res)=>{
  const p=num(req.params.p),refs=req.body.facts;
  if(Object.keys(req.body).some(key=>key!=='facts')||!Array.isArray(refs)||refs.length<1||refs.length>25)throw fail(400,'依据批次必须包含 1 到 25 个版本引用');
  const seen=new Set();
  for(const ref of refs){
    if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).length!==2||!Object.hasOwn(ref,'id')||!Object.hasOwn(ref,'version')||typeof ref.id!=='number'||typeof ref.version!=='number')throw fail(400,'版本引用必须包含数字 id 和 version');
    num(ref.id);integer(ref.version,1,'版本无效');
    const key=`${ref.id}:${ref.version}`;
    if(seen.has(key))throw fail(400,'版本引用不能重复');
    seen.add(key);
  }
  res.json(await tx(req.user.id,async c=>{
    const access=await role(c,p,['owner','member','viewer']);
    const rows=(await c.query(`SELECT f.id AS fact_id,f.subject,f.predicate,
      r.id AS revision_id,r.version,r.value,r.created_at,r.approved_by,
      s.id AS source_id,s.title,s.content,c.id AS candidate_id,c.expected_version,c.proposed_by
      FROM unnest($2::int[],$3::int[]) WITH ORDINALITY AS requested(id,version,ordinal)
      JOIN facts f ON f.id=requested.id AND f.project_id=$1
      JOIN revisions r ON r.fact_id=f.id AND r.project_id=f.project_id AND r.version=requested.version
      JOIN sources s ON s.id=r.source_id AND s.project_id=r.project_id
      JOIN candidates c ON c.id=r.candidate_id AND c.project_id=r.project_id
      ORDER BY requested.ordinal`,[p,refs.map(ref=>ref.id),refs.map(ref=>ref.version)])).rows;
    if(rows.length!==refs.length)throw fail(404,'事实或修订不存在');
    return {sourceTextIsUntrusted:true,role:access,provenance:rows.map(row=>provenanceRecord(row,access))};
  },{snapshot:true}));
}));
app.get('/api/projects/:p/facts/:id/provenance',route(async(req,res)=>{
  const p=num(req.params.p),id=num(req.params.id);
  const version=req.query.version===undefined?null:integer(req.query.version,1,'版本无效');
  res.json(await tx(req.user.id,async c=>{
    const access=await role(c,p,['owner','member','viewer']);
    const row=(await c.query(`SELECT f.id AS fact_id,f.subject,f.predicate,
      r.id AS revision_id,r.version,r.value,r.created_at,r.approved_by,
      s.id AS source_id,s.title,s.content,c.id AS candidate_id,c.expected_version,c.proposed_by
      FROM facts f JOIN revisions r ON r.fact_id=f.id AND r.project_id=f.project_id
      JOIN sources s ON s.id=r.source_id AND s.project_id=r.project_id
      JOIN candidates c ON c.id=r.candidate_id AND c.project_id=r.project_id
      WHERE f.project_id=$1 AND f.id=$2
        AND (($3::int IS NULL AND r.id=f.current_revision_id) OR r.version=$3)`,[p,id,version])).rows[0];
    if(!row)throw fail(404,'事实或修订不存在');
    return provenanceRecord(row,access);
  },{snapshot:true}));
}));
function factsRequest(req,{defaultLimit=50,maxLimit=100}={}){
  const p=num(req.params.p),limit=req.query.limit===undefined?defaultLimit:integer(req.query.limit,1,'分页大小无效');
  if(limit>maxLimit)throw fail(400,`分页大小必须在 1 到 ${maxLimit} 之间`);
  const after=req.query.after===undefined?0:integer(req.query.after,0,'游标无效');
  if(req.query.q!==undefined&&typeof req.query.q!=='string')throw fail(400,'关键词必须是单个字符串');
  const searchMode=req.query.match===undefined?'substring':req.query.match;
  const q=searchMode==='all_terms'?(req.query.q||''):queryText(req.query.q||'',200);
  return {p,q,limit,after,searchMode};
}
app.get('/api/projects/:p/facts',route(async(req,res)=>{
  const {p,q,limit,after,searchMode}=factsRequest(req);
  res.json(await readFactsPage(req.user.id,p,q,{limit,after,searchMode}));
}));
app.get('/api/projects/:p/context',route(async(req,res)=>{
  const {p,q,limit,after,searchMode}=factsRequest(req,{defaultLimit:25,maxLimit:25});
  const {search,matching,parameter}=factsSearch(q,searchMode);
  const page=await tx(req.user.id,async c=>{
    const access=await role(c,p,['owner','member','viewer']);
    // Keep broken references visible so missing evidence fails the page, never drops a fact.
    const rows=(await c.query(`SELECT f.id,f.subject,f.predicate,f.version,r.value,
      r.id AS revision_id,r.source_id
      FROM facts f LEFT JOIN revisions r ON r.id=f.current_revision_id AND r.project_id=f.project_id AND r.fact_id=f.id AND r.version=f.version
      WHERE f.project_id=$1 AND f.version>0 AND f.id>$3 AND (r.id IS NULL OR (${matching}))
      ORDER BY f.id LIMIT $4`,[p,parameter,after,limit+1])).rows;
    if(rows.some(row=>!row.revision_id||!row.source_id))throw fail(500,'上下文依据不完整');
    const selected=rows.slice(0,limit);
    const proofRows=selected.length?(await c.query(`SELECT f.id AS fact_id,f.subject,f.predicate,
      r.id AS revision_id,r.version,r.value,r.created_at,r.approved_by,r.source_id,
      c.id AS candidate_id,c.expected_version,c.proposed_by,c.source_id AS candidate_source_id,
      c.subject AS candidate_subject,c.predicate AS candidate_predicate,c.value AS candidate_value,c.status AS candidate_status
      FROM unnest($2::int[],$3::int[]) WITH ORDINALITY AS requested(id,version,ordinal)
      LEFT JOIN facts f ON f.id=requested.id AND f.project_id=$1
      LEFT JOIN revisions r ON r.fact_id=f.id AND r.project_id=f.project_id AND r.version=requested.version
      LEFT JOIN candidates c ON c.id=r.candidate_id AND c.project_id=r.project_id
      ORDER BY requested.ordinal`,[p,selected.map(row=>row.id),selected.map(row=>row.version)])).rows:[];
    if(proofRows.length!==selected.length||proofRows.some((row,i)=>{
      const fact=selected[i];return row.fact_id!==fact.id||row.revision_id!==fact.revision_id||row.version!==fact.version||row.value!==fact.value||row.source_id!==fact.source_id||!row.candidate_id||row.expected_version!==row.version-1||row.candidate_source_id!==row.source_id||row.candidate_subject!==row.subject||row.candidate_predicate!==row.predicate||row.candidate_value!==row.value||row.candidate_status!=='approved';
    }))throw fail(500,'上下文依据不完整');
    const sourceIds=[...new Set(proofRows.map(row=>row.source_id))];
    const sourceRows=sourceIds.length?(await c.query('SELECT id,title,content FROM sources WHERE project_id=$1 AND id=ANY($2::int[])',[p,sourceIds])).rows:[];
    const sourcesById=new Map(sourceRows.map(source=>[source.id,source]));
    if(sourceRows.length!==sourceIds.length||sourceIds.some(id=>!sourcesById.has(id)))throw fail(500,'上下文依据不完整');
    return {...snapshotReceipt(),projectId:p,query:q,limit,after,role:access,sourceTextIsUntrusted:true,
      facts:selected.map(({revision_id,source_id,...fact})=>({...fact,revisionId:revision_id,sourceId:source_id})),
      provenance:proofRows.map(row=>provenanceRecord(row,access,{sourceReference:true})),
      sources:sourceIds.map(id=>sourcesById.get(id)),next_after:rows.length>limit?selected.at(-1).id:null,...(search?{search}:{})};
  },{snapshot:true});
  const serialized=JSON.stringify(page);
  if(Buffer.byteLength(serialized,'utf8')>SNAPSHOT_MAX_BYTES)throw fail(500,'上下文响应超出大小限制');
  res.type('application/json').send(serialized);
}));
async function readHistoryPage(user,p,{limit=25,before=null}={}){
  return tx(user,async c=>{
    const r=await role(c,p,['owner','member','viewer']);
    const rows=(await c.query(`SELECT r.id,r.fact_id,f.subject,f.predicate,r.version,r.value,s.title source,r.created_at
      FROM revisions r JOIN facts f ON f.id=r.fact_id JOIN sources s ON s.id=r.source_id
      WHERE r.project_id=$1 AND ($2::int IS NULL OR r.id<$2)
      ORDER BY r.id DESC LIMIT $3`,[p,before,limit+1])).rows;
    const more=rows.length>limit,history=rows.slice(0,limit);
    return {role:r,history,next_before:more?history[history.length-1].id:null};
  },{snapshot:true});
}
app.get('/api/projects/:p/history',route(async(req,res)=>{
  const p=num(req.params.p),limit=req.query.limit===undefined?25:integer(req.query.limit,1,'分页大小无效');
  if(limit>100)throw fail(400,'分页大小必须在 1 到 100 之间');
  const before=req.query.before===undefined?null:integer(req.query.before,1,'游标无效');
  res.json(await readHistoryPage(req.user.id,p,{limit,before}));
}));
async function readCandidatesPage(user,p,{limit=25,before=null,status='all'}={}){
  return tx(user,async c=>{
    const r=await role(c,p,['owner','member','viewer']);
    const rows=(await c.query(`SELECT c.*,s.title source FROM candidates c JOIN sources s ON s.id=c.source_id
      WHERE c.project_id=$1 AND ($2::int IS NULL OR c.id<$2) AND ($3='all' OR c.status=$3)
      ORDER BY c.id DESC LIMIT $4`,[p,before,status,limit+1])).rows;
    const more=rows.length>limit,candidates=rows.slice(0,limit);
    return {role:r,candidates,next_before:more?candidates[candidates.length-1].id:null};
  },{snapshot:true});
}
app.get('/api/projects/:p/audit',route(async(req,res)=>{
  const p=num(req.params.p),limit=req.query.limit===undefined?25:integer(req.query.limit,1,'分页大小无效');
  if(limit>100)throw fail(400,'分页大小必须在 1 到 100 之间');
  const before=req.query.before===undefined?null:integer(req.query.before,1,'游标无效');
  res.json(await tx(req.user.id,async c=>{
    const r=await role(c,p,['owner','member','viewer']);
    const rows=(await c.query('SELECT * FROM audit WHERE project_id=$1 AND ($2::int IS NULL OR id<$2) ORDER BY id DESC LIMIT $3',[p,before,limit+1])).rows;
    const audit=rows.slice(0,limit);
    return {sourceTextIsUntrusted:true,role:r,audit,next_before:rows.length>limit?audit[audit.length-1].id:null};
  },{snapshot:true}));
}));
app.get('/api/projects/:p/candidates',route(async(req,res)=>{
  const p=num(req.params.p),limit=req.query.limit===undefined?25:integer(req.query.limit,1,'分页大小无效');
  if(limit>100)throw fail(400,'分页大小必须在 1 到 100 之间');
  const before=req.query.before===undefined?null:integer(req.query.before,1,'游标无效');
  const status=req.query.status===undefined?'all':req.query.status;
  if(!['all','pending','approved','rejected'].includes(status))throw fail(400,'候选状态无效');
  res.json(await readCandidatesPage(req.user.id,p,{limit,before,status}));
}));
async function readSourcesPage(user,p,q,{limit=25,after=0}={}){
  return tx(user,async c=>{
    const r=await role(c,p,['owner','member','viewer']);
    const rows=(await c.query(`SELECT id,title,content FROM sources
      WHERE project_id=$1 AND id>$3 AND position(lower($2) in lower(title))>0
      ORDER BY id LIMIT $4`,[p,q,after,limit+1])).rows;
    const more=rows.length>limit,sources=rows.slice(0,limit);
    return {sourceTextIsUntrusted:true,role:r,sources,next_after:more?sources[sources.length-1].id:null};
  },{snapshot:true});
}
app.get('/api/projects/:p/sources',route(async(req,res)=>{
  const p=num(req.params.p),limit=req.query.limit===undefined?25:integer(req.query.limit,1,'分页大小无效');
  if(limit>100)throw fail(400,'分页大小必须在 1 到 100 之间');
  const after=req.query.after===undefined?0:integer(req.query.after,0,'游标无效');
  if(req.query.q!==undefined&&typeof req.query.q!=='string')throw fail(400,'来源标题关键词必须是单个字符串');
  res.json(await readSourcesPage(req.user.id,p,queryText(req.query.q||'',150),{limit,after}));
}));
app.get('/api/projects/:p/data',route(async(req,res)=>{for(const key of ['include_facts','include_history','include_candidates','include_sources','include_audit'])if(req.query[key]!==undefined&&!['true','false'].includes(req.query[key]))throw fail(400,`${key} 必须是 true 或 false`);const p=num(req.params.p),q=typeof req.query.q==='string'?queryText(req.query.q,200):'';res.json(await readProject(req.user.id,p,q,{includeFacts:req.query.include_facts!=='false',includeHistory:req.query.include_history!=='false',includeCandidates:req.query.include_candidates!=='false',includeSources:req.query.include_sources!=='false',includeAudit:req.query.include_audit!=='false'}))}));
app.post('/api/projects/:p/sources',requireJsonObject,route(async(req,res)=>{
  const p=num(req.params.p),title=str(req.body.title,150),content=str(req.body.content,4000),key=requestKey(req);
  res.json(await tx(req.user.id,async c=>{
    await role(c,p,['owner','member']);
    return createOnce(c,{project:p,user:req.user.id,operation:'sources',key,payload:[title,content]},async()=>{
      const r=await c.query('INSERT INTO sources(project_id,title,content) VALUES($1,$2,$3) RETURNING *',[p,title,content]);
      await c.query('INSERT INTO audit(project_id,actor_id,action,detail) VALUES($1,$2,$3,$4)',[p,req.user.id,'source',`新增来源 ${r.rows[0].id}`]);
      return r.rows[0];
    });
  }));
}));
app.get('/api/projects/:p/candidates/:id/source',route(async(req,res)=>{
  const p=num(req.params.p),id=num(req.params.id);
  res.json(await tx(req.user.id,async c=>{
    const access=await role(c,p,['owner','member','viewer']);
    const row=(await c.query(`SELECT c.id,c.subject,c.predicate,c.value,c.expected_version,c.status,c.source_id,s.title,s.content
      FROM candidates c JOIN sources s ON s.id=c.source_id AND s.project_id=c.project_id
      WHERE c.project_id=$1 AND c.id=$2`,[p,id])).rows[0];
    if(!row)throw fail(404,'候选不存在');
    const current=(await c.query(`SELECT f.id AS fact_id,f.version,r.value,r.source_id,r.candidate_id,s.title AS source_title
      FROM facts f JOIN revisions r ON r.id=f.current_revision_id JOIN sources s ON s.id=r.source_id
      WHERE f.project_id=$1 AND f.subject=$2 AND f.predicate=$3`,[p,row.subject,row.predicate])).rows[0]||null;
    const {title,content,...candidate}=row;return {sourceTextIsUntrusted:true,role:access,candidate,source:{id:row.source_id,title,content},current,
      comparison:{expectedVersion:row.expected_version,currentVersion:current?.version||0,matches:row.expected_version===(current?.version||0)}};
  },{snapshot:true}));
}));
app.post('/api/projects/:p/candidates',requireJsonObject,route(async(req,res)=>{
  const p=num(req.params.p),subject=str(req.body.subject,100),predicate=str(req.body.predicate,100),value=str(req.body.value,1000),source=num(req.body.source_id),expected=integer(req.body.expected_version,0,'版本无效'),key=requestKey(req);
  res.json(await tx(req.user.id,async c=>{
    await role(c,p,['owner','member']);
    return createOnce(c,{project:p,user:req.user.id,operation:'candidates',key,payload:[subject,predicate,value,source,expected]},async()=>{
      if(!(await c.query('SELECT id FROM sources WHERE id=$1 AND project_id=$2',[source,p])).rowCount)throw fail(400,'来源不存在或不属于此项目');
      const r=await c.query('INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[p,subject,predicate,value,source,expected,req.user.id]);
      await c.query('INSERT INTO audit(project_id,actor_id,action,detail) VALUES($1,$2,$3,$4)',[p,req.user.id,'propose',`候选 ${r.rows[0].id}`]);
      return r.rows[0];
    });
  }));
}));
async function decide(c,user,p,id,decision,inject){await role(c,p,['owner']);const ca=(await c.query('SELECT * FROM candidates WHERE id=$1 AND project_id=$2 FOR UPDATE',[id,p])).rows[0];if(!ca)throw fail(404,'候选不存在');if(ca.status!=='pending')throw fail(409,'该候选已处理，未重复创建版本');if(decision==='reject'){await c.query("UPDATE candidates SET status='rejected' WHERE id=$1",[id]);await c.query('INSERT INTO audit(project_id,actor_id,action,detail) VALUES($1,$2,$3,$4)',[p,user,'reject',`候选 ${id}`]);return {status:'rejected'}}
// A transaction-scoped lock serializes even the first creation of a key.
await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([p,ca.subject,ca.predicate])]);let f=(await c.query('SELECT * FROM facts WHERE project_id=$1 AND subject=$2 AND predicate=$3 FOR UPDATE',[p,ca.subject,ca.predicate])).rows[0];let v=f?.version||0;if(v!==ca.expected_version)throw fail(409,`版本冲突：候选基于 v${ca.expected_version}，当前为 v${v}，请重新提议`);if(!f)f=(await c.query('INSERT INTO facts(project_id,subject,predicate) VALUES($1,$2,$3) RETURNING *',[p,ca.subject,ca.predicate])).rows[0];const rev=(await c.query('INSERT INTO revisions(project_id,fact_id,version,value,source_id,candidate_id,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[p,f.id,v+1,ca.value,ca.source_id,id,user])).rows[0];if(inject)throw new Error('injected failure');await c.query('UPDATE facts SET version=$1,current_revision_id=$2 WHERE id=$3',[v+1,rev.id,f.id]);await c.query("UPDATE candidates SET status='approved' WHERE id=$1",[id]);await c.query('INSERT INTO audit(project_id,actor_id,action,detail) VALUES($1,$2,$3,$4)',[p,user,'approve',`候选 ${id} → v${v+1}`]);return {status:'approved',version:v+1}}
app.post('/api/projects/:p/candidates/:id/:decision',route(async(req,res)=>{const p=num(req.params.p),id=num(req.params.id),d=req.params.decision;if(!['approve','reject'].includes(d))throw fail(400,'操作无效');res.json(await tx(req.user.id,c=>decide(c,req.user.id,p,id,d)))}));
app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在'}));
app.use(express.static('public'));
app.use((err,req,res,next)=>{
  const parseErrors={
    'entity.parse.failed':[400,'JSON 格式无效'],
    'entity.too.large':[413,'请求体超过 16 KiB 限制'],
    'charset.unsupported':[415,'JSON 字符集不受支持'],
    'encoding.unsupported':[415,'请求体编码不受支持'],
    'request.aborted':[400,'请求体不完整'],
    'request.size.invalid':[400,'请求体长度无效']
  };
  const databaseFailure=databaseErrorKind(err);
  const unavailableMessage=['GET','HEAD'].includes(req.method)?(databaseFailure==='timeout'?'数据库请求超时，请稍后重试':'数据库暂时不可用，请稍后重试'):'数据库连接中断，写入结果可能不确定；请先核实，创建重试请复用原幂等键';
  const [status,message]=parseErrors[err.type]||(databaseFailure?[503,unavailableMessage]:null)||(['Z_DATA_ERROR','Z_BUF_ERROR'].includes(err.code)?[400,'压缩请求体无效']:[err.status||500,err.status&&err.status<500?err.message:'请求无法处理']);
  if(status>=500)console.error('Request failed:',safeErrorCode(err));
  if(res.headersSent)return next(err);
  res.status(status).json({error:message});
});
if(require.main===module){const server=app.listen(process.env.PORT||3000,'127.0.0.1',()=>console.log(`Memz http://127.0.0.1:${server.address().port}`))}
module.exports={app,pool,tx,decide,readProject,readFactsPage,readHistoryPage,readCandidatesPage,readSourcesPage};
