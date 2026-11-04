const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {hash,uiSources,screenshotNames,evaluationSources,expectedResults,verifyEvidence,verifyPackage,buildPackage}=require('../scripts/package-evidence');

// Deliberate unit fixtures, not browser or competition evidence.
function fixture(fn){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'memz-evidence-unit-'));
  const write=(name,value)=>{fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),value)};
  const json=(name,value)=>write(name,JSON.stringify(value));
  const commit='a'.repeat(40),dataset=JSON.parse(fs.readFileSync(path.join(__dirname,'../evaluation/retrieval-cases.json'),'utf8')),cases=dataset.cases,expected=expectedResults(dataset,200);
  try{
    for(const file of new Set([...uiSources,...Object.values(evaluationSources)]))write(file,`unit fixture ${file}`);
    json('evaluation/retrieval-cases.json',dataset);
    const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('unit fixture only')]);
    for(const file of screenshotNames)write(`evidence/ui/${file}`,bytes);
    const ui={schemaVersion:1,synthetic:true,passed:true,pageErrors:[],checks:{creationKeyRace:{requests:4,distinctKeys:2,createdSources:2,auditRows:2,lostResponseReplayed:true}},source:{commit,workingTreeDirty:false,files:Object.fromEntries(uiSources.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]))},screenshots:screenshotNames.map(file=>({file,sha256:hash(bytes)}))};
    const retrieval={schemaVersion:2,dataset:dataset.dataset,fillerCount:200,synthetic:true,passed:true,totalCases:19,passedCases:19,source:{gitCommit:commit,workingTreeDirty:false,...Object.fromEntries(Object.entries(evaluationSources).map(([key,file])=>[key,hash(fs.readFileSync(path.join(root,file)))]))},cases:cases.map((c,i)=>({...c,user:c.user||'owner',project:c.project||1,expectedStatus:c.status||200,actualStatus:c.status||200,expected:structuredClone(expected[i]),actual:structuredClone(expected[i]),passed:true,paged:{status:c.status||200,factsCount:expected[i].length}})),contextScale:{},candidateScale:{},sourceScale:{}};
    const save=()=>{json('evidence/ui/report.json',ui);json('evidence/retrieval-report.json',retrieval)};save();
    const options={root,commit,uiReportPath:path.join(root,'evidence/ui/report.json'),retrievalReportPath:path.join(root,'evidence/retrieval-report.json')};
    return fn({root,write,json,ui,retrieval,save,options});
  }finally{fs.rmSync(root,{recursive:true,force:true})}
}
test('consistent fixture evidence passes with complete required coverage',()=>fixture(({options})=>assert.equal(verifyEvidence(options).ui.screenshots.length,20)));
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
test('package verification detects changed documents and extra files',()=>fixture(({root,write,json,options})=>{
  for(const file of ['index.md','docs/submission-report.md','docs/demo-script.md'])write(file,'unit fixture document');
  const collect=(dir,prefix='')=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(path.join(dir,e.name),prefix+e.name+'/'):[prefix+e.name]);
  const files=Object.fromEntries(collect(root).map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]));
  json('manifest.json',{schemaVersion:1,commit:options.commit,files});assert.equal(verifyPackage(root).commit,options.commit);
  write('docs/submission-report.md','edited document');assert.throws(()=>verifyPackage(root),/Package file changed/);
  write('unexpected.txt','extra');assert.throws(()=>verifyPackage(root),/file set changed/);
}));
test('complete package build excludes ignored files, verifies offline, and rejects dirty or stale inputs',()=>fixture(({root,write,json,ui,retrieval})=>{
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  write('.gitignore','artifacts/\nevidence/\n.env\n');
  for(const file of ['docs/submission-report.md','docs/demo-script.md'])write(file,'unit fixture document');
  write('scripts/package-evidence.js',fs.readFileSync(path.join(__dirname,'../scripts/package-evidence.js')));
  write('.env','unit fixture excluded content');
  git('init','--quiet');git('add','.');git('-c','user.name=Evidence unit fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Synthetic unit fixture');
  const commit=git('rev-parse','HEAD');ui.source.commit=commit;retrieval.source.gitCommit=commit;
  for(const screenshot of screenshotNames)write(`artifacts/ui/unit/${screenshot}`,fs.readFileSync(path.join(root,'evidence/ui',screenshot)));
  json('artifacts/ui/unit/report.json',ui);json('artifacts/retrieval-report.json',retrieval);
  const previous=process.env.UI_REPORT_PATH;delete process.env.UI_REPORT_PATH;
  try{
    const output=buildPackage(root),manifest=verifyPackage(output);
    assert.equal(manifest.commit,commit);assert.equal(fs.existsSync(path.join(output,'.env')),false);
    const check=execFileSync(process.execPath,['scripts/package-evidence.js','verify','.'],{cwd:output,encoding:'utf8'});assert.match(check,/Package verified/);
    write('server.js','uncommitted fixture change');assert.throws(()=>buildPackage(root),/Commit changes/);
    write('server.js','unit fixture server.js');ui.source.commit='f'.repeat(40);json('artifacts/ui/unit/report.json',ui);
    assert.throws(()=>buildPackage(root),/another commit/);
    assert.equal(fs.readdirSync(path.join(root,'artifacts/submission')).length,1,'failed build must not publish another package');
  }finally{if(previous===undefined)delete process.env.UI_REPORT_PATH;else process.env.UI_REPORT_PATH=previous}
}));

test('true pass flags cannot hide inconsistent actual or rewritten expected values',()=>fixture(({retrieval,save,options})=>{
  retrieval.cases[0].actual=[['评测项目','截止日','错误值']];save();assert.throws(()=>verifyEvidence(options),/Actual result differs/);
  retrieval.cases[0].expected=structuredClone(retrieval.cases[0].actual);save();assert.throws(()=>verifyEvidence(options),/Reported expectation differs/);
}));
test('paged counts and browser race evidence must agree with asserted outcomes',()=>fixture(({ui,retrieval,save,options})=>{
  retrieval.cases[0].paged.factsCount=99;save();assert.throws(()=>verifyEvidence(options),/Paged result count differs/);
  retrieval.cases[0].paged.factsCount=1;ui.checks.creationKeyRace.createdSources=3;save();assert.throws(()=>verifyEvidence(options),/browser creation race evidence/);
}));
