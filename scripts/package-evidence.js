const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');

const uiSources=['server.js','db/schema.sql','public/app.js','public/index.html','public/style.css','test/ui.js','test/ui-evidence.js','idempotency.js'];
const screenshotNames=['01-login','02-workspace','03-approved','04-conflict','05-untrusted','06-rejected','07-viewer','08-other-project','09-pagination','10-empty-search','11-search-recovered','12-mobile-pagination','13-history-last-page','14-mobile-history','15-candidates-last-page','16-candidates-concurrent-decision','17-mobile-candidates-empty','18-sources-last-page','19-source-choice-preserved','20-mobile-sources'].map(x=>x+'.png');
const evaluationSources={datasetSha256:'evaluation/retrieval-cases.json',serverSha256:'server.js',idempotencySha256:'idempotency.js',runnerSha256:'evaluation/retrieval.js'};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function checkedFile(root,relative){
  assert.ok(typeof relative==='string'&&relative&&!relative.includes('\\')&&!path.posix.isAbsolute(relative)&&path.posix.normalize(relative)===relative&&!relative.split('/').includes('..'),'Unsafe evidence path');
  const resolved=path.resolve(root,relative),real=fs.realpathSync(resolved),base=fs.realpathSync(root);
  assert.ok(real.startsWith(base+path.sep)&&fs.lstatSync(resolved).isFile()&&!fs.lstatSync(resolved).isSymbolicLink(),'Evidence must be a regular file inside its root');
  return resolved;
}
function readJSON(file){return JSON.parse(fs.readFileSync(file,'utf8'))}
function verifyEvidence({root,uiReportPath,retrievalReportPath,commit}){
  assert.match(commit,/^[a-f0-9]{40}$/,'Expected a full Git commit');
  const ui=readJSON(uiReportPath),retrieval=readJSON(retrievalReportPath);
  assert.equal(ui.schemaVersion,1);assert.equal(retrieval.schemaVersion,2);
  assert.equal(ui.synthetic,true);assert.equal(retrieval.synthetic,true);
  assert.equal(ui.passed,true,'UI run did not pass');assert.deepEqual(ui.pageErrors,[]);
  assert.equal(ui.source.commit,commit,'UI report is from another commit');assert.equal(ui.source.workingTreeDirty,false,'UI report used uncommitted code');
  assert.deepEqual(Object.keys(ui.source.files).sort(),[...uiSources].sort(),'UI source hash coverage changed');
  for(const file of uiSources)assert.equal(ui.source.files[file],hash(fs.readFileSync(checkedFile(root,file))),`UI source changed: ${file}`);
  assert.deepEqual(ui.screenshots.map(s=>s.file).sort(),[...screenshotNames].sort(),'Missing, duplicate or unexpected screenshots');
  for(const screenshot of ui.screenshots){
    const bytes=fs.readFileSync(checkedFile(path.dirname(uiReportPath),screenshot.file));
    assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Screenshot is not a PNG');
    assert.equal(hash(bytes),screenshot.sha256,`Screenshot changed: ${screenshot.file}`);
  }
  assert.equal(retrieval.source.gitCommit,commit,'Retrieval report is from another commit');assert.equal(retrieval.source.workingTreeDirty,false,'Retrieval report used uncommitted code');
  for(const [key,file] of Object.entries(evaluationSources))assert.equal(retrieval.source[key],hash(fs.readFileSync(checkedFile(root,file))),`Retrieval source changed: ${file}`);
  assert.equal(retrieval.passed,true,'Retrieval run did not pass');
  assert.equal(retrieval.totalCases,19);assert.equal(retrieval.passedCases,19);assert.equal(retrieval.cases.length,19);
  const dataset=readJSON(checkedFile(root,'evaluation/retrieval-cases.json'));
  assert.deepEqual(retrieval.cases.map(c=>[c.name,c.query,c.user,c.project,c.expectedStatus]),dataset.cases.map(c=>[c.name,c.query,c.user||'owner',c.project||1,c.status||200]),'Retrieval case identities changed');
  for(const item of retrieval.cases){assert.equal(item.passed,true);assert.equal(item.actualStatus,item.expectedStatus);assert.equal(item.paged.status,item.expectedStatus)}
  assert.ok(retrieval.sourceScale&&retrieval.candidateScale&&retrieval.contextScale,'Missing scale evidence');
  return {ui,retrieval};
}
function listFiles(root,prefix=''){
  return fs.readdirSync(path.join(root,prefix),{withFileTypes:true}).flatMap(entry=>{
    const name=prefix?`${prefix}/${entry.name}`:entry.name;
    assert.ok(!entry.isSymbolicLink(),'Package contains a symbolic link');
    return entry.isDirectory()?listFiles(root,name):[name];
  }).sort();
}
function verifyPackage(root){
  const manifest=readJSON(checkedFile(root,'manifest.json'));
  assert.equal(manifest.schemaVersion,1);
  for(const file of ['index.md','docs/submission-report.md','docs/demo-script.md'])assert.ok(Object.hasOwn(manifest.files,file),`Missing required deliverable: ${file}`);
  assert.deepEqual(Object.keys(manifest.files).sort(),listFiles(root).filter(p=>p!=='manifest.json'),'Package file set changed');
  for(const [file,checksum] of Object.entries(manifest.files))assert.equal(hash(fs.readFileSync(checkedFile(root,file))),checksum,`Package file changed: ${file}`);
  verifyEvidence({root,commit:manifest.commit,uiReportPath:checkedFile(root,'evidence/ui/report.json'),retrievalReportPath:checkedFile(root,'evidence/retrieval-report.json')});
  return manifest;
}
function buildPackage(root=path.resolve(__dirname,'..')){
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  assert.equal(git('status','--porcelain'),'','Commit changes before generating a submission package');
  const commit=git('rev-parse','HEAD');
  const uiParent=path.join(root,'artifacts/ui');
  const uiReportPath=process.env.UI_REPORT_PATH?path.resolve(root,process.env.UI_REPORT_PATH):fs.readdirSync(uiParent).map(dir=>path.join(uiParent,dir,'report.json')).filter(file=>fs.existsSync(file)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
  assert.ok(uiReportPath,'Run test:ui:evidence first');
  const retrievalReportPath=path.join(root,'artifacts/retrieval-report.json');
  const {ui,retrieval}=verifyEvidence({root,commit,uiReportPath,retrievalReportPath});
  const tracked=git('ls-files','-z').split('\0').filter(Boolean);
  const include=file=>/^(docs|db|public|test|evaluation|scripts)\//.test(file)||['README.md','server.js','idempotency.js','package.json','package-lock.json','compose.yml','.github/workflows/ci.yml','.gitignore','.gitattributes'].includes(file);
  const destination=path.join(root,'artifacts/submission',`${commit.slice(0,12)}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  const staging=destination+'.tmp';fs.mkdirSync(staging,{recursive:true});
  const copy=(from,to)=>{fs.mkdirSync(path.dirname(path.join(staging,to)),{recursive:true});fs.copyFileSync(from,path.join(staging,to))};
  try{
    for(const file of tracked.filter(include))copy(checkedFile(root,file),file);
    copy(uiReportPath,'evidence/ui/report.json');copy(retrievalReportPath,'evidence/retrieval-report.json');
    for(const file of screenshotNames)copy(checkedFile(path.dirname(uiReportPath),file),`evidence/ui/${file}`);
    const index=`# Memz 可核验演示材料包\n\n提交：${commit}\n\n[六项初赛材料](docs/submission-report.md) · [演示步骤](docs/demo-script.md) · [完整需求验收表](docs/requirements-acceptance.md)\n\n此包来自同一干净提交的合成数据测试，不能证明外部材料真实、生产安全或比赛成绩。校验值可检测文件变化，但不是数字签名；报告及校验值若同时被重写，不能证明真实性。CI终态须独立核对，本打包程序不宣称CI已经成功。\n\n## 实际报告\n\n- [浏览器报告](evidence/ui/report.json)：${ui.screenshots.length}张截图，未捕获脚本错误${ui.pageErrors.length}个。\n- [检索与规模报告](evidence/retrieval-report.json)：${retrieval.passedCases}/${retrieval.totalCases}例；sourceScale为独立来源增长场景。\n- [清单与SHA-256](manifest.json)：在解包目录运行 \`node scripts/package-evidence.js verify .\`。\n\n## 必要截图\n\n${screenshotNames.map(file=>`- [${file}](evidence/ui/${file})`).join('\n')}\n\n截图与报告的时间、环境和合成场景以原始报告为准。官方模板、原通知全文及最终提交渠道尚待人工复核；此包不自动报名或提交。\n`;
    fs.writeFileSync(path.join(staging,'index.md'),index);
    const files=Object.fromEntries(listFiles(staging).map(file=>[file,hash(fs.readFileSync(checkedFile(staging,file)))]));
    const manifest={schemaVersion:1,commit,tree:git('rev-parse','HEAD^{tree}'),createdAt:new Date().toISOString(),synthetic:true,ciConclusion:'not-verified-by-packager',files};
    fs.writeFileSync(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    verifyPackage(staging);fs.renameSync(staging,destination);return destination;
  }catch(error){fs.rmSync(staging,{recursive:true,force:true});throw error}
}
if(require.main===module){
  try{
    if(process.argv[2]==='verify'){const root=path.resolve(process.argv[3]||'.');const result=verifyPackage(root);console.log(`Package verified: ${result.commit}`)}
    else{assert.equal(process.argv.length,2,'Usage: package-evidence.js [verify directory]');console.log(`Submission package: ${buildPackage()}`)}
  }catch(error){console.error(`Evidence rejected: ${error.message}`);process.exitCode=1}
}
module.exports={hash,uiSources,screenshotNames,evaluationSources,verifyEvidence,verifyPackage,buildPackage};
