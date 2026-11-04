const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');

async function runUI({baseURL='http://127.0.0.1:3000',executablePath=process.env.CHROMIUM_PATH||'/usr/bin/chromium',databaseVersion=null,preparePagination=null}={}){
  const dir=path.join('artifacts','ui',`run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir,{recursive:true});
  const report={schemaVersion:1,synthetic:true,startedAt:new Date().toISOString(),passed:false,
    source:{commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
      workingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),files:{}},
    environment:{node:process.version,postgres:databaseVersion,viewport:{width:1440,height:1000},locale:'zh-CN',timezone:'UTC'},screenshots:[],pageErrors:[]};
  for(const file of ['server.js','db/schema.sql','public/app.js','public/index.html','public/style.css','test/ui.js','test/ui-evidence.js','idempotency.js']){
    report.source.files[file]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  let browser,page;
  async function capture(file,claim,selector=null){
    const target=path.join(dir,file);
    if(selector)await page.locator(selector).screenshot({path:target});else await page.screenshot({path:target,fullPage:true});
    report.screenshots.push({file,claim,viewport:page.viewportSize(),region:selector,sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')});
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
    const creationRequest=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/projects/1/candidates'));
    await page.getByRole('button',{name:'提交候选'}).click();
    assert.match((await creationRequest).headers()['idempotency-key'],/^[A-Za-z0-9._:-]{1,128}$/);
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
    if(preparePagination){
      await preparePagination();
      await page.getByRole('button',{name:'切换账号'}).click();
      await page.getByRole('button',{name:'进入项目'}).click();
      await page.getByText('第 1 页 · 50 条',{exact:true}).waitFor();
      assert.equal(await page.locator('#facts .entry').count(),50);
      assert.equal(await page.locator('#factsPrevious').isDisabled(),true);
      const requests=[];page.on('request',r=>requests.push(r.url()));
      await page.locator('#factsNext').focus();await page.keyboard.press('Enter');
      await page.getByText('第 2 页 · 6 条 · 已到末页',{exact:true}).waitFor();
      assert.equal(await page.locator('#factsNext').isDisabled(),true);
      assert.equal(await page.locator('#factsTitle').evaluate(e=>e===document.activeElement),true);
      await capture('09-pagination.png','真实临时库56条事实，键盘进入第二页6条，末页禁用下一页','.card:has(#facts)');
      // Another request changes an already visited fact while the UI is on page 2.
      await page.evaluate(async()=>{
        const {csrf}=await (await fetch('/api/me')).json();
        async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw new Error(`Concurrent fixture failed: ${r.status}`);return r.json()}
        const candidate=await post('/api/projects/1/candidates',{subject:'分页演示00',predicate:'状态',value:'翻页期间已更新',source_id:2,expected_version:1});
        await post(`/api/projects/1/candidates/${candidate.id}/approve`);
      });
      await page.getByRole('button',{name:'上一页',exact:true}).click();
      await page.locator('#facts').getByText('分页演示00 / 状态：翻页期间已更新',{exact:true}).waitFor();
      await page.getByText('第 1 页 · 50 条',{exact:true}).waitFor();
      // Hold a real API response, then submit a newer search before releasing it.
      let release,seen;const held=new Promise(r=>{release=r}),observed=new Promise(r=>{seen=r});
      await page.route('**/api/projects/1/facts?**',async route=>{
        if(new URL(route.request().url()).searchParams.get('q')==='分页演示00'){
          const response=await route.fetch();seen();await held;await route.fulfill({response});
        }else await route.continue();
      });
      await page.getByRole('textbox',{name:'检索当前事实'}).fill('分页演示00');
      await page.getByRole('button',{name:'搜索',exact:true}).click();await observed;
      await page.getByRole('textbox',{name:'检索当前事实'}).fill('分页演示54');
      await page.getByRole('button',{name:'搜索',exact:true}).click();
      await page.locator('#facts').getByText('分页演示54 / 状态：合成分页事实',{exact:true}).waitFor();
      const oldResponse=page.waitForResponse(r=>new URL(r.url()).searchParams.get('q')==='分页演示00');release();await (await oldResponse).finished();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.waitForFunction(()=>document.querySelector('#facts').textContent.includes('分页演示54')&&document.querySelector('#facts').getAttribute('aria-busy')==='false');
      await page.unroute('**/api/projects/1/facts?**');
      assert.equal(await page.locator('#facts').getByText(/分页演示00 \/ 状态/).count(),0);
      assert.equal(requests.some(url=>url.includes('/data')),false,'search and pagination must not reload aggregates');
      await page.getByRole('textbox',{name:'检索当前事实'}).fill('没有这种合成事实');
      await page.getByRole('button',{name:'搜索',exact:true}).click();
      await page.getByText('没有匹配的当前事实',{exact:true}).waitFor();
      assert.equal(await page.locator('#factsNext').isDisabled(),true);
      await capture('10-empty-search.png','无匹配搜索清空事实，分页禁用，状态可被辅助技术读取','.card:has(#facts)');
      await page.route('**/api/projects/1/facts?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试故障'})}));
      await page.getByRole('textbox',{name:'检索当前事实'}).fill('分页演示54');
      await page.getByRole('button',{name:'搜索',exact:true}).click();
      await page.getByText(/加载失败：503 测试故障/).waitFor();
      assert.equal(await page.locator('#facts .entry').count(),0);
      assert.equal(await page.locator('#factsNext').isDisabled(),true);
      await page.unroute('**/api/projects/1/facts?**');
      const contextRequest=page.waitForRequest(r=>r.url().endsWith('/data?include_facts=false&include_history=false'));
      await page.getByRole('button',{name:'刷新工作台',exact:true}).click();await contextRequest;
      await page.locator('#facts').getByText('分页演示54 / 状态：合成分页事实',{exact:true}).waitFor();
      await capture('11-search-recovered.png','注入503后刷新恢复真实检索；聚合请求显式排除事实','.card:has(#facts)');
      await page.locator('#historyStatus').getByText('历史第 1 页 · 25 条',{exact:true}).waitFor();
      assert.equal(await page.locator('#history .entry').count(),25);
      await page.locator('#historyNext').focus();await page.keyboard.press('Enter');
      await page.getByText('历史第 2 页 · 25 条',{exact:true}).waitFor();
      assert.equal(await page.locator('#historyTitle').evaluate(e=>e===document.activeElement),true);
      await page.getByRole('button',{name:'较旧一页',exact:true}).click();
      await page.getByText('历史第 3 页 · 8 条 · 已到末页',{exact:true}).waitFor();
      assert.equal(await page.locator('#historyNext').isDisabled(),true);
      await capture('13-history-last-page.png','58条真实合成修订分为25/25/8，旧版本末页可读且按钮禁用','.card:has(#history)');
      const factText=await page.locator('#facts').textContent();
      await page.route('**/api/projects/1/history?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'历史测试故障'})}));
      await page.getByRole('button',{name:'刷新历史',exact:true}).click();
      await page.getByText(/历史加载失败：503 历史测试故障/).waitFor();
      assert.equal(await page.locator('#history .entry').count(),0);
      assert.equal(await page.locator('#facts').textContent(),factText);
      await page.unroute('**/api/projects/1/history?**');
      await page.getByRole('button',{name:'刷新历史',exact:true}).click();
      await page.getByText('历史第 1 页 · 25 条',{exact:true}).waitFor();
      await page.locator('#history').getByText('分页演示00 / 状态：翻页期间已更新',{exact:true}).waitFor();
      assert.equal(await page.locator('#historyPrevious').isDisabled(),true);
      let releaseHistory,observeHistory;
      const historyHeld=new Promise(r=>{releaseHistory=r}),historyObserved=new Promise(r=>{observeHistory=r});
      await page.route('**/api/projects/1/history?**',async route=>{
        if(new URL(route.request().url()).searchParams.has('before')){
          const response=await route.fetch();observeHistory();await historyHeld;await route.fulfill({response});
        }else await route.continue();
      });
      await page.getByRole('button',{name:'较旧一页',exact:true}).click();await historyObserved;
      await page.getByRole('button',{name:'刷新历史',exact:true}).click();
      await page.getByText('历史第 1 页 · 25 条',{exact:true}).waitFor();
      const oldHistory=page.waitForResponse(r=>r.url().includes('/history?')&&new URL(r.url()).searchParams.has('before'));
      releaseHistory();await (await oldHistory).finished();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#historyStatus').textContent(),'历史第 1 页 · 25 条');
      assert.equal(await page.locator('#historyPrevious').isDisabled(),true);
      await page.unroute('**/api/projects/1/history?**');
      await page.setViewportSize({width:390,height:844});
      await capture('12-mobile-pagination.png','390px移动视口中搜索与分页控件可见','.card:has(#facts)');
      await page.getByRole('button',{name:'较旧一页',exact:true}).click();
      await page.getByText('历史第 2 页 · 25 条',{exact:true}).waitFor();
      await page.getByRole('button',{name:'较旧一页',exact:true}).click();
      await page.getByText('历史第 3 页 · 8 条 · 已到末页',{exact:true}).waitFor();
      await capture('14-mobile-history.png','390px视口中的历史末页与分页状态','.card:has(#history)');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile page must not overflow horizontally');
    }
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
