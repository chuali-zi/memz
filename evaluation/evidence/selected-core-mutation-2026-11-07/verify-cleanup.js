// Audit metadata only. Never enumerate unrelated databases or read business rows.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {execFileSync}=require('node:child_process');
const {Client}=Module.createRequire('/workspace/memz/package.json')('pg');
const root=__dirname,report=JSON.parse(fs.readFileSync(path.join(root,'summary.json'),'utf8'));
const sql='SELECT datname FROM pg_catalog.pg_database WHERE datname = ANY($1::text[]) ORDER BY datname';
(async()=>{
  const c=new Client({connectionString:'postgres://postgres:postgres_demo_only@127.0.0.1:55432/memz',connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:5000});
  let rows;
  try{await c.connect();rows=(await c.query(sql,[report.ownedDatabases])).rows}finally{await c.end()}
  // The original runner intentionally bypasses work accounting for its bounded
  // terminal cleanup. Supplement those acknowledged native DROP inputs/results
  // here. These are reconstructed byte counts, distinct from observed counters.
  const reconstructedTerminalBytes=report.cleanup.filter(row=>row.dropped).reduce((n,row)=>n+Buffer.byteLength('DROP DATABASE IF EXISTS '+row.database+' WITH (FORCE)')+4,0);
  const verificationBytes=Buffer.byteLength(sql)+Buffer.byteLength(JSON.stringify([report.ownedDatabases]))+Buffer.byteLength(JSON.stringify(rows));
  const supplemental={checked:new Date().toISOString(),ownedDatabases:report.ownedDatabases.length,remainingOwnedDatabases:rows.map(row=>row.datname),worktreeAbsent:!fs.existsSync(report.worktree),mainStatus:execFileSync('git',['status','--porcelain'],{cwd:'/workspace/memz',encoding:'utf8'}).trim(),observedRunnerApplicationBytes:report.applicationBytes,reconstructedTerminalBytes,verificationBytes,totalAccountedApplicationBytes:report.applicationBytes+reconstructedTerminalBytes+verificationBytes,scope:'SQL UTF8 + JSON parameters/result.rows + HTTP bodies, not wire, errors, headers, heap, or a hard allocation bound; reconstructed terminal bytes separately identified'};
  fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(supplemental,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(supplemental));
  if(rows.length||!supplemental.worktreeAbsent||supplemental.mainStatus)process.exitCode=1;
})().catch(()=>{console.error('AUDIT_METADATA_VERIFICATION_FAILED');process.exitCode=1});
