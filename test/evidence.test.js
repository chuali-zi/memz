const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {hash,uiSources,screenshotNames,evaluationSources,expectedResults,verifyEvidence,verifyPackage,buildPackage}=require('../scripts/package-evidence');

const {benchmarkSources,sourceFiles,coreTestFiles,parseTap}=require('../scripts/system-evidence');

// Deliberate unit fixtures, not browser or competition evidence.
function fixture(fn){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'memz-evidence-unit-'));
  const write=(name,value)=>{fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),value)};
  const json=(name,value)=>write(name,JSON.stringify(value));
  const commit='a'.repeat(40),dataset=JSON.parse(fs.readFileSync(path.join(__dirname,'../evaluation/retrieval-cases.json'),'utf8')),cases=dataset.cases,expected=expectedResults(dataset,200);
  try{
    for(const file of new Set([...uiSources,...Object.values(evaluationSources)]))write(file,`unit fixture ${file}`);
    json('evaluation/retrieval-cases.json',dataset);
    write('test/fixture.test.js',"const assert=require('node:assert/strict');assert.equal(require('../benchmarks/memory/scripts/memz_adapter').synthetic,true);");
    write('test/migrations.js','// synthetic fixture');
    for(const file of benchmarkSources)write(file,'module.exports={synthetic:true};');
    for(const file of ['scripts/package-evidence.js','scripts/system-evidence.js'])write(file,fs.readFileSync(path.join(__dirname,'..',file)));
    const tap='TAP version 13\nok 1 - synthetic fixture\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
    const system={schemaVersion:1,synthetic:true,passed:true,source:{commit,workingTreeDirty:false,files:Object.fromEntries(sourceFiles(root).map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]))},cleanup:{temporaryDatabaseDropped:true},suites:['core','migrations'].map(name=>({name,testFiles:name==='core'?coreTestFiles(root):['test/migrations.js'],exitCode:0,signal:null,passed:true,stdout:name+'.tap',stderr:name+'.stderr.txt',stdoutSha256:hash(tap),stderrSha256:hash(''),summary:parseTap(tap)}))};
    for(const name of ['core','migrations']){write('evidence/system/'+name+'.tap',tap);write('evidence/system/'+name+'.stderr.txt','')}

    const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('unit fixture only')]);
    for(const file of screenshotNames)write(`evidence/ui/${file}`,bytes);
    const agentHandoff={synthetic:true,workerInterruptedAfterCommit:true,restartedWithSavedIntent:true,pendingContextEmpty:true,approvalThroughBrowser:true,singleProposalAudit:true,viewerWrite403:true,otherRead403:true,sourceId:1,candidateId:1,intents:{source:{content:'synthetic'},proposal:{subject:'fixture',sourceId:1}},context:{facts:[{subject:'fixture',value:'18号',version:1,source:{id:1,content:'synthetic'},candidateId:1}]}};
    const ui={schemaVersion:1,synthetic:true,passed:true,pageErrors:[],checks:{agentHandoff,firstUseStory:{inlineSourceFailure:true,inputPreserved:true,retrySaved:true,keyboardNavigation:true,conflictVisible:true,clientVersion:2,oldVersionPreserved:true,mobileOverflow:false},provenance:{versionPinned:true,sourceRead:true,retryRecovered:true},projectRecovery:{initialFailure:true,emptyState:true,staleFailureIgnored:true,retryLoadedProject:true,invalidProjectRequests:0},sessionRecovery:{invalidatedSession:true,returnedToLogin:true,reloginSucceeded:true},creationKeyRace:{requests:4,distinctKeys:2,createdSources:2,auditRows:2,lostResponseReplayed:true}},source:{commit,workingTreeDirty:false,files:Object.fromEntries(uiSources.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]))},screenshots:screenshotNames.map(file=>({file,claim:`unit caption ${file}`,sha256:hash(bytes)}))};
    const retrieval={schemaVersion:2,dataset:dataset.dataset,fillerCount:200,synthetic:true,passed:true,totalCases:19,passedCases:19,source:{gitCommit:commit,workingTreeDirty:false,...Object.fromEntries(Object.entries(evaluationSources).map(([key,file])=>[key,hash(fs.readFileSync(path.join(root,file)))]))},cases:cases.map((c,i)=>({...c,user:c.user||'owner',project:c.project||1,expectedStatus:c.status||200,actualStatus:c.status||200,expected:structuredClone(expected[i]),actual:structuredClone(expected[i]),passed:true,paged:{status:c.status||200,factsCount:expected[i].length}})),contextScale:{},candidateScale:{},sourceScale:{}};
    const save=()=>{json('evidence/ui/report.json',ui);json('evidence/retrieval-report.json',retrieval);json('evidence/system/report.json',system)};save();
    const options={root,commit,systemReportPath:path.join(root,'evidence/system/report.json'),uiReportPath:path.join(root,'evidence/ui/report.json'),retrievalReportPath:path.join(root,'evidence/retrieval-report.json')};
    return fn({root,write,json,ui,retrieval,system,save,options});
  }finally{fs.rmSync(root,{recursive:true,force:true})}
}
test('consistent fixture evidence passes with complete required coverage',()=>fixture(({options})=>assert.equal(verifyEvidence(options).ui.screenshots.length,31)));
test('another commit or uncommitted run is rejected',()=>fixture(({ui,retrieval,save,options})=>{
  ui.source.commit='b'.repeat(40);save();assert.throws(()=>verifyEvidence(options),/another commit/);
  ui.source.commit=options.commit;retrieval.source.workingTreeDirty=true;save();assert.throws(()=>verifyEvidence(options),/uncommitted/);
}));
test('failed run, browser exception, or missing retrieval scenario is rejected',()=>fixture(({ui,retrieval,save,options})=>{
  ui.passed=false;save();assert.throws(()=>verifyEvidence(options),/did not pass/);
  ui.passed=true;ui.pageErrors=['fixture exception'];save();assert.throws(()=>verifyEvidence(options));
  ui.pageErrors=[];retrieval.cases[0].passed=false;save();assert.throws(()=>verifyEvidence(options));
  retrieval.cases[0].passed=true;delete retrieval.sourceScale;save();assert.throws(()=>verifyEvidence(options),/scale evidence/);
}));
test('missing, duplicate and unsafe screenshot entries are rejected',()=>fixture(({ui,save,options})=>{
  const original=structuredClone(ui.screenshots);
  ui.screenshots.pop();save();assert.throws(()=>verifyEvidence(options),/screenshots/);
  ui.screenshots=structuredClone(original);ui.screenshots[1]=ui.screenshots[0];save();assert.throws(()=>verifyEvidence(options),/screenshots/);
  ui.screenshots=structuredClone(original);ui.screenshots[0].file='../outside.png';save();assert.throws(()=>verifyEvidence(options),/screenshots/);
}));
test('changed or removed image bytes and symlinks are rejected',()=>fixture(({root,write,options})=>{
  const file=`evidence/ui/${screenshotNames[0]}`;write(file,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('tampered')]));assert.throws(()=>verifyEvidence(options),/Screenshot changed/);
  write(file,'not a PNG');assert.throws(()=>verifyEvidence(options),/not a PNG/);
  fs.unlinkSync(path.join(root,file));assert.throws(()=>verifyEvidence(options),/ENOENT/);
  fs.symlinkSync(path.join(root,'server.js'),path.join(root,file));assert.throws(()=>verifyEvidence(options),/regular file/);
}));
test('changed code and duplicated retrieval cases are rejected',()=>fixture(({write,ui,retrieval,save,options})=>{
  write('server.js','changed implementation');assert.throws(()=>verifyEvidence(options),/source changed/);
  write('server.js','unit fixture server.js');retrieval.cases[1]=retrieval.cases[0];save();assert.throws(()=>verifyEvidence(options),/case identities/);
}));
test('benchmark dependency hashes and exact source coverage reject changed or stale reports',()=>fixture(({write,system,save,options})=>{
  write(benchmarkSources[0],'module.exports={synthetic:false};');
  assert.throws(()=>verifyEvidence(options),/System source changed/);
  write(benchmarkSources[0],'module.exports={synthetic:true};');
  delete system.source.files[benchmarkSources[0]];save();
  assert.throws(()=>verifyEvidence(options),/System source coverage changed/);
}));
test('required benchmark sources cannot be missing or replaced by symbolic links',()=>fixture(({root})=>{
  const file=path.join(root,benchmarkSources[0]);fs.unlinkSync(file);
  assert.throws(()=>sourceFiles(root),/Missing required benchmark source/);
  fs.mkdirSync(file);assert.throws(()=>sourceFiles(root),/must be a regular file/);fs.rmdirSync(file);
  fs.symlinkSync(path.join(root,'server.js'),file);
  assert.throws(()=>sourceFiles(root),/cannot follow symbolic links/);
  fs.unlinkSync(file);fs.rmSync(path.dirname(file),{recursive:true});
  fs.symlinkSync(path.join(root,'scripts'),path.dirname(file));
  assert.throws(()=>sourceFiles(root),/cannot follow symbolic links/);
}));
test('package verification detects changed documents and extra files',()=>fixture(({root,write,json,options})=>{
  for(const file of ['index.md','docs/submission-report.md','docs/demo-script.md'])write(file,'unit fixture document');
  const collect=(dir,prefix='')=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);
  const files=Object.fromEntries(collect(root).map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]));
  json('manifest.json',{schemaVersion:1,commit:options.commit,files});assert.equal(verifyPackage(root).commit,options.commit);
  write('docs/submission-report.md','edited document');assert.throws(()=>verifyPackage(root),/Package file changed/);
  write('unexpected.txt','extra');assert.throws(()=>verifyPackage(root),/file set changed/);
}));
test('complete package build excludes ignored files, verifies offline, and rejects dirty or stale inputs',()=>fixture(({root,write,json,ui,retrieval,system})=>{
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  write('.gitignore','artifacts/\nevidence/\n.env\n');
  for(const file of ['docs/submission-report.md','docs/demo-script.md'])write(file,'unit fixture document');
  write('scripts/package-evidence.js',fs.readFileSync(path.join(__dirname,'../scripts/package-evidence.js')));
  write('.env','unit fixture excluded content');
  for(const file of ['benchmarks/memory/calls.jsonl','benchmarks/memory/gold.json','benchmarks/memory/data/synthetic.json',
    'benchmarks/memory/scripts/__pycache__/synthetic.pyc','benchmarks/memory/scripts/extra.js',
    'benchmarks/memory/tests/memz_adapter.integration.js'])write(file,'synthetic benchmark exclusion canary');
  git('init','--quiet');git('add','.');git('-c','user.name=Evidence unit fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Synthetic unit fixture');
  const commit=git('rev-parse','HEAD');system.source.commit=commit;ui.source.commit=commit;retrieval.source.gitCommit=commit;
  for(const screenshot of screenshotNames)write(`artifacts/ui/unit/${screenshot}`,fs.readFileSync(path.join(root,'evidence/ui',screenshot)));
  json('artifacts/ui/unit/report.json',ui);json('artifacts/retrieval-report.json',retrieval);
  json('artifacts/system/unit/report.json',system);
  for(const name of ['core.tap','core.stderr.txt','migrations.tap','migrations.stderr.txt'])write('artifacts/system/unit/'+name,fs.readFileSync(path.join(root,'evidence/system',name)));
  const previousSystem=process.env.SYSTEM_REPORT_PATH;delete process.env.SYSTEM_REPORT_PATH;
  const previous=process.env.UI_REPORT_PATH;delete process.env.UI_REPORT_PATH;
  try{
    const output=buildPackage(root),manifest=verifyPackage(output);
    const index=fs.readFileSync(path.join(output,'index.md'),'utf8');
    assert.match(index,/阅读顺序/);for(const file of screenshotNames)assert.ok(index.includes(`unit caption ${file}`));
    assert.equal(manifest.commit,commit);assert.equal(fs.existsSync(path.join(output,'.env')),false);
    assert.deepEqual(Object.keys(manifest.files).filter(file=>file.startsWith('benchmarks/')).sort(),[...benchmarkSources].sort(),
      'only explicitly allowed benchmark sources enter the package, even when other benchmark files are tracked');
    assert.equal(system.source.files[benchmarkSources[0]],hash(fs.readFileSync(path.join(output,benchmarkSources[0]))));
    const check=execFileSync(process.execPath,['scripts/package-evidence.js','verify','.'],{cwd:output,encoding:'utf8'});assert.match(check,/Package verified/);
    const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
    const core=execFileSync(process.execPath,['--test','--test-reporter=tap','test/fixture.test.js'],{cwd:output,encoding:'utf8',env:childEnv});assert.match(core,/# pass 1/);
    write('server.js','uncommitted fixture change');assert.throws(()=>buildPackage(root),/Commit changes/);
    write('server.js','unit fixture server.js');ui.source.commit='f'.repeat(40);json('artifacts/ui/unit/report.json',ui);
    assert.throws(()=>buildPackage(root),/another commit/);
    assert.equal(fs.readdirSync(path.join(root,'artifacts/submission')).length,1,'failed build must not publish another package');
  }finally{if(previousSystem===undefined)delete process.env.SYSTEM_REPORT_PATH;else process.env.SYSTEM_REPORT_PATH=previousSystem;if(previous===undefined)delete process.env.UI_REPORT_PATH;else process.env.UI_REPORT_PATH=previous}
}));

test('true pass flags cannot hide inconsistent actual or rewritten expected values',()=>fixture(({retrieval,save,options})=>{
  retrieval.cases[0].actual=[['评测项目','截止日','错误值']];save();assert.throws(()=>verifyEvidence(options),/Actual result differs/);
  retrieval.cases[0].expected=structuredClone(retrieval.cases[0].actual);save();assert.throws(()=>verifyEvidence(options),/Reported expectation differs/);
}));
test('paged counts and browser race evidence must agree with asserted outcomes',()=>fixture(({ui,retrieval,save,options})=>{
  retrieval.cases[0].paged.factsCount=99;save();assert.throws(()=>verifyEvidence(options),/Paged result count differs/);
  retrieval.cases[0].paged.factsCount=1;ui.checks.creationKeyRace.createdSources=3;save();assert.throws(()=>verifyEvidence(options),/browser creation race evidence/);
}));

test('raw database evidence rejects inconsistent summaries and unconfirmed cleanup',()=>fixture(({system,save,options})=>{
  system.suites[0].summary.pass=99;save();assert.throws(()=>verifyEvidence(options),/differs from raw TAP/);
  system.suites[0].summary.pass=1;system.cleanup.temporaryDatabaseDropped=false;save();assert.throws(()=>verifyEvidence(options),/cleanup/);
}));

test('database evidence rejects stale commits, changed raw output and skipped tests',()=>fixture(({system,write,save,options})=>{
  system.source.commit='b'.repeat(40);save();assert.throws(()=>verifyEvidence(options),/another commit/);
  system.source.commit=options.commit;
  const skipped='TAP version 13\nok 1 - fixture # SKIP\n# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n';
  write('evidence/system/core.tap',skipped);save();assert.throws(()=>verifyEvidence(options));
  system.suites[0].stdoutSha256=hash(skipped);system.suites[0].summary=parseTap(skipped);save();assert.throws(()=>verifyEvidence(options));
}));

test('a screenshot without its recorded meaning is rejected',()=>fixture(({ui,save,options})=>{
  delete ui.screenshots[0].claim;save();assert.throws(()=>verifyEvidence(options),/Missing screenshot caption/);
  ui.screenshots[0].claim='   ';save();assert.throws(()=>verifyEvidence(options),/Missing screenshot caption/);
}));

test('missing or mismatched external worker evidence is rejected',()=>fixture(({ui,save,options})=>{
  ui.checks.agentHandoff.context.facts[0].source.id=99;save();assert.throws(()=>verifyEvidence(options));
  delete ui.checks.agentHandoff;save();assert.throws(()=>verifyEvidence(options),/Missing agent handoff/);
}));
