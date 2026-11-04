const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');

async function runUI({baseURL='http://127.0.0.1:3000',executablePath=process.env.CHROMIUM_PATH||'/usr/bin/chromium',databaseVersion=null,preparePagination=null,prepareSources=null}={}){
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
    const invalidProjectRequests=[];
    page.on('request',request=>{if(/\/api\/projects\/(null|0)\//.test(request.url()))invalidProjectRequests.push(request.url())});
    await page.route('**/api/projects',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'项目列表测试故障'})}));
    await page.getByRole('button',{name:'进入项目'}).click();
    await page.getByText(/503 项目列表测试故障/).waitFor();
    assert.equal(await page.getByRole('button',{name:'提交候选'}).isDisabled(),true);
    await page.unroute('**/api/projects');
    await page.route('**/api/projects',route=>route.fulfill({status:200,contentType:'application/json',body:'[]'}));
    await page.getByRole('button',{name:'刷新工作台',exact:true}).click();
    await page.getByText(/当前账号没有可访问的项目/).waitFor();
    assert.equal(await page.locator('#project option').count(),0);
    for(const selector of ['#searchForm button','#refreshHistory','#refreshCandidates','#refreshSources'])await page.locator(selector).click();
    assert.equal(await page.getByRole('button',{name:'提交候选'}).isDisabled(),true);
    await page.unroute('**/api/projects');
    let releaseProject,projectSeen,projectRequests=0;
    const projectHeld=new Promise(resolve=>{releaseProject=resolve}),projectObserved=new Promise(resolve=>{projectSeen=resolve});
    await page.route('**/api/projects',async route=>{
      if(++projectRequests===1){projectSeen();await projectHeld;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'过期项目失败'})})}
      else await route.continue();
    });
    await page.getByRole('button',{name:'刷新工作台',exact:true}).click();await projectObserved;
    await page.getByRole('button',{name:'刷新工作台',exact:true}).click();
    await page.locator('#facts').getByText('项目 / 截止日：20号',{exact:true}).waitFor();
    const lateProjectResponse=page.waitForResponse(response=>response.url().endsWith('/api/projects')&&response.status()===503);
    releaseProject();await lateProjectResponse;
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#notice').textContent(),'');
    assert.equal(await page.locator('#project').inputValue(),'1');
    assert.deepEqual(invalidProjectRequests,[]);
    report.checks={...report.checks,projectRecovery:{initialFailure:true,emptyState:true,staleFailureIgnored:true,retryLoadedProject:true,invalidProjectRequests:0}};
    await page.unroute('**/api/projects');
    await page.route('**/facts/*/provenance?version=*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'溯源测试故障'})}));
    await page.locator('#facts').getByRole('button',{name:'查看依据',exact:true}).click();
    await page.locator('#facts').getByText(/依据读取失败：503 溯源测试故障/).waitFor();
    await page.unroute('**/facts/*/provenance?version=*');
    await page.locator('#facts').getByRole('button',{name:'重试依据',exact:true}).click();
    await page.locator('#facts .provenance-detail').getByText('原计划截止日为20号。',{exact:true}).waitFor();
    await capture('02-workspace.png','初始20号v1及按版本读取的会议纪要原文');
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
    await page.locator('#facts').getByRole('button',{name:'查看依据',exact:true}).click();
    await page.locator('#facts .provenance-detail').getByText('项目截止日更正为15号。',{exact:true}).waitFor();
    const pinned=await page.evaluate(()=>api('/api/projects/1/facts/1/provenance?version=1'));
    assert.equal(pinned.revision.version,1);assert.equal(pinned.revision.value,'20号');assert.equal(pinned.source.id,1);assert.equal(pinned.source.content,'原计划截止日为20号。');
    report.checks={...report.checks,provenance:{versionPinned:true,sourceRead:true,retryRecovered:true}};
    await capture('03-approved.png','批准后15号v2与更正原文，历史保留20号和15号');
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
    assert.equal(await page.locator('#candidates button').count(),0,'viewer must not see decision buttons');
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
      const contextRequest=page.waitForRequest(r=>r.url().endsWith('/data?include_facts=false&include_history=false&include_candidates=false&include_sources=false'));
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
      await page.setViewportSize({width:1440,height:1000});
      await page.getByText('候选第 1 页 · 25 条',{exact:true}).waitFor();
      await page.locator('#candidatesNext').focus();await page.keyboard.press('Enter');
      await page.getByText('候选第 2 页 · 25 条',{exact:true}).waitFor();
      assert.equal(await page.locator('#candidatesTitle').evaluate(e=>e===document.activeElement),true);
      await page.getByRole('button',{name:'较旧候选',exact:true}).click();
      await page.getByText('候选第 3 页 · 10 条 · 已到末页',{exact:true}).waitFor();
      assert.equal(await page.locator('#candidatesNext').isDisabled(),true);
      await capture('15-candidates-last-page.png','60条真实合成候选分25/25/10，末页保留原待审批记录','.card:has(#candidates)');
      await page.getByLabel('筛选候选').selectOption('pending');
      await page.getByText('候选第 1 页 · 1 条 · 已到末页',{exact:true}).waitFor();
      await page.locator('#proposal [name=subject]').fill('分页审批');
      await page.locator('#proposal [name=predicate]').fill('状态');
      await page.locator('#proposal [name=value]').fill('新审核值');
      await page.locator('#proposal [name=expected_version]').fill('0');
      await page.getByRole('button',{name:'提交候选',exact:true}).click();
      await page.locator('#candidates .entry').filter({hasText:'分页审批'}).getByRole('button',{name:'批准',exact:true}).waitFor();
      assert.equal(await page.locator('#candidateFilter').inputValue(),'pending');
      await page.locator('#candidates .entry').filter({hasText:'分页审批'}).getByRole('button',{name:'批准',exact:true}).click();
      await page.getByText('候选第 1 页 · 1 条 · 已到末页',{exact:true}).waitFor();
      assert.equal(await page.locator('#candidateFilter').inputValue(),'pending');
      assert.equal(await page.locator('#candidates .entry').filter({hasText:'分页审批'}).count(),0);
      await page.getByLabel('筛选候选').selectOption('approved');
      await page.locator('#candidates .entry').filter({hasText:'分页审批'}).getByText('已批准',{exact:true}).waitFor();
      assert.equal(await page.locator('#candidates button').count(),0);
      await page.getByLabel('筛选候选').selectOption('pending');
      await page.locator('#candidates .entry').filter({hasText:'25号'}).getByRole('button',{name:'批准',exact:true}).waitFor();
      // A separate real request rejects the row while this browser still shows pending.
      await page.evaluate(async()=>{
        const {csrf}=await (await fetch('/api/me')).json();
        const {candidates}=await (await fetch('/api/projects/1/candidates?status=pending')).json();
        if(candidates.length!==1)throw new Error('Expected one pending fixture');
        const r=await fetch(`/api/projects/1/candidates/${candidates[0].id}/reject`,{method:'POST',headers:{'X-CSRF-Token':csrf}});
        if(!r.ok)throw new Error(`Concurrent reject failed: ${r.status}`);await r.json();
      });
      await page.locator('#candidates .entry').filter({hasText:'25号'}).getByRole('button',{name:'批准',exact:true}).click();
      await page.getByText(/409 该候选已处理/).waitFor();
      await page.getByText('当前筛选没有候选',{exact:true}).waitFor();
      assert.equal(await page.locator('#candidateFilter').inputValue(),'pending');
      await page.getByLabel('筛选候选').selectOption('rejected');
      await page.getByText('候选第 1 页 · 2 条 · 已到末页',{exact:true}).waitFor();
      assert.equal(await page.locator('#candidates button').count(),0);
      await capture('16-candidates-concurrent-decision.png','另一请求驳回后旧批准请求409，刷新筛选展示两条真实已驳回状态','.card:has(#candidates)');
      let releaseCandidates,observeCandidates;
      const candidateHeld=new Promise(r=>{releaseCandidates=r}),candidateObserved=new Promise(r=>{observeCandidates=r});
      await page.route('**/api/projects/1/candidates?**',async route=>{
        if(new URL(route.request().url()).searchParams.get('status')==='approved'){
          const response=await route.fetch();observeCandidates();await candidateHeld;await route.fulfill({response});
        }else await route.continue();
      });
      await page.getByLabel('筛选候选').selectOption('approved');await candidateObserved;
      await page.getByLabel('筛选候选').selectOption('pending');
      await page.getByText('当前筛选没有候选',{exact:true}).waitFor();
      const oldCandidates=page.waitForResponse(r=>r.url().includes('/candidates?')&&new URL(r.url()).searchParams.get('status')==='approved');
      releaseCandidates();await (await oldCandidates).finished();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#candidates .entry').count(),0);
      assert.equal(await page.locator('#candidateFilter').inputValue(),'pending');
      await page.unroute('**/api/projects/1/candidates?**');
      await page.route('**/api/projects/1/candidates?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'候选测试故障'})}));
      await page.getByRole('button',{name:'刷新候选',exact:true}).click();
      await page.getByText(/候选加载失败：503 候选测试故障/).waitFor();
      assert.equal(await page.locator('#candidatesNext').isDisabled(),true);
      await page.unroute('**/api/projects/1/candidates?**');
      await page.getByRole('button',{name:'刷新候选',exact:true}).click();
      await page.getByText('当前筛选没有候选',{exact:true}).waitFor();
      await page.setViewportSize({width:390,height:844});
      await capture('17-mobile-candidates-empty.png','移动视口中待审批筛选为空，故障恢复后无过期审批按钮','.card:has(#candidates)');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));

    }
    if(prepareSources){
      await prepareSources();await page.setViewportSize({width:1440,height:1000});
      const originalSelection=await page.locator('#sourceSelect').inputValue();
      await page.getByRole('button',{name:'刷新来源',exact:true}).click();
      await page.getByText('来源第 1 页 · 25 条',{exact:true}).waitFor();
      assert.equal(await page.locator('#sourceSelect').inputValue(),originalSelection);
      await page.locator('#sourcesNext').focus();await page.keyboard.press('Enter');
      await page.getByText('来源第 2 页 · 25 条',{exact:true}).waitFor();
      assert.equal(await page.locator('#sourcesTitle').evaluate(e=>e===document.activeElement),true);
      assert.equal(await page.locator('#sourceSelect').inputValue(),originalSelection);
      assert.equal(await page.locator('#sourceSelect option').count(),26,'page plus pinned choice');
      await page.getByRole('button',{name:'下一页来源',exact:true}).click();
      await page.getByText('来源第 3 页 · 8 条 · 已到末页',{exact:true}).waitFor();
      const sourceEntry=page.locator('#sources .entry').filter({hasText:'来源演示54'});
      await sourceEntry.locator('summary').click();
      assert.equal(await sourceEntry.locator('details .meta').textContent(),'X'.repeat(4000));
      await sourceEntry.locator('summary').click();
      await capture('18-sources-last-page.png','58条来源分25/25/8；长正文可展开，翻页仍保留原依据','.card:has(#sources)');
      await sourceEntry.getByRole('button',{name:'选作依据',exact:true}).click();
      const selectedId=await page.locator('#sourceSelect').inputValue();
      await page.getByRole('textbox',{name:'检索来源标题'}).fill('不存在的来源标题');
      await page.getByRole('button',{name:'查找来源',exact:true}).click();
      await page.getByText('没有匹配的来源标题',{exact:true}).waitFor();
      assert.equal(await page.locator('#sourceSelect').inputValue(),selectedId);
      assert.equal(await page.locator('#sourceSelect option').count(),1);
      await page.locator('#proposal [name=subject]').fill('来源引用测试');
      await page.locator('#proposal [name=predicate]').fill('依据');
      await page.locator('#proposal [name=value]').fill('跨页引用');
      await page.locator('#proposal [name=expected_version]').fill('0');
      const proposalRequest=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/candidates'));
      await page.getByRole('button',{name:'提交候选',exact:true}).click();
      assert.equal((await proposalRequest).postDataJSON().source_id,selectedId);
      await page.locator('#candidates .entry').filter({hasText:'来源引用测试'}).getByRole('button',{name:'批准',exact:true}).click();
      await page.getByText('当前筛选没有候选',{exact:true}).waitFor();
      const provenance=await page.evaluate(async()=>{
        const {facts}=await (await fetch('/api/projects/1/facts?q=来源引用测试')).json();
        const {candidates}=await (await fetch('/api/projects/1/candidates?status=approved')).json();
        return {fact:facts[0],candidate:candidates.find(c=>c.subject==='来源引用测试')};
      });
      assert.equal(provenance.fact.source,'来源演示54');assert.equal(provenance.candidate.source_id,Number(selectedId));
      assert.equal(await page.locator('#sourceSelect').inputValue(),selectedId);
      await capture('19-source-choice-preserved.png','来源检索为空后仍使用已选ID提议并批准，候选与事实溯源经真实接口验证','.card:has(#proposal)');
      let releaseSources,observeSources;
      const sourceHeld=new Promise(r=>{releaseSources=r}),sourceObserved=new Promise(r=>{observeSources=r});
      await page.route('**/api/projects/1/sources?**',async route=>{
        if(new URL(route.request().url()).searchParams.get('q')==='来源演示00'){
          const response=await route.fetch();observeSources();await sourceHeld;await route.fulfill({response});
        }else await route.continue();
      });
      await page.getByRole('textbox',{name:'检索来源标题'}).fill('来源演示00');await page.getByRole('button',{name:'查找来源',exact:true}).click();await sourceObserved;
      await page.getByRole('textbox',{name:'检索来源标题'}).fill('来源演示54');await page.getByRole('button',{name:'查找来源',exact:true}).click();
      await page.getByText('来源第 1 页 · 1 条 · 已到末页',{exact:true}).waitFor();
      const oldSources=page.waitForResponse(r=>r.url().includes('/sources?')&&new URL(r.url()).searchParams.get('q')==='来源演示00');releaseSources();await (await oldSources).finished();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.ok((await page.locator('#sources').textContent()).includes('来源演示54'));assert.equal(await page.locator('#sourceSelect').inputValue(),selectedId);
      await page.unroute('**/api/projects/1/sources?**');
      await page.route('**/api/projects/1/sources?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'来源测试故障'})}));
      await page.getByRole('button',{name:'刷新来源',exact:true}).click();await page.getByText(/来源加载失败：503 来源测试故障/).waitFor();
      assert.equal(await page.locator('#sourceSelect').inputValue(),selectedId);assert.equal(await page.locator('#sourcesNext').isDisabled(),true);
      await page.unroute('**/api/projects/1/sources?**');
      await page.getByRole('button',{name:'刷新来源',exact:true}).click();await page.getByText('来源第 1 页 · 1 条 · 已到末页',{exact:true}).waitFor();
      await page.locator('details').filter({has:page.locator('#sourceForm')}).locator('summary').click();
      await page.locator('#sourceForm [name=title]').fill('浏览器新来源'+'X'.repeat(140));await page.locator('#sourceForm [name=content]').fill('真实创建的合成来源正文');
      await page.getByRole('button',{name:'保存来源',exact:true}).click();await page.getByText(/来源 #\d+ 已保存并选为依据/).waitFor();
      assert.notEqual(await page.locator('#sourceSelect').inputValue(),selectedId);
      await page.getByRole('textbox',{name:'检索来源标题'}).fill('浏览器新来源');await page.getByRole('button',{name:'查找来源',exact:true}).click();
      await page.locator('#sources').getByText('真实创建的合成来源正文',{exact:true}).waitFor();
      await page.setViewportSize({width:390,height:844});
      await capture('20-mobile-sources.png','移动端新建来源标题检索，正文与分页控件可见','.card:has(#sources)');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    }
    if(prepareSources){
      const raceTitle='客户端幂等竞态（合成）',keys=[];let releaseOld,releaseLost,oldSeen,lostSeen,committedLostId;
      const oldHeld=new Promise(r=>{releaseOld=r}),lostHeld=new Promise(r=>{releaseLost=r});
      const oldObserved=new Promise(r=>{oldSeen=r}),lostObserved=new Promise(r=>{lostSeen=r});
      await page.route('**/api/projects/1/sources',async route=>{
        if(route.request().method()!=='POST'||route.request().postDataJSON().title!==raceTitle){await route.continue();return}
        const number=keys.length;keys.push(route.request().headers()['idempotency-key']);
        const response=await route.fetch();assert.equal(response.status(),200);
        if(number===1){oldSeen();await oldHeld}
        if(number===2){committedLostId=(await response.json()).id;lostSeen();await lostHeld;await route.abort('failed');return}
        await route.fulfill({response});
      });
      await page.evaluate(title=>{
        window.creationRace={body:{title,content:'真实请求竞态合成正文'},outcomes:[]};
        for(const i of [0,1])createRecord('/api/projects/1/sources',window.creationRace.body).then(value=>{window.creationRace.outcomes[i]={ok:true,id:value.id}},()=>{window.creationRace.outcomes[i]={ok:false}});
      },raceTitle);
      await page.waitForFunction(()=>window.creationRace.outcomes[0]?.ok);await oldObserved;
      await page.evaluate(()=>{createRecord('/api/projects/1/sources',window.creationRace.body).then(value=>{window.creationRace.outcomes[2]={ok:true,id:value.id}},()=>{window.creationRace.outcomes[2]={ok:false}})});
      await lostObserved;releaseOld();await page.waitForFunction(()=>window.creationRace.outcomes[1]?.ok);
      releaseLost();await page.waitForFunction(()=>window.creationRace.outcomes[2]?.ok===false);
      const retried=await page.evaluate(()=>createRecord('/api/projects/1/sources',window.creationRace.body));
      assert.equal(keys.length,4);assert.equal(keys[0],keys[1]);assert.notEqual(keys[0],keys[2]);assert.equal(keys[2],keys[3]);assert.equal(retried.id,committedLostId);
      const persisted=await page.evaluate(async title=>{
        const {sources}=await (await fetch(`/api/projects/1/sources?q=${encodeURIComponent(title)}`)).json();
        const {audit}=await (await fetch('/api/projects/1/data?include_facts=false&include_history=false&include_candidates=false&include_sources=false')).json();
        return {sources,audit:audit.filter(a=>a.action==='source'&&sources.some(s=>a.detail===`新增来源 ${s.id}`))};
      },raceTitle);
      assert.equal(persisted.sources.length,2);assert.equal(persisted.audit.length,2);
      report.checks={...report.checks,creationKeyRace:{requests:4,distinctKeys:new Set(keys).size,createdSources:persisted.sources.length,auditRows:persisted.audit.length,lostResponseReplayed:true}};
      await page.unroute('**/api/projects/1/sources');
    }
    // Invalidate the real server session without navigating, as after expiry/restart.
    await page.evaluate(async()=>{
      const me=await (await fetch('/api/me')).json();
      const response=await fetch('/api/logout',{method:'POST',headers:{'X-CSRF-Token':me.csrf}});
      if(!response.ok)throw new Error('Session invalidation failed');
    });
    await page.getByRole('button',{name:'刷新工作台',exact:true}).click();
    await page.getByText(/工作台加载失败：401/).waitFor();
    await page.getByRole('button',{name:'切换账号'}).click();
    await page.getByRole('button',{name:'进入项目'}).waitFor({state:'visible'});
    assert.equal(await page.locator('#workspace').isVisible(),false);
    await page.getByRole('button',{name:'进入项目'}).click();
    await page.locator('#facts .entry').first().waitFor();
    report.checks={...report.checks,sessionRecovery:{invalidatedSession:true,returnedToLogin:true,reloginSucceeded:true}};
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
