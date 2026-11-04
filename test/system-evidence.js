const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {Client}=require('pg');
const {hash,sourceFiles,coreTestFiles,parseTap}=require('../scripts/system-evidence');
const execute=promisify(execFile);
async function main(){
  if(!process.env.SYSTEM_TEST_DATABASE_URL)throw new Error('Set SYSTEM_TEST_DATABASE_URL to an initialized test PostgreSQL administrator connection.');
  const root=path.resolve(__dirname,'..'),adminURL=process.env.SYSTEM_TEST_DATABASE_URL;
  const dir=path.join(root,'artifacts/system',`run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);fs.mkdirSync(dir,{recursive:true});
  const report={schemaVersion:1,synthetic:true,startedAt:new Date().toISOString(),passed:false,source:{commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),files:Object.fromEntries(sourceFiles(root).map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]))},environment:{node:process.version,postgres:null,platform:process.platform},suites:[],cleanup:{temporaryDatabaseDropped:false}};
  const admin=new Client({connectionString:adminURL}),db=`memz_system_${crypto.randomBytes(8).toString('hex')}`;
  let connected=false,created=false,owner,failure;
  const secretValues=[adminURL,new URL(adminURL).password,decodeURIComponent(new URL(adminURL).password)].filter(Boolean);
  const redact=text=>secretValues.reduce((value,secret)=>value.split(secret).join('[REDACTED]'),String(text||''));
  try{
    await admin.connect();connected=true;report.environment.postgres=(await admin.query('SHOW server_version')).rows[0].server_version;
    await admin.query(`CREATE DATABASE ${db}`);created=true;
    const ownerURL=new URL(adminURL);ownerURL.pathname=`/${db}`;
    owner=new Client({connectionString:ownerURL.href});await owner.connect();
    await owner.query(fs.readFileSync(path.join(root,'db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    const appURL=new URL(ownerURL);appURL.username='memz_app';appURL.password='memz_demo_only';secretValues.push(ownerURL.href,appURL.href);
    const env={...process.env,DATABASE_URL:appURL.href,MIGRATION_TEST_DATABASE_URL:ownerURL.href};delete env.NODE_TEST_CONTEXT;
    for(const [name,testFiles] of [['core',coreTestFiles(root)],['migrations',['test/migrations.js']]]){
      let stdout='',stderr='',exitCode=0,signal=null;
      try{({stdout,stderr}=await execute(process.execPath,['--test','--test-reporter=tap',...testFiles],{cwd:root,env,timeout:180000,maxBuffer:8*1024*1024}))}
      catch(error){stdout=error.stdout||'';stderr=error.stderr||error.message;exitCode=Number.isInteger(error.code)?error.code:1;signal=error.signal||null}
      stdout=redact(stdout);stderr=redact(stderr);
      fs.writeFileSync(path.join(dir,`${name}.tap`),stdout);fs.writeFileSync(path.join(dir,`${name}.stderr.txt`),stderr);
      let summary=null,parseError;
      try{summary=parseTap(stdout)}catch(error){parseError=error.message.split('\n')[0]}
      const passed=exitCode===0&&signal===null&&summary!==null&&summary.tests===summary.pass&&['fail','cancelled','skipped','todo'].every(field=>summary[field]===0);
      report.suites.push({name,testFiles,exitCode,signal,passed,stdout:`${name}.tap`,stderr:`${name}.stderr.txt`,stdoutSha256:hash(stdout),stderrSha256:hash(stderr),summary,...(parseError?{parseError}:{})});
      console.log(`${name}: ${passed?'passed':'failed'}${summary?` (${summary.pass}/${summary.tests})`:''}`);
    }
    if(!report.suites.every(suite=>suite.passed))throw new Error('One or more system test suites failed; inspect the saved TAP reports.');
    report.passed=true;
  }catch(error){failure=error;report.error=redact(error.message)}
  finally{
    try{if(owner)await owner.end();if(created){await admin.query(`DROP DATABASE ${db}`);report.cleanup.temporaryDatabaseDropped=true}}
    catch(error){failure=failure||error;report.passed=false;report.cleanup.error=redact(error.message)}
    finally{try{if(connected)await admin.end()}catch(error){failure=failure||error;report.passed=false;report.cleanup.error=redact(error.message)}}
    report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(`System evidence: ${report.passed?'passed':'failed'}; ${path.relative(root,dir)}`);
  }
  if(failure)throw new Error(redact(failure.message));
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
