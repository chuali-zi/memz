// Read-only local-demo diagnostics. Never initialize, migrate or repair a database.
const {Client}=require('pg');
const tables=['projects','memberships','sources','candidates','facts','revisions','audit','idempotency_requests'];
const messages={
  LOCAL_DATABASE_REQUIRED:'仅检查本机 TCP 数据库；请核对 DATABASE_URL，不要在此命令中使用外部数据库。',
  DATABASE_UNAVAILABLE:'无法完成数据库连接或查询；请检查本机服务、认证和连接配置。连接串不会输出。',
  UNSAFE_DATABASE_ROLE:'应用连接使用了管理员、可绕过 RLS 或表 owner 权限；请改用 memz_app 应用连接，管理员仅用于备份与迁移。',
  SCHEMA_MISSING:'缺少基本表；请核对是否连接正确数据库。只有全新空库才执行首次初始化，不要覆盖或删除已有数据。',
  MIGRATION_REQUIRED:'缺少迁移前提；暂停写入并备份，按 README 顺序执行 001、002 增量迁移，不要重跑 schema.sql 或删除卷。',
  RLS_DISABLED:'所需表未启用 RLS；请由维护者核对 schema 和迁移，不自动改变权限。',
  SCHEMA_PERMISSIONS:'应用角色缺少所需读取或身份函数权限；请核对应用连接与 schema 授权。',
  BASIC_CHECKS_PASSED:'基本连接、角色、表、RLS、迁移约束名称及读取权限检查通过；仍需完成登录、写入/审批演示或隔离系统测试。'
};
const result=(code,details)=>({ok:code==='BASIC_CHECKS_PASSED',code,message:messages[code],...(details?{details}:{})});
async function checkSetup(connectionString=process.env.DATABASE_URL||'postgres://memz_app:memz_demo_only@127.0.0.1:5432/memz'){
  let client,transaction=false;
  try{
    // pg merges URL parameters over connection settings. The diagnostic owns
    // its deadlines; retain unrelated parameters for resolved-target validation.
    const boundedURL=new URL(connectionString);
    for(const key of ['connectionTimeoutMillis','query_timeout','statement_timeout'])boundedURL.searchParams.delete(key);
    client=new Client({connectionString:boundedURL.href,connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});
    // Validate pg's resolved target, including connection-string query overrides.
    if(!['127.0.0.1','localhost','::1','[::1]'].includes(client.host)||!Number.isInteger(Number(client.port))||Number(client.port)<1||Number(client.port)>65535)return result('LOCAL_DATABASE_REQUIRED');
    client.on('error',()=>{});await client.connect();
    await client.query('BEGIN READ ONLY');transaction=true;
    const role=(await client.query('SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
    if(!role||role.rolsuper||role.rolbypassrls||role.rolcreaterole)return result('UNSAFE_DATABASE_ROLE');
    const relations=(await client.query("SELECT c.relname,c.relrowsecurity,pg_has_role(current_user,c.relowner,'USAGE') AS owner_access,has_table_privilege(current_user,c.oid,'SELECT') AS can_read FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1)",[tables])).rows;
    const missing=tables.filter(name=>!relations.some(r=>r.relname===name));
    if(missing.some(name=>name!=='idempotency_requests'))return result('SCHEMA_MISSING',{missing});
    if(relations.some(r=>r.owner_access))return result('UNSAFE_DATABASE_ROLE');
    if(missing.length)return result('MIGRATION_REQUIRED',{missing});
    if(relations.some(r=>!r.relrowsecurity))return result('RLS_DISABLED');
    if(relations.some(r=>!r.can_read))return result('SCHEMA_PERMISSIONS');
    const constraints=(await client.query("SELECT conname FROM pg_constraint WHERE conrelid='public.facts'::regclass AND convalidated AND conname=ANY($1)",[['facts_current_revision_fk','facts_current_revision_state']])).rows;
    if(constraints.length!==2)return result('MIGRATION_REQUIRED');
    const func=(await client.query("SELECT to_regprocedure('public.member_role(integer)') AS id")).rows[0].id;
    if(!func||!(await client.query("SELECT has_function_privilege(current_user,$1::regprocedure,'EXECUTE') AS allowed",[func])).rows[0].allowed)return result('SCHEMA_PERMISSIONS');
    return result('BASIC_CHECKS_PASSED');
  }catch{return result('DATABASE_UNAVAILABLE')}
  finally{if(transaction)try{await client.query('ROLLBACK')}catch{}if(client)try{await client.end()}catch{}}
}
if(require.main===module)checkSetup().then(report=>{process.stdout.write(JSON.stringify(report,null,2)+'\n');if(!report.ok)process.exitCode=1});
module.exports={checkSetup};
