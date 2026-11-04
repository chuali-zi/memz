const express=require('express'), cookieParser=require('cookie-parser'), crypto=require('crypto');
const {Pool}=require('pg');
const {requestKey,createOnce}=require('./idempotency');
const app=express();
const pool=new Pool({connectionString:process.env.DATABASE_URL || 'postgres://memz_app:memz_demo_only@127.0.0.1:5432/memz',max:10});
const accounts={owner:{id:1,password:'demo-owner',name:'负责人'},member:{id:2,password:'demo-member',name:'成员'},viewer:{id:3,password:'demo-viewer',name:'只读者'},other:{id:4,password:'demo-other',name:'另一项目用户'}};
const sessions=new Map();
app.disable('x-powered-by');
app.use((req,res,next)=>{res.set('X-Content-Type-Options','nosniff');res.set('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"); next()});
app.use(express.json({limit:'16kb',verify:(req,res,buffer)=>{req.jsonBodyBytes=buffer.length}})); app.use(cookieParser());
app.post('/api/login',requireJsonObject,(req,res)=>{if(req.get('origin') && req.get('origin')!==`${req.protocol}://${req.get('host')}`) return res.status(403).json({error:'请求来源无效'}); const a=typeof req.body.username==='string'&&Object.hasOwn(accounts,req.body.username) ? accounts[req.body.username] : null;if(!a||typeof req.body?.password!=='string'||a.password!==req.body.password)return res.status(401).json({error:'账号或密码错误'});const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');sessions.set(token,{...a,csrf,expires:Date.now()+8*3600000});res.cookie('sid',token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',maxAge:8*3600000});res.json({name:a.name,csrf})});
app.use('/api',(req,res,next)=>{req.user=sessions.get(req.cookies.sid);if(req.user && req.user.expires<Date.now()){sessions.delete(req.cookies.sid);req.user=null}if(!req.user)return res.status(401).json({error:'请先登录'});if(!['GET','HEAD'].includes(req.method)&&req.get('x-csrf-token')!==req.user.csrf)return res.status(403).json({error:'请求校验失败'});next()});
app.post('/api/logout',(req,res)=>{sessions.delete(req.cookies.sid);res.clearCookie('sid');res.json({ok:true})});
app.get('/api/me',(req,res)=>res.json({name:req.user.name,csrf:req.user.csrf}));
async function tx(user,fn,{snapshot=false}={}){const c=await pool.connect();try{await c.query(snapshot?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');await c.query("SELECT set_config('app.user_id',$1,true)",[String(user)]);const out=await fn(c);await c.query('COMMIT');return out}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
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
function str(x,max=500){if(typeof x!=='string'||!x.trim()||x.length>max)throw fail(400,'内容为空或过长');return x.trim()}
async function role(c,p,allowed){const r=(await c.query('SELECT role FROM memberships WHERE project_id=$1 AND user_id=nullif(current_setting(\'app.user_id\',true),\'\')::int',[p])).rows[0];if(!r||!allowed.includes(r.role))throw fail(403,'无权访问此项目或执行此操作');return r.role}
const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
app.get('/api/projects',route(async(req,res)=>res.json(await tx(req.user.id,async c=>(await c.query('SELECT p.id,p.name,m.role FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=$1 ORDER BY p.id',[req.user.id])).rows))));
async function readProject(user,p,q,{includeFacts=true,includeHistory=true}={}){return tx(user,async c=>{const r=await role(c,p,['owner','member','viewer']);const facts=includeFacts?(await c.query(`SELECT f.id,f.subject,f.predicate,f.version,r.value,s.title source FROM facts f JOIN revisions r ON r.id=f.current_revision_id JOIN sources s ON s.id=r.source_id WHERE f.project_id=$1 AND position(lower($2) in lower(f.subject||' '||f.predicate||' '||r.value))>0 ORDER BY f.id`,[p,q])).rows:[];const sources=(await c.query('SELECT id,title,content FROM sources WHERE project_id=$1 ORDER BY id',[p])).rows;const candidates=(await c.query('SELECT c.*,s.title source FROM candidates c JOIN sources s ON s.id=c.source_id WHERE c.project_id=$1 ORDER BY c.id DESC',[p])).rows;const history=includeHistory?(await c.query('SELECT f.subject,f.predicate,r.version,r.value,s.title source,r.created_at FROM revisions r JOIN facts f ON f.id=r.fact_id JOIN sources s ON s.id=r.source_id WHERE r.project_id=$1 ORDER BY r.id DESC',[p])).rows:[];const audit=(await c.query('SELECT * FROM audit WHERE project_id=$1 ORDER BY id DESC LIMIT 100',[p])).rows;return {role:r,...(includeFacts?{facts}:{}),sources,candidates,...(includeHistory?{history}:{}),audit}},{snapshot:true})}
async function readFactsPage(user,p,q,{limit=50,after=0}={}){
  return tx(user,async c=>{
    const r=await role(c,p,['owner','member','viewer']);
    const rows=(await c.query(`SELECT f.id,f.subject,f.predicate,f.version,r.value,s.title source
      FROM facts f JOIN revisions r ON r.id=f.current_revision_id JOIN sources s ON s.id=r.source_id
      WHERE f.project_id=$1 AND f.id>$3
        AND position(lower($2) in lower(f.subject||' '||f.predicate||' '||r.value))>0
      ORDER BY f.id LIMIT $4`,[p,q,after,limit+1])).rows;
    const more=rows.length>limit,facts=rows.slice(0,limit);
    return {role:r,facts,next_after:more?facts[facts.length-1].id:null};
  },{snapshot:true});
}
app.get('/api/projects/:p/facts',route(async(req,res)=>{
  const p=num(req.params.p),limit=req.query.limit===undefined?50:integer(req.query.limit,1,'分页大小无效');
  if(limit>100)throw fail(400,'分页大小必须在 1 到 100 之间');
  const after=req.query.after===undefined?0:integer(req.query.after,0,'游标无效');
  if(req.query.q!==undefined&&typeof req.query.q!=='string')throw fail(400,'关键词必须是单个字符串');
  const q=(req.query.q||'').slice(0,200);
  res.json(await readFactsPage(req.user.id,p,q,{limit,after}));
}));
async function readHistoryPage(user,p,{limit=25,before=null}={}){
  return tx(user,async c=>{
    const r=await role(c,p,['owner','member','viewer']);
    const rows=(await c.query(`SELECT r.id,f.subject,f.predicate,r.version,r.value,s.title source,r.created_at
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
app.get('/api/projects/:p/data',route(async(req,res)=>{for(const key of ['include_facts','include_history'])if(req.query[key]!==undefined&&!['true','false'].includes(req.query[key]))throw fail(400,`${key} 必须是 true 或 false`);const p=num(req.params.p),q=typeof req.query.q==='string'?req.query.q.slice(0,200):'';res.json(await readProject(req.user.id,p,q,{includeFacts:req.query.include_facts!=='false',includeHistory:req.query.include_history!=='false'}))}));
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
  const [status,message]=parseErrors[err.type]||(['Z_DATA_ERROR','Z_BUF_ERROR'].includes(err.code)?[400,'压缩请求体无效']:[err.status||500,err.status&&err.status<500?err.message:'请求无法处理']);
  if(status>=500)console.error('Request failed:',err.code||err.name);
  if(res.headersSent)return next(err);
  res.status(status).json({error:message});
});
if(require.main===module)app.listen(process.env.PORT||3000,'127.0.0.1',()=>console.log('Memz http://127.0.0.1:3000'));
module.exports={app,pool,tx,decide,readProject,readFactsPage,readHistoryPage};
