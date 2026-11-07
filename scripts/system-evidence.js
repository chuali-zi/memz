const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// Required by core contract tests; never recursively include benchmark data or runs.
const benchmarkSources=Object.freeze(['benchmarks/memory/scripts/memz_adapter.js']);
const contractSources=Object.freeze(['contracts/openapi-local-v1.json']);
function sourceFiles(root){
  const walk=dir=>fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(entry=>{
    const file=`${dir}/${entry.name}`;
    assert.ok(!entry.isSymbolicLink(),'Source evidence cannot follow symbolic links');
    return entry.isDirectory()?walk(file):[file];
  });
  for(const file of [...benchmarkSources,...contractSources]){
    const kind=benchmarkSources.includes(file)?'benchmark':'contract';
    let current=root;
    for(const part of file.split('/')){
      current=path.join(current,part);
      assert.ok(fs.existsSync(current),`Missing required ${kind} source`);
      assert.ok(!fs.lstatSync(current).isSymbolicLink(),'Source evidence cannot follow symbolic links');
    }
    assert.ok(fs.lstatSync(current).isFile(),`${kind} source must be a regular file`);
  }
  return ['server.js','idempotency.js','package.json','package-lock.json',...['db','public','test','scripts','evaluation'].flatMap(dir=>fs.existsSync(path.join(root,dir))?walk(dir):[])].filter(file=>fs.existsSync(path.join(root,file))).concat(benchmarkSources,contractSources).sort();
}
function coreTestFiles(root){return fs.readdirSync(path.join(root,'test')).filter(file=>file.endsWith('.test.js')).map(file=>`test/${file}`).sort()}
function parseTap(text){
  assert.match(text,/^TAP version 13$/m,'Missing TAP header');
  const summary={};
  for(const name of ['tests','pass','fail','cancelled','skipped','todo']){
    const matches=[...text.matchAll(new RegExp(`^# ${name} (\\d+)$`,'gm'))];
    assert.equal(matches.length,1,`Missing or duplicate TAP ${name}`);
    const value=Number(matches[0][1]);assert.ok(Number.isSafeInteger(value)&&value>=0);summary[name]=value;
  }
  assert.ok(summary.tests>0,'No tests executed');
  assert.equal(summary.tests,summary.pass+summary.fail+summary.cancelled+summary.skipped+summary.todo,'TAP counts disagree');
  if(summary.fail===0&&summary.cancelled===0&&summary.skipped===0&&summary.todo===0)assert.doesNotMatch(text,/^\s*not ok\b/m,'TAP failure contradicts summary');
  return summary;
}
function verifySystemEvidence({root,reportPath,commit,checkedFile}){
  const report=JSON.parse(fs.readFileSync(reportPath,'utf8')),dir=path.dirname(reportPath);
  assert.equal(report.schemaVersion,1);assert.equal(report.synthetic,true);assert.equal(report.passed,true,'System tests did not pass');
  assert.equal(report.source.commit,commit,'System tests used another commit');assert.equal(report.source.workingTreeDirty,false,'System tests used uncommitted code');
  const files=sourceFiles(root);assert.deepEqual(Object.keys(report.source.files).sort(),files,'System source coverage changed');
  for(const file of files)assert.equal(report.source.files[file],hash(fs.readFileSync(checkedFile(root,file))),`System source changed: ${file}`);
  assert.equal(report.cleanup.temporaryDatabaseDropped,true,'Temporary database cleanup was not confirmed');
  assert.deepEqual(report.suites.map(s=>s.name),['core','migrations']);
  const expected={core:coreTestFiles(root),migrations:['test/migrations.js']};
  assert.ok(expected.core.length>0);
  for(const suite of report.suites){
    assert.deepEqual(suite.testFiles,expected[suite.name]);assert.equal(suite.exitCode,0);assert.equal(suite.signal,null);assert.equal(suite.passed,true);
    assert.equal(suite.stdout,`${suite.name}.tap`);assert.equal(suite.stderr,`${suite.name}.stderr.txt`);
    const stdout=fs.readFileSync(checkedFile(dir,suite.stdout)),stderr=fs.readFileSync(checkedFile(dir,suite.stderr));
    assert.equal(hash(stdout),suite.stdoutSha256);assert.equal(hash(stderr),suite.stderrSha256);
    const summary=parseTap(stdout.toString('utf8'));assert.deepEqual(suite.summary,summary,'System summary differs from raw TAP');
    assert.equal(summary.tests,summary.pass);for(const field of ['fail','cancelled','skipped','todo'])assert.equal(summary[field],0,`System suite has ${field}`);
  }
  return report;
}
module.exports={hash,benchmarkSources,contractSources,sourceFiles,coreTestFiles,parseTap,verifySystemEvidence};
