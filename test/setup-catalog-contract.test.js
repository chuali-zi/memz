// Synthetic catalog receipts only; never open a PostgreSQL connection.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Client}=require('pg');
const {inspectSetupCatalog}=require('../scripts/setup-catalog');
const {checkSetup}=require('../scripts/check-setup');
const good=()=>({safe_role:true,missing:[],owner_access:false,rls:true,can_read:true,migrated:true,function_execute:true,columns_valid:true,read_policies:true,runtime_valid:true,active_present:true,active_valid:true,identity_contract:true,identity_owner_valid:true});
async function inspect(changes={}){
  let calls=0;
  const result=await inspectSetupCatalog({query:async(sql,params)=>{
    calls++;assert.ok(sql.startsWith('WITH required AS'));assert.equal(params.length,5);assert.ok(Buffer.byteLength(JSON.stringify(params))<8192);
    assert.equal(params[3],"SELECT role FROM public.memberships WHERE project_id=p AND user_id=nullif(pg_catalog.current_setting('app.user_id',true),'')::pg_catalog.int4 AND active IS TRUE");
    assert.equal(params[4],'memz:member-role-active-v1');
    // The body is a bound metadata comparison, never a call to member_role or
    // a SELECT from memberships with a fabricated application identity.
    assert.doesNotMatch(sql,/FROM\s+(?:public\.)?memberships\b/i);
    return {rows:[{...good(),...changes}]};
  }});
  assert.equal(calls,1);return result;
}
test('migration 003 catalog classification distinguishes missing, unsupported and supported metadata',async()=>{
  assert.deepEqual(await inspect(),{code:'BASIC_CHECKS_PASSED'});
  assert.deepEqual(await inspect({active_present:false,active_valid:false,identity_contract:false}),{code:'MIGRATION_REQUIRED'});
  assert.deepEqual(await inspect({active_valid:false}),{code:'SCHEMA_PREREQUISITES'});
  assert.deepEqual(await inspect({identity_contract:false}),{code:'MIGRATION_REQUIRED'});
  assert.deepEqual(await inspect({identity_owner_valid:false}),{code:'SCHEMA_PREREQUISITES'});
  assert.deepEqual(await inspect({identity_owner_valid:false,active_present:false,active_valid:false,identity_contract:false}),{code:'SCHEMA_PREREQUISITES'});
});
test('all earlier diagnostic priorities precede the new membership migration checks',async()=>{
  const absent={active_present:false,active_valid:false,identity_contract:false,identity_owner_valid:false};
  for(const [changes,code] of [
    [{safe_role:false,missing:['facts'],owner_access:true},'UNSAFE_DATABASE_ROLE'],
    [{missing:['sources','idempotency_requests'],owner_access:true},'SCHEMA_MISSING'],
    [{owner_access:true,missing:['idempotency_requests']},'UNSAFE_DATABASE_ROLE'],
    [{missing:['idempotency_requests'],rls:false},'MIGRATION_REQUIRED'],
    [{rls:false,can_read:false},'RLS_DISABLED'],[{can_read:false,migrated:false},'SCHEMA_PERMISSIONS'],
    [{migrated:false,function_execute:false},'MIGRATION_REQUIRED'],[{function_execute:false,columns_valid:false},'SCHEMA_PERMISSIONS'],
    [{columns_valid:false},'SCHEMA_PREREQUISITES'],[{read_policies:false},'SCHEMA_PREREQUISITES'],[{runtime_valid:false},'SCHEMA_PREREQUISITES']
  ])assert.equal((await inspect({...absent,...changes})).code,code);
});
test('missing or nonboolean migration metadata fails closed without reflecting catalog values',async()=>{
  for(const key of ['active_present','active_valid','identity_contract','identity_owner_valid'])for(const value of [undefined,null,1,'synthetic-private']){
    await assert.rejects(()=>inspect({[key]:value}),error=>error.message==='SETUP_CATALOG_INVALID'&&error.cause===undefined);
  }
});
test('new schema and migration 003 use the same exact source and marker as the catalog contract',async()=>{
  let source,marker;
  await inspectSetupCatalog({query:async(sql,params)=>{source=params[3];marker=params[4];return {rows:[good()]}}});
  for(const file of ['db/schema.sql','db/migrations/003-membership-active.sql']){
    const sql=fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');
    const definition=sql.match(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?member_role\(p int\)[^\n]*?AS \$\$([\s\S]*?)\$\$/);
    assert.ok(definition,file);assert.equal(definition[1],source,file);
    assert.ok(sql.includes(`COMMENT ON FUNCTION ${file.includes('migrations')?'public.':''}member_role(integer) IS '${marker}'`),file);
  }
});
test('doctor action includes 003 while legacy missing-table details keep priority',async()=>{
  const original={connect:Client.prototype.connect,query:Client.prototype.query,end:Client.prototype.end};let row,queries=0;
  Client.prototype.connect=async()=>{};Client.prototype.end=async()=>{};
  Client.prototype.query=async function(sql){queries++;return {rows:sql.startsWith('WITH required AS')?[row]:[]}};
  try{
    row={...good(),active_present:false,active_valid:false,identity_contract:false};
    const missing=await checkSetup('postgres://synthetic:synthetic@127.0.0.1:9/catalog_only');
    assert.equal(missing.code,'MIGRATION_REQUIRED');assert.match(missing.message,/001、002、003/);assert.equal(missing.ok,false);assert.equal(queries,3);
    row={...row,missing:['idempotency_requests']};const legacy=await checkSetup('postgres://synthetic:synthetic@127.0.0.1:9/catalog_only');
    assert.equal(legacy.code,'MIGRATION_REQUIRED');assert.deepEqual(legacy.details,{missing:['idempotency_requests']});
  }finally{Object.assign(Client.prototype,original)}
});
