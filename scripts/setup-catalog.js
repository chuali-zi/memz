// Fixed catalog-only prerequisites. The caller owns connection and transaction;
// this helper never creates a client, reads application rows or repairs schema.
const TABLES=Object.freeze(['projects','memberships','sources','candidates','facts','revisions','audit','idempotency_requests']);
const columns={
  projects:{id:'int4',name:'text'},
  memberships:{project_id:'int4',user_id:'int4',role:'text'},
  sources:{id:'int4',project_id:'int4',title:'text',content:'text'},
  candidates:{id:'int4',project_id:'int4',subject:'text',predicate:'text',value:'text',source_id:'int4',expected_version:'int4',proposed_by:'int4',status:'text',created_at:'timestamptz'},
  facts:{id:'int4',project_id:'int4',subject:'text',predicate:'text',version:'int4',current_revision_id:'int4'},
  revisions:{id:'int4',project_id:'int4',fact_id:'int4',version:'int4',value:'text',source_id:'int4',candidate_id:'int4',approved_by:'int4',created_at:'timestamptz'},
  audit:{id:'int4',project_id:'int4',actor_id:'int4',action:'text',detail:'text',created_at:'timestamptz'},
  idempotency_requests:{project_id:'int4',actor_id:'int4',operation:'text',request_key:'text',request_hash:'text',response:'jsonb',created_at:'timestamptz'}
};
const requiredColumns=JSON.stringify(Object.entries(columns).flatMap(([table_name,fields])=>Object.entries(fields).map(([column_name,type_name])=>({table_name,column_name,type_name}))));
const CATALOG_SQL=`WITH required AS (SELECT pg_catalog.unnest($1::pg_catalog.text[]) AS name),
  relations AS (
    SELECT required.name,c.oid,c.relrowsecurity,
      (pg_catalog.pg_has_role(current_user,c.relowner,'USAGE') OR pg_catalog.pg_has_role(session_user,c.relowner,'USAGE')) AS owner_access,
      pg_catalog.has_table_privilege(current_user,c.oid,'SELECT') AS can_read
    FROM required LEFT JOIN pg_catalog.pg_namespace n ON n.nspname OPERATOR(pg_catalog.=) 'public'
    LEFT JOIN pg_catalog.pg_class c ON c.relnamespace OPERATOR(pg_catalog.=) n.oid AND c.relname OPERATOR(pg_catalog.=) required.name AND c.relkind OPERATOR(pg_catalog.=) 'r'
  ), identity_function AS (
    SELECT p.oid AS id FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace
    WHERE n.nspname OPERATOR(pg_catalog.=) 'public' AND p.proname OPERATOR(pg_catalog.=) 'member_role'
      AND p.pronargs OPERATOR(pg_catalog.=) 1 AND p.proargtypes[0] OPERATOR(pg_catalog.=) 'pg_catalog.int4'::pg_catalog.regtype::pg_catalog.oid
      AND p.prokind OPERATOR(pg_catalog.=) 'f'
  )
  SELECT
    COALESCE((SELECT pg_catalog.bool_and(NOT (rolsuper OR rolbypassrls OR rolcreaterole)) FROM pg_catalog.pg_roles
      WHERE rolname OPERATOR(pg_catalog.=) current_user OR rolname OPERATOR(pg_catalog.=) session_user),false) AS safe_role,
    ARRAY(SELECT name FROM relations WHERE oid IS NULL ORDER BY pg_catalog.array_position($1::pg_catalog.text[],name)) AS missing,
    EXISTS(SELECT 1 FROM relations WHERE owner_access) AS owner_access,
    COALESCE((SELECT pg_catalog.bool_and(relrowsecurity) FROM relations),false) AS rls,
    COALESCE((SELECT pg_catalog.bool_and(can_read) FROM relations),false) AS can_read,
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint WHERE conrelid OPERATOR(pg_catalog.=) (SELECT oid FROM relations WHERE name OPERATOR(pg_catalog.=) 'facts')
      AND convalidated AND conname OPERATOR(pg_catalog.=) ANY($3::pg_catalog.text[])) OPERATOR(pg_catalog.=) 2 AS migrated,
    COALESCE((SELECT pg_catalog.has_function_privilege(current_user,id,'EXECUTE') FROM identity_function),false) AS function_execute,
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_to_recordset($2::pg_catalog.jsonb) AS expected(table_name pg_catalog.text,column_name pg_catalog.text,type_name pg_catalog.text)
      JOIN relations r ON r.name OPERATOR(pg_catalog.=) expected.table_name
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid OPERATOR(pg_catalog.=) r.oid AND a.attname OPERATOR(pg_catalog.=) expected.column_name AND a.attnum OPERATOR(pg_catalog.>) 0 AND NOT a.attisdropped
      WHERE a.attnum IS NULL OR a.atttypid OPERATOR(pg_catalog.<>) pg_catalog.to_regtype('pg_catalog.' OPERATOR(pg_catalog.||) expected.type_name)
    ) AS columns_valid,
    NOT EXISTS (
      SELECT 1 FROM relations r WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid OPERATOR(pg_catalog.=) r.oid
          AND (p.polcmd OPERATOR(pg_catalog.=) 'r' OR p.polcmd OPERATOR(pg_catalog.=) '*') AND p.polpermissive
          AND EXISTS(SELECT 1 FROM pg_catalog.unnest(p.polroles) AS applicable(role_id)
            WHERE CASE WHEN role_id OPERATOR(pg_catalog.=) 0 THEN true ELSE pg_catalog.pg_has_role(current_user,role_id,'USAGE') END)
      )
    ) AS read_policies,
    COALESCE(pg_catalog.current_setting('row_security') OPERATOR(pg_catalog.=) 'on'
      AND pg_catalog.has_schema_privilege(current_user,(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname OPERATOR(pg_catalog.=) 'public'),'USAGE')
      AND (SELECT pg_catalog.bool_and(COALESCE(pg_catalog.to_regclass(name)::pg_catalog.oid OPERATOR(pg_catalog.=) oid,false)) FROM relations)
      AND CASE WHEN pg_catalog.has_schema_privilege(current_user,(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname OPERATOR(pg_catalog.=) 'public'),'USAGE')
        THEN pg_catalog.to_regprocedure('member_role(pg_catalog.int4)')::pg_catalog.oid OPERATOR(pg_catalog.=) (SELECT id FROM identity_function)
        ELSE false END,false) AS runtime_valid`;
function classify(row){
  const booleans=['safe_role','owner_access','rls','can_read','migrated','function_execute','columns_valid','read_policies','runtime_valid'];
  if(!row||booleans.some(key=>typeof row[key]!=='boolean')||!Array.isArray(row.missing)||row.missing.some(name=>!TABLES.includes(name))||new Set(row.missing).size!==row.missing.length)throw new Error('SETUP_CATALOG_INVALID');
  const answer=(code,details)=>({code,...(details?{details}:{})});
  // Preserve the doctor's existing classification priority and missing list.
  if(!row.safe_role)return answer('UNSAFE_DATABASE_ROLE');
  if(row.missing.some(name=>name!=='idempotency_requests'))return answer('SCHEMA_MISSING',{missing:row.missing});
  if(row.owner_access)return answer('UNSAFE_DATABASE_ROLE');
  if(row.missing.length)return answer('MIGRATION_REQUIRED',{missing:row.missing});
  if(!row.rls)return answer('RLS_DISABLED');
  if(!row.can_read)return answer('SCHEMA_PERMISSIONS');
  if(!row.migrated)return answer('MIGRATION_REQUIRED');
  if(!row.function_execute)return answer('SCHEMA_PERMISSIONS');
  if(!row.columns_valid||!row.read_policies||!row.runtime_valid)return answer('SCHEMA_PREREQUISITES');
  return answer('BASIC_CHECKS_PASSED');
}
async function inspectSetupCatalog(client){
  const result=await client.query(CATALOG_SQL,[TABLES,requiredColumns,['facts_current_revision_fk','facts_current_revision_state']]);
  if(result.rows.length!==1)throw new Error('SETUP_CATALOG_INVALID');
  return classify(result.rows[0]);
}
module.exports={inspectSetupCatalog};
