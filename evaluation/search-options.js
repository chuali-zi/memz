// Experimental alternatives, never used by the application or installed in its database.
const assert=require('node:assert/strict'),fs=require('node:fs');
const escapeLike=value=>value.replace(/[\\%_]/g,'\\$&');
async function compareSearchOptions({owner,service,sourceSQL,result={}}){
  assert.ok(sourceSQL.includes('position(lower($2) in lower(title))>0'));
  const likeSQL=sourceSQL.replace('position(lower($2) in lower(title))>0',"lower(title) LIKE lower($2) ESCAPE '\\'");
  Object.assign(result,{passed:false,scope:'Disposable database only; existing RLS unchanged',queries:{position:sourceSQL,escapedLike:likeSQL},phases:[],ddlChecks:{},writeMethod:{rowsPerTrial:200,trialsPerPhase:2,operation:'Direct app-role source INSERT, EXPLAIN ANALYZE BUFFERS WAL, always ROLLBACK; excludes API/audit',limits:'Sequential phases, warmed caches, VACUUM ANALYZE before each read phase; aborted tuples within write trials and sequence gaps remain; not a controlled latency benchmark'}});
  await owner.query("INSERT INTO sources(project_id,title,content) VALUES (1,'100%_Literal\\Path','synthetic literal wildcard'),(1,'100xxLiteralXPath','synthetic nonmatching decoy')");
  async function protectedState(){
    const state={};
    for(const table of ['projects','memberships','facts','candidates','revisions','audit','idempotency_requests'])state[table]=(await owner.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;
    return state;
  }
  const protectedBefore=await protectedState();
  const before=(await owner.query('SELECT * FROM sources ORDER BY id')).rows;
  const policies=(await owner.query("SELECT * FROM pg_policies WHERE tablename='sources' ORDER BY policyname")).rows;
  result.rows=before.length;
  result.operators=(await owner.query("SELECT proname,proleakproof FROM pg_proc WHERE oid IN ('textlike(text,text)'::regprocedure,'strpos(text,text)'::regprocedure) ORDER BY proname")).rows;
  const indexName='experiment_sources_title_trgm';
  const ddl=`CREATE INDEX IF NOT EXISTS ${indexName} ON sources USING gin(lower(title) gin_trgm_ops)`;
  // Prove transactional install rollback before making an experimental change.
  await owner.query('BEGIN');
  try{await owner.query('CREATE EXTENSION pg_trgm');await owner.query(ddl)}finally{await owner.query('ROLLBACK')}
  assert.equal((await owner.query("SELECT 1 FROM pg_extension WHERE extname='pg_trgm'")).rowCount,0);
  assert.equal((await owner.query('SELECT to_regclass($1) AS id',[indexName])).rows[0].id,null);
  result.ddlChecks.transactionalInstallRollback=true;
  const terms=['','不存在的计划来源','计划来源01998','计','019','%','_','\\','%_literal\\path','100XX'];
  async function phase(name){
    await owner.query('VACUUM (ANALYZE) sources');
    const phase={name,cases:[],writes:[],indexBytesBeforeWrites:(await owner.query('SELECT CASE WHEN to_regclass($1) IS NULL THEN 0 ELSE pg_relation_size(to_regclass($1)) END AS bytes',[indexName])).rows[0].bytes};result.phases.push(phase);
    for(const term of terms){
      const rows={};
      for(const [kind,sql,value] of [['position',sourceSQL,term],['escapedLike',likeSQL,`%${escapeLike(term)}%`]]){
        const params=[1,value,0,26];
        rows[kind]=(await service.tx(1,c=>c.query(sql,params),{snapshot:true})).rows;
        assert.equal((await service.tx(4,c=>c.query(sql,params),{snapshot:true})).rowCount,0,'RLS must reject foreign project for each alternative');
        const plans=[];
        for(let n=0;n<2;n++)plans.push(await service.tx(1,async c=>(await c.query(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${sql}`,params)).rows[0]['QUERY PLAN'][0],{snapshot:true}));
        for(const plan of plans)assert.equal(plan.Plan['Actual Rows'],rows[kind].length);
        phase.cases.push({term,kind,params,ids:rows[kind].map(r=>r.id),foreignProjectRows:0,plans});
      }
      assert.deepEqual(rows.escapedLike,rows.position,'Escaped LIKE must preserve literal substring results');
      const expected=before.filter(r=>r.project_id===1&&r.title.toLowerCase().includes(term.toLowerCase())).slice(0,26).map(({id,title,content})=>({id,title,content}));
      assert.deepEqual(rows.position,expected);
    }
    for(let trial=0;trial<2;trial++){
      const c=await service.pool.connect();
      try{
        await c.query('BEGIN');await c.query("SELECT set_config('app.user_id','1',true)");
        const sql="INSERT INTO sources(project_id,title,content) SELECT 1,'写入成本'||md5(n::text),repeat('合成正文',100) FROM generate_series(1,200) n";
        const plan=(await c.query(`EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'][0];
        assert.equal((await c.query('SELECT count(*)::int AS n FROM sources WHERE project_id=1')).rows[0].n,before.filter(r=>r.project_id===1).length+200);
        phase.writes.push({trial,plan});
      }finally{await c.query('ROLLBACK');c.release()}
      assert.deepEqual((await owner.query('SELECT * FROM sources ORDER BY id')).rows,before,'Aborted write trial must preserve data');
    }
    phase.indexBytes=(await owner.query('SELECT CASE WHEN to_regclass($1) IS NULL THEN 0 ELSE pg_relation_size(to_regclass($1)) END AS bytes',[indexName])).rows[0].bytes;
  }
  await phase('existing-indexes');
  await owner.query('CREATE EXTENSION pg_trgm');await owner.query(ddl);await owner.query(ddl);
  result.extension=(await owner.query("SELECT extname,extversion FROM pg_extension WHERE extname='pg_trgm'")).rows[0];
  assert.deepEqual((await owner.query('SELECT * FROM sources ORDER BY id')).rows,before);
  for(const file of ['db/migrations/001-current-revision-integrity.sql','db/migrations/002-create-idempotency.sql'])await owner.query(fs.readFileSync(file,'utf8'));
  assert.deepEqual((await owner.query("SELECT * FROM pg_policies WHERE tablename='sources' ORDER BY policyname")).rows,policies);
  assert.deepEqual(await protectedState(),protectedBefore);
  await assert.rejects(()=>service.tx(1,c=>c.query('CREATE INDEX forbidden_app_index ON sources(title)')),e=>e.code==='42501');
  await assert.rejects(()=>service.tx(4,c=>c.query("INSERT INTO sources(project_id,title,content) VALUES(1,'forbidden','synthetic')")),e=>e.code==='42501');
  result.ddlChecks.repeatInstallAndExistingMigrations=true;
  result.ddlChecks.applicationCannotAlterIndexOrWriteForeignProject=true;
  await phase('experimental-gin');
  // Owner-only diagnostic: not admissible evidence of application-role benefit.
  result.ownerDiagnostic={role:'schema owner, bypasses RLS; diagnostic only',plan:(await owner.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${likeSQL}`,[1,'%不存在的计划来源%',0,26])).rows[0]['QUERY PLAN'][0]};
  await owner.query(`DROP INDEX ${indexName}`);await owner.query('DROP EXTENSION pg_trgm');
  await phase('after-removal');
  assert.deepEqual((await owner.query('SELECT * FROM sources ORDER BY id')).rows,before);
  assert.deepEqual((await owner.query("SELECT * FROM pg_policies WHERE tablename='sources' ORDER BY policyname")).rows,policies);
  assert.deepEqual(await protectedState(),protectedBefore);
  result.ddlChecks.removalPreservesRowsAndPolicies=true;result.passed=true;
  return result;
}
module.exports={escapeLike,compareSearchOptions};
