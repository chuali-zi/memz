// Read-only local-demo diagnostics. Never initialize, migrate or repair a database.
const {Client}=require('pg');
const {inspectSetupCatalog}=require('./setup-catalog');
const messages={
  LOCAL_DATABASE_REQUIRED:'仅检查本机 TCP 数据库；请核对 DATABASE_URL，不要在此命令中使用外部数据库。',
  DATABASE_UNAVAILABLE:'无法完成数据库连接或查询；请检查本机服务、认证和连接配置。连接串不会输出。',
  UNSAFE_DATABASE_ROLE:'应用连接使用了管理员、可绕过 RLS 或表 owner 权限；请改用 memz_app 应用连接，管理员仅用于备份与迁移。',
  SCHEMA_MISSING:'缺少基本表；请核对是否连接正确数据库。只有全新空库才执行首次初始化，不要覆盖或删除已有数据。',
  MIGRATION_REQUIRED:'缺少迁移前提；暂停写入并备份，按 README 顺序执行 001、002、003 增量迁移，不要重跑 schema.sql 或删除卷。',
  RLS_DISABLED:'所需表未启用 RLS；请由维护者核对 schema 和迁移，不自动改变权限。',
  SCHEMA_PERMISSIONS:'应用角色缺少所需读取或身份函数权限；请核对应用连接与 schema 授权。',
  SCHEMA_PREREQUISITES:'列、类型、读取策略或运行时 schema/RLS 前提不符；请由维护者核对 schema、授权和连接设置，不自动修复。',
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
    const report=await inspectSetupCatalog(client);
    return result(report.code,report.details);
  }catch{return result('DATABASE_UNAVAILABLE')}
  finally{if(transaction)try{await client.query('ROLLBACK')}catch{}if(client)try{await client.end()}catch{}}
}
if(require.main===module)checkSetup().then(report=>{process.stdout.write(JSON.stringify(report,null,2)+'\n');if(!report.ok)process.exitCode=1});
module.exports={checkSetup};
