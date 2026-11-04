const fs=require('node:fs');
const {verifySystemEvidence}=require('./system-evidence');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');

const uiSources=['server.js','db/schema.sql','public/app.js','public/index.html','public/style.css','test/ui.js','test/ui-evidence.js','idempotency.js','scripts/context-client.js'];
const screenshotNames=['01-login','02-workspace','03-approved','04-conflict','05-untrusted','06-rejected','07-viewer','08-other-project','09-pagination','10-empty-search','11-search-recovered','12-mobile-pagination','13-history-last-page','14-mobile-history','15-candidates-last-page','16-candidates-concurrent-decision','17-mobile-candidates-empty','18-sources-last-page','19-source-choice-preserved','20-mobile-sources','21-mobile-source-error','22-mobile-story-context','23-mobile-approval-result'].map(x=>x+'.png');
const evaluationSources={datasetSha256:'evaluation/retrieval-cases.json',serverSha256:'server.js',idempotencySha256:'idempotency.js',runnerSha256:'evaluation/retrieval.js'};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function checkedFile(root,relative){
  assert.ok(typeof relative==='string'&&relative&&!relative.includes('\\')&&!path.posix.isAbsolute(relative)&&path.posix.normalize(relative)===relative&&!relative.split('/').includes('..'),'Unsafe evidence path');
  const resolved=path.resolve(root,relative),real=fs.realpathSync(resolved),base=fs.realpathSync(root);
  assert.ok(real.startsWith(base+path.sep)&&fs.lstatSync(resolved).isFile()&&!fs.lstatSync(resolved).isSymbolicLink(),'Evidence must be a regular file inside its root');
  return resolved;
}
function readJSON(file){return JSON.parse(fs.readFileSync(file,'utf8'))}
function expectedResults(dataset,fillerCount){
  assert.ok(Number.isInteger(fillerCount)&&fillerCount>=200&&fillerCount<=5000,'Invalid retrieval filler count');
  const tuple=f=>[f.subject,f.predicate,f.value];
  const known=new Map([['seed',tuple(dataset.seed)],...dataset.facts.map(f=>[f.key,tuple(f)])]);
  for(let i=0;i<fillerCount;i++)known.set(`filler-${i}`,[`评测条目${String(i).padStart(4,'0')}`,'描述',`合成记忆 ${i}`]);
  const projectOne=[...known.values()];known.set('isolated',tuple(dataset.isolated));
  return dataset.cases.map(item=>item.expected==='all-project-1'?projectOne:(item.expected||[]).map(key=>{assert.ok(known.has(key),`Unknown expected fact: ${key}`);return known.get(key)}));
}
function canonicalTuples(rows){
  assert.ok(Array.isArray(rows),'Missing retrieval tuples');
  for(const tuple of rows)assert.ok(Array.isArray(tuple)&&tuple.length===3&&tuple.every(value=>typeof value==='string'),'Invalid retrieval tuple');
  return rows.map(row=>JSON.stringify(row)).sort();
}
function verifyEvidence({root,uiReportPath,retrievalReportPath,systemReportPath,commit}){
  assert.match(commit,/^[a-f0-9]{40}$/,'Expected a full Git commit');
  const ui=readJSON(uiReportPath),retrieval=readJSON(retrievalReportPath);
  assert.equal(ui.schemaVersion,1);assert.equal(retrieval.schemaVersion,2);
  assert.equal(ui.synthetic,true);assert.equal(retrieval.synthetic,true);
  assert.equal(ui.passed,true,'UI run did not pass');assert.deepEqual(ui.pageErrors,[]);
  assert.deepEqual(ui.checks?.creationKeyRace,{requests:4,distinctKeys:2,createdSources:2,auditRows:2,lostResponseReplayed:true},'Missing or inconsistent browser creation race evidence');
  assert.deepEqual(ui.checks?.sessionRecovery,{invalidatedSession:true,returnedToLogin:true,reloginSucceeded:true},'Missing session recovery evidence');
  assert.deepEqual(ui.checks?.projectRecovery,{initialFailure:true,emptyState:true,staleFailureIgnored:true,retryLoadedProject:true,invalidProjectRequests:0},'Missing project recovery evidence');
  assert.deepEqual(ui.checks?.firstUseStory,{inlineSourceFailure:true,inputPreserved:true,retrySaved:true,keyboardNavigation:true,conflictVisible:true,clientVersion:2,oldVersionPreserved:true,mobileOverflow:false},'Missing first-use story evidence');
  assert.deepEqual(ui.checks?.provenance,{versionPinned:true,sourceRead:true,retryRecovered:true},'Missing version-pinned provenance evidence');
  assert.equal(ui.source.commit,commit,'UI report is from another commit');assert.equal(ui.source.workingTreeDirty,false,'UI report used uncommitted code');
  assert.deepEqual(Object.keys(ui.source.files).sort(),[...uiSources].sort(),'UI source hash coverage changed');
  for(const file of uiSources)assert.equal(ui.source.files[file],hash(fs.readFileSync(checkedFile(root,file))),`UI source changed: ${file}`);
  assert.deepEqual(ui.screenshots.map(s=>s.file).sort(),[...screenshotNames].sort(),'Missing, duplicate or unexpected screenshots');
  for(const screenshot of ui.screenshots){
    assert.ok(typeof screenshot.claim==='string'&&screenshot.claim.trim(),'Missing screenshot caption');
    const bytes=fs.readFileSync(checkedFile(path.dirname(uiReportPath),screenshot.file));
    assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Screenshot is not a PNG');
    assert.equal(hash(bytes),screenshot.sha256,`Screenshot changed: ${screenshot.file}`);
  }
  assert.equal(retrieval.source.gitCommit,commit,'Retrieval report is from another commit');assert.equal(retrieval.source.workingTreeDirty,false,'Retrieval report used uncommitted code');
  for(const [key,file] of Object.entries(evaluationSources))assert.equal(retrieval.source[key],hash(fs.readFileSync(checkedFile(root,file))),`Retrieval source changed: ${file}`);
  assert.equal(retrieval.passed,true,'Retrieval run did not pass');
  assert.equal(retrieval.totalCases,19);assert.equal(retrieval.passedCases,19);assert.equal(retrieval.cases.length,19);
  const dataset=readJSON(checkedFile(root,'evaluation/retrieval-cases.json'));
  assert.equal(retrieval.dataset,dataset.dataset,'Retrieval dataset changed');
  assert.deepEqual(retrieval.cases.map(c=>[c.name,c.query,c.user,c.project,c.expectedStatus]),dataset.cases.map(c=>[c.name,c.query,c.user||'owner',c.project||1,c.status||200]),'Retrieval case identities changed');
  const expected=expectedResults(dataset,retrieval.fillerCount);
  for(const [index,item] of retrieval.cases.entries()){
    assert.equal(item.passed,true);assert.equal(item.actualStatus,item.expectedStatus);assert.equal(item.paged.status,item.expectedStatus);
    assert.deepEqual(canonicalTuples(item.expected),canonicalTuples(expected[index]),`Reported expectation differs from golden data: ${item.name}`);
    assert.deepEqual(canonicalTuples(item.actual),canonicalTuples(expected[index]),`Actual result differs from golden data: ${item.name}`);
    assert.equal(item.paged.factsCount,expected[index].length,`Paged result count differs: ${item.name}`);
  }
  assert.ok(retrieval.sourceScale&&retrieval.candidateScale&&retrieval.contextScale,'Missing scale evidence');
  const system=verifySystemEvidence({root,reportPath:systemReportPath,commit,checkedFile});
  return {ui,retrieval,system};
}
function listFiles(root,prefix=''){
  return fs.readdirSync(path.join(root,prefix),{withFileTypes:true}).flatMap(entry=>{
    const name=prefix?`${prefix}/${entry.name}`:entry.name;
    assert.ok(!entry.isSymbolicLink(),'Package contains a symbolic link');
    return entry.isDirectory()?listFiles(root,name):[name];
  }).sort();
}
function rehearsalFromTap(tap){
  const lines=tap.split('\n').filter(line=>line.startsWith('# Synthetic reviewer rehearsal result: '));
  assert.equal(lines.length,1,'Expected exactly one real rehearsal record in core TAP');
  const story=JSON.parse(lines[0].slice('# Synthetic reviewer rehearsal result: '.length));
  assert.equal(story.schemaVersion,1);assert.equal(story.synthetic,true);assert.equal(story.steps.length,7);
  assert.equal(story.context.facts.length,1);assert.equal(story.context.facts[0].value,'15号');assert.equal(story.context.facts[0].version,2);assert.equal(story.provenanceV1.value,'20号');
  return story;
}
function verifyPackage(root){
  const manifest=readJSON(checkedFile(root,'manifest.json'));
  assert.equal(manifest.schemaVersion,1);
  for(const file of ['index.md','docs/submission-report.md','docs/demo-script.md'])assert.ok(Object.hasOwn(manifest.files,file),`Missing required deliverable: ${file}`);
  assert.deepEqual(Object.keys(manifest.files).sort(),listFiles(root).filter(p=>p!=='manifest.json'),'Package file set changed');
  for(const [file,checksum] of Object.entries(manifest.files))assert.equal(hash(fs.readFileSync(checkedFile(root,file))),checksum,`Package file changed: ${file}`);
  verifyEvidence({root,commit:manifest.commit,uiReportPath:checkedFile(root,'evidence/ui/report.json'),retrievalReportPath:checkedFile(root,'evidence/retrieval-report.json'),systemReportPath:checkedFile(root,'evidence/system/report.json')});
  if(fs.existsSync(path.join(root,'scripts/demo-story.js'))){
    const story=rehearsalFromTap(fs.readFileSync(checkedFile(root,'evidence/system/core.tap'),'utf8'));
    assert.deepEqual(readJSON(checkedFile(root,'evidence/demo-story.json')),story,'Rehearsal differs from original TAP');
    assert.equal(fs.readFileSync(checkedFile(root,'evidence/demo-story.md'),'utf8'),require('./demo-story').markdown(story),'Rehearsal narrative differs from actual record');
  }
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
  const systemParent=path.join(root,'artifacts/system');
  const systemReportPath=process.env.SYSTEM_REPORT_PATH?path.resolve(root,process.env.SYSTEM_REPORT_PATH):fs.readdirSync(systemParent).map(dir=>path.join(systemParent,dir,'report.json')).filter(file=>fs.existsSync(file)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
  assert.ok(systemReportPath,'Run test:system:evidence first');
  const {ui,retrieval,system}=verifyEvidence({root,commit,uiReportPath,retrievalReportPath,systemReportPath});
  const tracked=git('ls-files','-z').split('\0').filter(Boolean);
  const include=file=>/^(docs|db|public|test|evaluation|scripts)\//.test(file)||['README.md','server.js','idempotency.js','package.json','package-lock.json','compose.yml','.github/workflows/ci.yml','.gitignore','.gitattributes'].includes(file);
  const destination=path.join(root,'artifacts/submission',`${commit.slice(0,12)}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  const staging=destination+'.tmp';fs.mkdirSync(staging,{recursive:true});
  const copy=(from,to)=>{fs.mkdirSync(path.dirname(path.join(staging,to)),{recursive:true});fs.copyFileSync(from,path.join(staging,to))};
  try{
    for(const file of tracked.filter(include))copy(checkedFile(root,file),file);
    for(const file of ['report.json','core.tap','core.stderr.txt','migrations.tap','migrations.stderr.txt'])copy(checkedFile(path.dirname(systemReportPath),file),`evidence/system/${file}`);
    copy(uiReportPath,'evidence/ui/report.json');copy(retrievalReportPath,'evidence/retrieval-report.json');
    for(const file of screenshotNames)copy(checkedFile(path.dirname(uiReportPath),file),`evidence/ui/${file}`);
    const hasStory=fs.existsSync(path.join(root,'scripts/demo-story.js'));
    if(hasStory){
      const story=rehearsalFromTap(fs.readFileSync(path.join(staging,'evidence/system/core.tap'),'utf8'));
      fs.writeFileSync(path.join(staging,'evidence/demo-story.json'),JSON.stringify(story,null,2)+'\n');
      fs.writeFileSync(path.join(staging,'evidence/demo-story.md'),require('./demo-story').markdown(story));
    }
    const caption=file=>ui.screenshots.find(s=>s.file===file).claim.replace(/\s+/g,' ').replace(/[\\`*_[\]<>]/g,'\\$&');
    const index=`# Memz 可核验演示材料包\n\n提交：${commit}\n\n[六项初赛材料](docs/submission-report.md) · [演示步骤](docs/demo-script.md) · [完整需求验收表](docs/requirements-acceptance.md)\n\n此包来自同一干净提交的合成数据测试，不能证明外部材料真实、生产安全或比赛成绩。校验值可检测文件变化，但不是数字签名；报告及校验值若同时被重写，不能证明真实性。CI终态须独立核对，本打包程序不宣称CI已经成功。\n\n## 阅读顺序\n\n${hasStory?'先看[本次完整演示实际记录](evidence/demo-story.md)及[原始JSON](evidence/demo-story.json)，从批准后的上下文回查数据库依据。\n\n':''}1. 先读六项材料的需求与数据库设计，用“20号→15号”数据链理解来源、候选、修订和当前指针。\n2. 结合下方01–08图复核批准、冲突、驳回与角色隔离；09–20图作为分页和规模场景补充，21–23图说明窄屏错误恢复、完整故事与审批反馈。\n3. 用原始报告及TAP核对测试结果，再查看[关键实现](docs/key-implementation.md)与[数据字典](docs/data-dictionary.md)。\n\n## 实际报告\n\n- [浏览器报告](evidence/ui/report.json)：${ui.screenshots.length}张截图，未捕获脚本错误${ui.pageErrors.length}个。\n- [检索与规模报告](evidence/retrieval-report.json)：${retrieval.passedCases}/${retrieval.totalCases}例；sourceScale为独立来源增长场景。\n- [数据库系统报告](evidence/system/report.json)：${system.suites.map(s=>`${s.name} ${s.summary.pass}/${s.summary.tests}`).join('；')}；[集成 TAP](evidence/system/core.tap) 与 [迁移 TAP](evidence/system/migrations.tap)，临时库已清理。\n- [清单与SHA-256](manifest.json)：在解包目录运行 \`node scripts/package-evidence.js verify .\`。\n\n## 必要截图\n\n${screenshotNames.map(file=>`- [${file}](evidence/ui/${file})：${caption(file)}`).join('\n')}\n\n截图与报告的时间、环境和合成场景以原始报告为准。官方模板、原通知全文及最终提交渠道尚待人工复核；此包不自动报名或提交。\n`;
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
module.exports={hash,uiSources,screenshotNames,evaluationSources,expectedResults,verifyEvidence,verifyPackage,buildPackage,rehearsalFromTap};
