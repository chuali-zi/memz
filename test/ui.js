const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');

async function runUI({baseURL='http://127.0.0.1:3000',executablePath=process.env.CHROMIUM_PATH||'/usr/bin/chromium',databaseVersion=null}={}){
  const dir=path.join('artifacts','ui',`run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir,{recursive:true});
  const report={schemaVersion:1,synthetic:true,startedAt:new Date().toISOString(),passed:false,
    source:{commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
      workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),files:{}},
    environment:{node:process.version,postgres:databaseVersion,viewport:{width:1440,height:1000},locale:'zh-CN',timezone:'UTC'},screenshots:[],pageErrors:[]};
  for(const file of ['server.js','db/schema.sql','public/app.js','public/index.html','public/style.css','test/ui.js','test/ui-evidence.js']){
    report.source.files[file]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  let browser,page;
  async function capture(file,claim){
    const target=path.join(dir,file);await page.screenshot({path:target,fullPage:true});
    report.screenshots.push({file,claim,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')});
  }
  try{
    browser=await chromium.launch({...(executablePath?{executablePath}:{}),headless:true,args:['--no-sandbox']});
    report.environment.browser=browser.version();
    page=await browser.newPage({viewport:report.environment.viewport,locale:'zh-CN',timezoneId:'UTC'});
    page.setDefaultTimeout(15000);
    page.on('pageerror',e=>report.pageErrors.push(e.message));
    await page.goto(baseURL);
    await page.getByRole('button',{name:'进入项目'}).waitFor();
    await capture('01-login.png','合成演示账号登录界面');
    await page.locator('[name=password]').fill('wrong');
    await page.getByRole('button',{name:'进入项目'}).click();
    await page.getByText('401 账号或密码错误').waitFor({state:'visible'});
    await page.locator('[name=password]').fill('demo-owner');
    await page.getByRole('button',{name:'进入项目'}).click();
    await page.locator('#facts').getByText('项目 / 截止日：20号',{exact:true}).waitFor();
    await capture('02-workspace.png','负责人看到初始当前事实 20号 v1 与来源');
    await page.locator('#sourceSelect').selectOption({label:'#2 负责人更正（合成）'});
    await page.getByRole('button',{name:'提交候选'}).click();
    await page.getByText('候选已提交，等待负责人审批').waitFor();
    await page.locator('#candidates .entry').filter({hasText:'15号'}).first().getByRole('button',{name:'批准'}).click();
    await page.getByText('批准成功').waitFor();
    await page.locator('#facts').getByText('项目 / 截止日：15号',{exact:true}).waitFor();
    await page.locator('#history').getByText('项目 / 截止日：15号',{exact:true}).waitFor();
    await page.locator('#history').getByText('项目 / 截止日：20号',{exact:true}).waitFor();
    assert.equal(await page.locator('#history .entry').count(),2);
    await capture('03-approved.png','批准后当前值为15号，历史同时保留20号与15号');
    await page.getByRole('button',{name:'模拟旧版本 agent：提交 v1 → 25号'}).click();
    await page.getByText('模拟客户端已提交候选，尚未改变当前事实').waitFor();
    await page.locator('#candidates .entry').filter({hasText:'25号'}).first().getByRole('button',{name:'批准'}).click();
    await page.getByText(/409 版本冲突/).waitFor();
    await page.locator('#facts').getByText('项目 / 截止日：15号',{exact:true}).waitFor();
    assert.equal(await page.locator('#history .entry').count(),2);
    await capture('04-conflict.png','旧版本审批返回409，当前事实及两条历史不变');
    const countBefore=await page.locator('#candidates .entry').count();
    await page.getByRole('button',{name:'模拟外部指令：提交 v1 → 30号'}).click();
    await page.locator('#candidates .entry').filter({hasText:'30号'}).getByText('待审批').waitFor();
    assert.equal(await page.locator('#candidates .entry').count(),countBefore+1);
    await page.locator('#facts').getByText('项目 / 截止日：15号',{exact:true}).waitFor();
    assert.equal(await page.locator('#facts').getByText('30号').count(),0);
    assert.equal(await page.locator('#history').getByText('30号').count(),0);
    await capture('05-untrusted.png','外部指令仅生成待审候选，不进入当前事实或历史');
    await page.locator('#candidates .entry').filter({hasText:'30号'}).getByRole('button',{name:'驳回'}).click();
    await page.getByText('驳回成功').waitFor();
    await page.locator('#candidates .entry').filter({hasText:'30号'}).getByText('已驳回').waitFor();
    await page.locator('#audit').getByText('reject',{exact:true}).waitFor();
    assert.equal(await page.locator('#history .entry').count(),2);
    await capture('06-rejected.png','负责人驳回外部候选，记录reject审计且不增加历史');
    await page.getByRole('button',{name:'切换账号'}).click();
    await page.locator('[name=username]').selectOption('viewer');
    await page.getByRole('button',{name:'进入项目'}).click();
    await page.locator('#facts').getByText('项目 / 截止日：15号',{exact:true}).waitFor();
    await page.getByRole('button',{name:'提交候选'}).click();
    await page.getByText(/403 无权访问/).waitFor();
    await capture('07-viewer.png','只读者可以浏览，但提交候选被403拒绝');
    await page.getByRole('button',{name:'切换账号'}).click();
    await page.locator('[name=username]').selectOption('other');
    await page.getByRole('button',{name:'进入项目'}).click();
    await page.locator('#sources').getByText('仅独立项目成员可见。',{exact:true}).waitFor();
    assert.equal(await page.locator('#project').inputValue(),'2');
    assert.equal(await page.locator('#project option').count(),1);
    assert.equal(await page.locator('#facts .entry').count(),0);
    assert.equal(await page.locator('#candidates .entry').count(),0);
    assert.equal(await page.locator('#history .entry').count(),0);
    await capture('08-other-project.png','另一项目账号仅看到独立项目，没有第一项目事实候选或历史');
    assert.deepEqual(report.pageErrors,[],'浏览器不能出现未捕获脚本错误');
    report.passed=true;
  }catch(e){
    report.error=e.message;
    if(page)try{await capture('failure.png','失败现场，仅用于排查，不是通过证据')}catch{}
    throw e;
  }finally{
    report.finishedAt=new Date().toISOString();
    fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');
    console.log(`UI evidence: ${report.passed?'passed':'failed'}; ${dir}`);
    if(browser)await browser.close();
  }
  return {dir,report};
}
if(require.main===module)runUI().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={runUI};
