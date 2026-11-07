// Real Chromium checks of client interaction with explicitly synthetic, controlled HTTP responses.
// No database, external service, model, or existing demo data is used.
const {test:runTest,before,after}=require('node:test');
const test=(name,fn)=>runTest(name,{timeout:60000},fn);
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
let server,browser,browserServer,baseURL;
const pageCleanups=new Map(),httpResponses=new Map();
async function bounded(promise,label,milliseconds=5000){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} exceeded ${milliseconds}ms`)),milliseconds)})])}
  finally{clearTimeout(timer)}
}
function cancelPageGates(page){for(const cancel of pageCleanups.get(page)||[])cancel();pageCleanups.delete(page)}
async function closePage(page){
  cancelPageGates(page);
  const failures=[];
  try{await bounded(page.unrouteAll({behavior:'wait'}),'draining test routes',3000)}catch(error){failures.push(error)}
  finally{try{await bounded(page.close(),'closing test page',3000)}catch(error){failures.push(error)}}
  if(failures.length)throw new AggregateError(failures,'Test page cleanup failed');
}
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const controlled=httpResponses.get(`${req.method} ${new URL(req.url,'http://localhost').pathname}`);
    if(controlled){req.resume();await controlled(req,res);return}
    // Deliberately unfinished responses exist only in this local test server.
    if(req.url==='/__test__/pending-headers')return;
    if(req.url==='/__test__/pending-body'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{"unfinished":');return}
    const file={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[new URL(req.url,'http://localhost').pathname];
    if(!file){res.writeHead(404).end();return}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
    res.end(await fs.readFile(path.join(__dirname,'..','public',file)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  baseURL=`http://127.0.0.1:${server.address().port}`;
  browserServer=await chromium.launchServer({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),host:'127.0.0.1',timeout:15000,headless:true,args:['--no-sandbox']});
  browser=await chromium.connect(browserServer.wsEndpoint(),{timeout:5000});
},{timeout:30000});
async function closeFixture({browser,browserServer,server}){
  const failures=[];
  try{if(browser)await bounded(browser.close(),'closing test browser',5000)}catch(error){failures.push(error)}
  finally{
    try{if(browserServer&&browserServer.process().exitCode===null)await bounded(browserServer.kill(),'terminating owned test browser',3000)}
    catch(error){failures.push(error);browserServer?.process().kill('SIGKILL')}
    finally{
      if(server){
        const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();
        try{await bounded(closed,'closing test HTTP server',2000)}catch(error){failures.push(error)}
      }
    }
  }
  if(failures.length)throw new AggregateError(failures,'Product test fixture cleanup failed');
}
after(async()=>{
  for(const page of pageCleanups.keys())cancelPageGates(page);
  await closeFixture({browser,browserServer,server});
},{timeout:12000});

async function openPage(){
  const page=await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN'}),errors=[];
  pageCleanups.set(page,new Set());
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),resource=url.pathname.split('/').at(-1);
    let body;
    if(url.pathname==='/api/login')body={csrf:'synthetic-csrf',name:'Synthetic owner'};
    else if(url.pathname==='/api/projects')body=[{id:1,name:'合成项目一',role:'owner'},{id:2,name:'合成项目二',role:'owner'}];
    else if(resource==='data')body={sourceTextIsUntrusted:true,role:'owner'};
    else if(resource==='sources')body={sources:[{id:1,title:'合成依据',content:'仅用于交互测试。'}],next_after:null};
    else if(resource==='facts')body={facts:[],next_after:null};
    else if(resource==='history')body={history:[],next_before:null};
    else if(resource==='candidates')body={candidates:[],role:'owner',next_before:null};
    else if(resource==='audit')body={audit:[],next_before:null};
    else throw new Error(`Unexpected synthetic route ${request.method()} ${url.pathname}`);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(baseURL);
  return {page,errors};
}
async function login(page){await page.locator('#loginForm button').click();await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled)}
async function hold(page,pattern,method='POST'){
  let seen,finish;
  const observed=new Promise(resolve=>{seen=resolve}),completion=new Promise(resolve=>{finish=resolve}),requests=[];
  pageCleanups.get(page).add(()=>{seen();finish({cancelled:true})});
  await page.route(pattern,async route=>{
    if(route.request().method()!==method){await route.fallback();return}
    requests.push(route.request());seen();
    const {status,body,cancelled}=await completion;if(cancelled){await route.abort();return}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return {get observed(){return bounded(observed,`waiting for held ${method} request`)},requests,release:(body,status=200)=>finish({body,status})};
}
async function submitTwice(page,selector){await page.evaluate(selector=>{const form=document.querySelector(selector);form.requestSubmit();form.requestSubmit()},selector)}
async function settled(page,selector){await page.waitForFunction(selector=>document.querySelector(selector).getAttribute('aria-busy')==='false',selector)}
function healthyCreationReceipt(request,id){
  const body=request.postDataJSON(),path=new URL(request.url()).pathname,project=Number(path.split('/')[3]);
  return path.endsWith('/sources')?{id,project_id:project,title:body.title.trim(),content:body.content.trim()}:
    {id,project_id:project,subject:body.subject.trim(),predicate:body.predicate.trim(),value:body.value.trim(),source_id:Number(body.source_id),expected_version:Number(body.expected_version),status:'pending',proposed_by:2,created_at:'2026-11-07T00:00:00.000Z'};
}

test('login announces its pending state and only sends one in-flight request',async()=>{
  const {page,errors}=await openPage();
  try{
    const pending=await hold(page,'**/api/login');
    await submitTwice(page,'#loginForm');await pending.observed;
    assert.equal(await page.locator('#loginForm').getAttribute('aria-busy'),'true');
    assert.equal(await page.locator('#loginForm button').isDisabled(),true);
    assert.equal(await page.locator('#notice').textContent(),'正在登录…');
    assert.equal(pending.requests.length,1);
    pending.release({error:'合成登录故障'},503);await settled(page,'#loginForm');
    assert.equal(await page.locator('#loginForm button').isEnabled(),true);
    assert.match(await page.locator('#notice').textContent(),/503 合成登录故障/);
    assert.equal(await page.locator('#loginForm [name=password]').inputValue(),'demo-owner');
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('uncertain creation retains input and reuses its key after manual retry',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);await page.locator('#addSourceShortcut').click();
    await page.locator('#sourceForm [name=title]').fill('合成待保存来源');
    await page.locator('#sourceForm [name=content]').fill('受控失败后仍应保留的正文');
    const pending=await hold(page,'**/api/projects/1/sources');
    await submitTwice(page,'#sourceForm');await pending.observed;
    assert.equal(await page.locator('#sourceForm button').isDisabled(),true);
    assert.equal(await page.locator('#sourceFeedback').textContent(),'正在保存来源…');
    // Independent list refreshes must not unlock a pending creation.
    await page.locator('#refreshSources').click();
    await page.waitForFunction(()=>document.querySelector('#sources').getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('#sourceForm button').isDisabled(),true);
    assert.equal(pending.requests.length,1);
    pending.release({error:'合成写入故障'},503);await settled(page,'#sourceForm');
    assert.equal(await page.locator('#sourceForm [name=content]').inputValue(),'受控失败后仍应保留的正文');
    assert.match(await page.locator('#sourceFeedback').textContent(),/写入结果可能不确定/);
    assert.equal(await page.locator('#sourceForm button').isEnabled(),true);
    const retry=await hold(page,'**/api/projects/1/sources');
    await page.locator('#sourceForm button').click();await retry.observed;
    assert.equal(retry.requests[0].headers()['idempotency-key'],pending.requests[0].headers()['idempotency-key']);
    retry.release(healthyCreationReceipt(retry.requests[0],7));await settled(page,'#sourceForm');
    assert.equal(await page.locator('#sourceSelect').inputValue(),'7');
    assert.equal(await page.locator('#sourceForm [name=title]').inputValue(),'');
    assert.match(await page.locator('#sourceFeedback').textContent(),/来源 #7 已保存/);
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('successful source creation preserves a draft edited while its response was pending',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);await page.locator('#addSourceShortcut').click();
    await page.locator('#sourceForm [name=title]').fill('已提交标题');await page.locator('#sourceForm [name=content]').fill('已提交正文');
    const pending=await hold(page,'**/api/projects/1/sources');
    await page.locator('#sourceForm button').click();await pending.observed;
    await page.locator('#sourceForm [name=title]').fill('下一份来源草稿');
    pending.release(healthyCreationReceipt(pending.requests[0],8));await settled(page,'#sourceForm');
    assert.equal(await page.locator('#sourceForm [name=title]').inputValue(),'下一份来源草稿');
    assert.equal(await page.locator('#sourceSelect').inputValue(),'8');
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a late candidate response cannot announce success or reload another project',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);
    const pending=await hold(page,'**/api/projects/1/candidates');
    await submitTwice(page,'#proposal');await pending.observed;
    assert.equal(pending.requests.length,1);
    assert.equal(await page.locator('#proposal').getAttribute('aria-busy'),'true');
    assert.equal(await page.locator('#proposalFeedback').textContent(),'正在提交候选…');
    let reads=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/projects/2/data')reads++});
    await page.locator('#project').selectOption('2');
    await page.waitForFunction(()=>document.querySelector('#sources').getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('#proposal button').isDisabled(),true);
    pending.release(healthyCreationReceipt(pending.requests[0],9));await settled(page,'#proposal');
    assert.equal(await page.locator('#project').inputValue(),'2');
    assert.equal(await page.locator('#proposalFeedback').textContent(),'');
    assert.equal(reads,1,'only project selection loads project two');
    assert.equal(await page.locator('#proposal button').isEnabled(),true);
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('simulated client has a pending lock and a usable narrow-screen recovery state',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);const pending=await hold(page,'**/api/projects/1/candidates');
    await page.locator('#stale').click();await pending.observed;
    await page.evaluate(()=>document.querySelector('#stale').click());
    assert.equal(await page.locator('#stale').getAttribute('aria-busy'),'true');
    assert.equal(pending.requests.length,1);
    pending.release({error:'合成模拟客户端故障'},503);await settled(page,'#stale');
    assert.equal(await page.locator('#stale').isEnabled(),true);
    assert.match(await page.locator('#notice').textContent(),/写入结果可能不确定/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('#addSourceShortcut').click();
    assert.equal(await page.locator('#sourceForm [name=title]').evaluate(node=>document.activeElement===node),true);
    await page.locator('#sourceForm [name=content]').focus();
    assert.equal(await page.locator('#sourceForm [name=content]').evaluate(node=>getComputedStyle(node).outlineStyle),'solid');
    if(process.env.PRODUCT_EXPERIENCE_SCREENSHOT)await page.screenshot({path:process.env.PRODUCT_EXPERIENCE_SCREENSHOT,fullPage:true});
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

async function conflictFixture(page){
  const source={id:1,title:'合成依据',content:'仅用于交互测试。'},alternative={id:2,title:'另一合成依据',content:'另一份人工草稿依据。'};
  const candidate={id:10,subject:'合成冲突',predicate:'截止日',value:'原候选值',status:'pending',expected_version:0,source_id:1,source:source.title};
  const proof={sourceTextIsUntrusted:true,candidate,source,role:'owner',comparison:{matches:false,expectedVersion:0,currentVersion:2},current:{fact_id:21,value:'当前批准值',version:2,source_id:2,candidate_id:11,source_title:alternative.title}};
  await page.route('**/api/projects/1/sources?*',route=>route.fulfill({json:{sources:[source,alternative],next_after:null}}));
  await page.route('**/api/projects/1/candidates?*',route=>route.fulfill({json:{candidates:[candidate],role:'owner',next_before:null}}));
  await page.route('**/api/projects/1/candidates/10/source',route=>route.fulfill({json:proof}));
  await login(page);await page.locator('#candidates').getByRole('button',{name:'核对来源原文',exact:true}).click();
  const prepare=page.getByRole('button',{name:'用最新版本填写新候选',exact:true});await prepare.waitFor();
  return {proof,prepare};
}
async function draft(page){return page.locator('#proposal').evaluate(form=>Object.fromEntries(new FormData(form)))}
async function returnToFirstProject(page){
  for(const id of ['2','1']){
    await page.locator('#project').selectOption(id);
    await page.waitForFunction(()=>document.querySelector('#sources').getAttribute('aria-busy')==='false'&&document.querySelector('#candidates').getAttribute('aria-busy')==='false');
  }
}

test('conflict recovery preserves text, version and source edited during its read',async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof,prepare}=await conflictFixture(page),pending=await hold(page,'**/api/projects/1/candidates/10/source','GET');
    await prepare.click();await pending.observed;
    await page.locator('#proposal [name=value]').fill('刚编辑的草稿');
    await page.locator('#proposal [name=expected_version]').fill('7');
    await page.locator('#sourceSelect').selectOption('2');
    const edited=await draft(page);pending.release(proof);
    await page.locator('#candidateFeedback').getByText(/草稿.*已保留/).waitFor();
    assert.deepEqual(await draft(page),edited);
    assert.equal(await prepare.isEnabled(),true);
    assert.equal(await page.locator('#proposalFeedback').textContent(),'');
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('unchanged conflict recovery still fills the latest version without submitting',async()=>{
  const {page,errors}=await openPage();
  try{
    const {prepare}=await conflictFixture(page),writes=[];
    page.on('request',request=>{if(request.method()==='POST')writes.push(request.url())});
    await prepare.click();await page.locator('#proposalFeedback').getByText(/已用读取时 v2.*尚未提交/).waitFor();
    assert.equal((await draft(page)).value,'原候选值');assert.equal((await draft(page)).expected_version,'2');assert.equal((await draft(page)).source_id,'1');
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a failed submission during conflict recovery keeps the original retry content',async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof,prepare}=await conflictFixture(page),reading=await hold(page,'**/api/projects/1/candidates/10/source','GET');
    await prepare.click();await reading.observed;
    const original=await draft(page),creation=await hold(page,'**/api/projects/1/candidates');
    await page.locator('#proposal button').click();await creation.observed;
    creation.release({error:'合成响应不确定'},503);await settled(page,'#proposal');
    reading.release(proof);await page.locator('#candidateFeedback').getByText(/提交.*已保留/).waitFor();
    assert.deepEqual(await draft(page),original);
    assert.match(await page.locator('#proposalFeedback').textContent(),/写入结果可能不确定/);
    assert.equal(await prepare.isEnabled(),true);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a source response from an earlier visit cannot select evidence or reload after A to B to A',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);await page.locator('#addSourceShortcut').click();
    await page.locator('#sourceForm [name=title]').fill('旧访问提交标题');await page.locator('#sourceForm [name=content]').fill('旧访问正文');
    const creation=await hold(page,'**/api/projects/1/sources');
    await page.locator('#sourceForm button').click();await creation.observed;
    await returnToFirstProject(page);
    await page.locator('#sourceForm [name=title]').fill('新访问的来源草稿');
    let reads=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/projects/1/data')reads++});
    creation.release(healthyCreationReceipt(creation.requests[0],99));await settled(page,'#sourceForm');
    assert.equal(await page.locator('#sourceForm [name=title]').inputValue(),'新访问的来源草稿');
    assert.equal(await page.locator('#sourceSelect').inputValue(),'1');
    assert.equal(await page.locator('#sourceFeedback').textContent(),'');
    assert.equal(reads,0);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('an uncertain candidate error from an earlier visit does not replace new visit feedback',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);const creation=await hold(page,'**/api/projects/1/candidates');
    await page.locator('#proposal button').click();await creation.observed;
    await returnToFirstProject(page);
    await page.locator('#sources').getByRole('button',{name:'选作依据',exact:true}).click();
    const notice=await page.locator('#notice').textContent();
    creation.release({error:'旧访问的合成写入故障'},503);await settled(page,'#proposal');
    assert.equal(await page.locator('#proposalFeedback').textContent(),'');
    assert.equal(await page.locator('#notice').textContent(),notice);
    assert.equal(await page.locator('#proposal button').isEnabled(),true);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a simulated lookup from an earlier visit does not create a candidate after returning',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);
    const lookup=await hold(page,url=>url.pathname==='/api/projects/1/sources'&&url.searchParams.get('limit')==='1','GET');
    const writes=[];page.on('request',request=>{if(request.method()==='POST')writes.push(request.url())});
    await page.locator('#stale').click();await lookup.observed;await returnToFirstProject(page);
    lookup.release({sources:[{id:1,title:'合成会议纪要',content:'旧访问的来源。'}],next_after:null});await settled(page,'#stale');
    assert.deepEqual(writes,[]);assert.equal(await page.locator('#notice').textContent(),'');
    assert.equal(await page.locator('#stale').isEnabled(),true);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a late approval result cannot refresh or announce success in a new visit',async()=>{
  const {page,errors}=await openPage();
  try{
    await conflictFixture(page);const approval=await hold(page,'**/api/projects/1/candidates/10/approve');
    await page.locator('#candidates').getByRole('button',{name:'批准',exact:true}).click();await approval.observed;
    await returnToFirstProject(page);
    let reads=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/projects/1/data')reads++});
    const response=page.waitForResponse('**/api/projects/1/candidates/10/approve');approval.release({version:3});await response;
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#candidateFeedback').textContent(),'');assert.equal(reads,0);
    assert.equal(await page.locator('#project').inputValue(),'1');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

async function freezeClock(page){
  await page.clock.install({time:new Date('2026-01-01T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
}
async function expireRequest(page){await page.clock.fastForward(15001);await page.clock.resume()}
for(const endpoint of ['pending-headers','pending-body'])test(`fixed deadline covers ${endpoint} without exposing a timeout override`,async()=>{
  const {page,errors}=await openPage();
  try{
    await freezeClock(page);
    // Store the result in-page so evaluation does not await the deliberately unfinished request.
    const observed=endpoint==='pending-body'?page.waitForResponse(`**/__test__/${endpoint}`):page.waitForRequest(`**/__test__/${endpoint}`);
    await page.evaluate(endpoint=>{globalThis.deadlineResult=null;api(`/__test__/${endpoint}`).then(()=>globalThis.deadlineResult='unexpected success',error=>globalThis.deadlineResult=error.message)},endpoint);
    await observed;await expireRequest(page);
    await page.waitForFunction(()=>globalThis.deadlineResult!==null);
    assert.match(await page.evaluate(()=>globalThis.deadlineResult),/请求超时（15秒）/);
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('creation deadline unlocks the form, preserves input and reuses its key only on manual retry',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);await freezeClock(page);
    const pending=await hold(page,'**/api/projects/1/candidates');
    const original=await draft(page);await page.locator('#proposal button').click();await pending.observed;
    await expireRequest(page);await settled(page,'#proposal');
    assert.match(await page.locator('#proposalFeedback').textContent(),/请求超时.*写入结果可能不确定/);
    assert.deepEqual(await draft(page),original);assert.equal(pending.requests.length,1);
    assert.equal(await page.locator('#proposal button').isEnabled(),true);
    const retry=await hold(page,'**/api/projects/1/candidates');
    await page.locator('#proposal button').click();await retry.observed;
    assert.equal(retry.requests[0].headers()['idempotency-key'],pending.requests[0].headers()['idempotency-key']);
    retry.release(healthyCreationReceipt(retry.requests[0],71));pending.release(healthyCreationReceipt(pending.requests[0],71));await settled(page,'#proposal');
    assert.match(await page.locator('#proposalFeedback').textContent(),/候选已提交/);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

for(const failure of ['network','invalid-200','invalid-409'])test(`${failure} is localized and retains an uncertain creation key`,async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);await page.locator('#addSourceShortcut').click();
    await page.locator('#sourceForm [name=title]').fill('合成网络恢复草稿');await page.locator('#sourceForm [name=content]').fill('不能因为响应损坏而删除。');
    const sent=[];
    await page.route('**/api/projects/1/sources',async route=>{
      if(route.request().method()!=='POST'){await route.fallback();return}
      sent.push(route.request());
      if(failure==='network')await route.abort();else await route.fulfill({status:failure==='invalid-409'?409:200,contentType:'text/html',body:'<html>synthetic invalid JSON</html>'});
    });
    await page.locator('#sourceForm button').click();await settled(page,'#sourceForm');
    assert.match(await page.locator('#sourceFeedback').textContent(),failure==='network'?/网络连接失败.*写入结果可能不确定/:/不是有效 JSON.*写入结果可能不确定/);
    assert.equal(await page.locator('#sourceForm [name=title]').inputValue(),'合成网络恢复草稿');assert.equal(sent.length,1);
    const retry=await hold(page,'**/api/projects/1/sources');await page.locator('#sourceForm button').click();await retry.observed;
    assert.equal(retry.requests[0].headers()['idempotency-key'],sent[0].headers()['idempotency-key']);
    retry.release(healthyCreationReceipt(retry.requests[0],72));await settled(page,'#sourceForm');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

const pagedLists=[
  {root:'facts',key:'after',start:'0',next:'next_after',items:'facts',row:id=>({id,subject:`合成事实${id}`,predicate:'状态',value:'可回查',version:1,source:'合成依据'})},
  {root:'history',key:'before',start:null,next:'next_before',items:'history',row:id=>({id,fact_id:id,subject:`合成历史${id}`,predicate:'状态',value:'可回查',version:1,source:'合成依据',created_at:'2026-01-01T00:00:00Z'})},
  {root:'candidates',key:'before',start:null,next:'next_before',items:'candidates',row:id=>({id,subject:`合成候选${id}`,predicate:'状态',value:'待审',status:'pending',expected_version:0,source_id:1,source:'合成依据'})},
  {root:'sources',key:'after',start:'0',next:'next_after',items:'sources',row:id=>({id,title:`合成来源${id}`,content:'本页依据全文。'})},
  {root:'audit',key:'before',start:null,next:'next_before',items:'audit',row:id=>({id,action:'合成审计',detail:`测试操作${id}`,actor_id:1,created_at:'2026-01-01T00:00:00Z'})}
];
test('all five lists retain their successful page and cursor through consecutive failures and retry',async t=>{
  for(const config of pagedLists)await t.test(config.root,async()=>{
    const {page,errors}=await openPage();
    try{
      let failures=0;const cursors=[];
      await page.route(`**/api/projects/1/${config.root}?*`,async route=>{
        const cursor=new URL(route.request().url()).searchParams.get(config.key);cursors.push(cursor);
        if(cursor==='2'&&++failures<=2){
          await route.fulfill({status:failures===1?503:200,contentType:'application/json',body:failures===1?JSON.stringify({error:'连续失败一'}):'broken JSON'});return;
        }
        const id=cursor==='2'?3:cursor==='1'?2:1;
        await route.fulfill({json:{[config.items]:[config.row(id)],[config.next]:id===3?null:id,role:'owner'}});
      });
      await login(page);await page.locator(`#${config.root}Status`).getByText(/第 1 页/).waitFor();
      await page.locator(`#${config.root}Next`).click();await page.locator(`#${config.root}Status`).getByText(/第 2 页/).waitFor();
      const original=await page.locator(`#${config.root}`).textContent();
      for(const error of [/503 连续失败一/,/不是有效 JSON/]){
        await page.locator(`#${config.root}Next`).click();await page.locator(`#${config.root}Status`).getByText(error).waitFor();
        assert.equal(await page.locator(`#${config.root}`).textContent(),original);
        assert.equal(await page.locator(`#${config.root}Previous`).isEnabled(),true);
        assert.equal(await page.locator(`#${config.root}Next`).isEnabled(),true);
        if(config.root==='candidates')assert.equal(await page.locator('#candidates').getByRole('button',{name:'批准',exact:true}).isEnabled(),true);
        if(config.root==='sources')assert.equal(await page.locator('#sourceSelect').inputValue(),'1');
      }
      await page.locator(`#${config.root}Next`).click();await page.locator(`#${config.root}Status`).getByText(/第 3 页/).waitFor();
      assert.equal(await page.locator(`#${config.root}Next`).isDisabled(),true);
      assert.deepEqual(cursors,[config.start,'1','2','2','2'],'failures never advance or truncate the successful cursor stack');
      await page.locator(`#${config.root}Previous`).click();await page.locator(`#${config.root}Status`).getByText(/第 2 页/).waitFor();
      assert.equal(await page.locator(`#${config.root}`).textContent(),original);
      assert.equal(cursors.at(-1),'1');assert.equal(await page.locator(`#${config.root}Next`).isEnabled(),true);
      assert.deepEqual(errors,[]);
    }finally{await closePage(page)}
  });
});

test('a timed-out new search retains the accepted query and cursor for subsequent pagination',async()=>{
  const {page,errors}=await openPage();
  try{
    const queries=[];
    await page.route('**/api/projects/1/facts?*',async route=>{
      const url=new URL(route.request().url());queries.push([url.searchParams.get('q'),url.searchParams.get('after')]);
      const id=url.searchParams.get('after')==='1'?2:1;
      await route.fulfill({json:{facts:[pagedLists[0].row(id)],next_after:id===1?1:null}});
    });
    await login(page);await page.locator('#factsStatus').getByText(/第 1 页/).waitFor();
    const original=await page.locator('#facts').textContent();await freezeClock(page);
    const search=await hold(page,url=>url.pathname==='/api/projects/1/facts'&&url.searchParams.get('q')==='失败的新检索','GET');
    await page.locator('#searchForm [name=q]').fill('失败的新检索');await page.locator('#searchForm button').click();await search.observed;
    await expireRequest(page);await page.locator('#factsStatus').getByText(/请求超时（15秒）/).waitFor();
    assert.equal(await page.locator('#facts').textContent(),original);assert.equal(await page.locator('#factsNext').isEnabled(),true);
    assert.equal(await page.locator('#factsPrevious').isDisabled(),true);
    search.release({facts:[],next_after:null});
    await page.locator('#factsNext').click();await page.locator('#factsStatus').getByText(/第 2 页/).waitFor();
    assert.deepEqual(queries,[['','0'],['','1']]);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a failed candidate filter keeps the accepted status, role and pending actions',async()=>{
  const {page,errors}=await openPage();
  try{
    await conflictFixture(page);
    await page.route('**/api/projects/1/candidates?*',async route=>{
      if(new URL(route.request().url()).searchParams.get('status')==='approved')await route.fulfill({status:503,json:{error:'合成筛选失败'}});
      else await route.fallback();
    });
    const original=await page.locator('#candidates').textContent();
    await page.locator('#candidateFilter').selectOption('approved');await page.locator('#candidatesStatus').getByText(/503 合成筛选失败/).waitFor();
    assert.equal(await page.locator('#candidateFilter').inputValue(),'all');
    assert.equal(await page.locator('#candidates').textContent(),original);
    assert.equal(await page.locator('#candidates').getByRole('button',{name:'批准',exact:true}).isEnabled(),true);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

async function acceptedPage(page,config){
  return {text:await page.locator(`#${config.root}`).textContent(),state:await page.evaluate(root=>({facts:factState,history:historyState,candidates:candidateState,sources:sourceState,audit:auditState})[root],config.root),previous:await page.locator(`#${config.root}Previous`).isDisabled(),next:await page.locator(`#${config.root}Next`).isDisabled(),selection:await page.locator('#sourceSelect').inputValue()};
}
test('all five lists reject an HTTP 200 empty-object receipt before replacing the accepted page',async t=>{
  for(const config of pagedLists)await t.test(config.root,async()=>{
    const {page,errors}=await openPage();
    try{
      const cursors=[];let recover=false;
      await page.route(`**/api/projects/1/${config.root}?*`,async route=>{
        const cursor=new URL(route.request().url()).searchParams.get(config.key);cursors.push(cursor);
        if(cursor==='1'&&!recover){await route.fulfill({json:{}});return}
        const id=cursor==='1'?2:1;
        await route.fulfill({json:{[config.items]:[config.row(id)],[config.next]:id===1?1:null,role:'owner'}});
      });
      await login(page);await page.locator(`#${config.root}Status`).getByText(/第 1 页/).waitFor();
      const original=await acceptedPage(page,config);
      await page.locator(`#${config.root}Next`).click();await page.locator(`#${config.root}Status`).getByText(/加载失败/).waitFor();
      assert.deepEqual(await acceptedPage(page,config),original,'a malformed success receipt must not change DOM, accepted state, evidence or navigation');
      assert.match(await page.locator(`#${config.root}Status`).textContent(),/分页响应格式异常/);
      recover=true;await page.locator(`#${config.root}Next`).click();await page.locator(`#${config.root}Status`).getByText(/第 2 页/).waitFor();
      assert.deepEqual(cursors,[config.start,'1','1']);assert.equal(await page.locator(`#${config.root}Next`).isDisabled(),true);assert.deepEqual(errors,[]);
    }finally{await closePage(page)}
  });
});

test('all five lists reject malformed JSON page shapes and cursors, then recover with accepted filters',async t=>{
  for(const config of pagedLists)await t.test(config.root,async()=>{
    const {page,errors}=await openPage();
    try{
      let bad=null;const requests=[];
      const valid=id=>({[config.items]:[config.row(id)],[config.next]:id===1?1:null,role:'owner'});
      await page.route(`**/api/projects/1/${config.root}?*`,async route=>{
        const url=new URL(route.request().url());requests.push({cursor:url.searchParams.get(config.key),query:url.searchParams.get('q'),status:url.searchParams.get('status')});
        await route.fulfill({json:bad?bad.value:valid(url.searchParams.get(config.key)==='1'?2:1)});
      });
      await login(page);await page.locator(`#${config.root}Status`).getByText(/第 1 页/).waitFor();
      if(config.root==='facts'||config.root==='sources'){
        const form=config.root==='facts'?'#searchForm':'#sourceSearchForm';
        await page.locator(`${form} [name=q]`).fill('已接受的检索');await page.locator(`${form} button`).click();
        await page.waitForFunction(root=>({facts:factState,sources:sourceState})[root].query==='已接受的检索',config.root);
      }else if(config.root==='candidates'){
        await page.locator('#candidateFilter').selectOption('pending');await page.waitForFunction(()=>candidateState.status==='pending');
      }
      const original=await acceptedPage(page,config),first=requests.length;
      const invalid=[null,{[config.items]:null,[config.next]:null,role:'owner'},{[config.items]:[null],[config.next]:null,role:'owner'},{[config.items]:[config.row(2)],role:'owner'},...[-1,0,1.5,'2',Number.MAX_SAFE_INTEGER+1,99].map(cursor=>({...valid(2),[config.next]:cursor})),{...valid(2),[config.items]:[],[config.next]:2}];
      if(config.root==='candidates')invalid.push({...valid(2),role:'admin'});
      if(config.root==='sources')invalid.push({...valid(2),sources:[{...config.row(2),content:null}]});
      for(const receipt of invalid){
        bad={value:receipt};await page.locator(`#${config.root}Next`).click();
        await page.waitForFunction(root=>document.querySelector(`#${root}`).getAttribute('aria-busy')==='false',config.root);
        assert.match(await page.locator(`#${config.root}Status`).textContent(),/分页响应格式异常/);
        assert.deepEqual(await acceptedPage(page,config),original);
      }
      bad=null;await page.locator(`#${config.root}Next`).click();await page.locator(`#${config.root}Status`).getByText(/第 2 页/).waitFor();
      assert.equal(await page.locator(`#${config.root}Next`).isDisabled(),true);
      const retries=requests.slice(first);assert.equal(retries.length,invalid.length+1);
      assert.ok(retries.every(request=>request.cursor==='1'));
      if(config.root==='facts'||config.root==='sources')assert.ok(retries.every(request=>request.query==='已接受的检索'));
      if(config.root==='candidates')assert.ok(retries.every(request=>request.status==='pending'));
      assert.deepEqual(errors,[]);
    }finally{await closePage(page)}
  });
});

async function projectBoundaryFixture(page){
  for(const config of pagedLists.filter(config=>['facts','history','audit'].includes(config.root))){
    await page.route(`**/api/projects/1/${config.root}?*`,route=>route.fulfill({json:{[config.items]:[config.row(1)],[config.next]:null,role:'owner'}}));
  }
  await conflictFixture(page);
  await page.waitForFunction(()=>['facts','history','candidates','sources','audit'].every(id=>document.querySelector(`#${id} .entry`)));
  await page.locator('#proposal [name=value]').fill('切换期间保留的候选草稿');
  await page.locator('#addSourceShortcut').click();await page.locator('#sourceForm [name=title]').fill('切换期间保留的来源草稿');
  await page.locator('#sourceForm [name=content]').fill('尚未提交的原文。');
  let seen,release,mode='ok',cancelled=false;const observed=new Promise(resolve=>{seen=resolve}),gate=new Promise(resolve=>{release=resolve});
  pageCleanups.get(page).add(()=>{cancelled=true;seen();release()});
  await page.route('**/api/projects/2/**',async route=>{
    const resource=new URL(route.request().url()).pathname.split('/').at(-1);if(resource==='data')seen();
    await gate;if(cancelled){await route.abort();return}
    if(mode==='network'){await route.abort();return}
    if(mode==='403'){await route.fulfill({status:403,json:{error:'合成项目权限拒绝'}});return}
    const config=pagedLists.find(config=>config.root===resource);
    await route.fulfill({json:resource==='data'?{sourceTextIsUntrusted:true,role:'owner'}:{[config.items]:[config.row(20)],[config.next]:null,role:'owner'}});
  });
  return {get observed(){return bounded(observed,'waiting for project data request')},release:value=>{mode=value;release()},recover:()=>{mode='ok'}};
}
async function assertClearedBoundary(page){
  assert.equal(await page.locator('#project').inputValue(),'2');
  for(const config of pagedLists){
    assert.equal(await page.locator(`#${config.root}`).textContent(),'');
    assert.equal(await page.locator(`#${config.root} button`).count(),0);
    assert.equal(await page.locator(`#${config.root}Previous`).isDisabled(),true);
    assert.equal(await page.locator(`#${config.root}Next`).isDisabled(),true);
  }
  assert.equal(await page.locator('#sourceSelect option').count(),0);
  for(const selector of ['#proposal button','#sourceForm button','#stale','#injection'])assert.equal(await page.locator(selector).isDisabled(),true);
  assert.equal(await page.locator('#proposal [name=value]').inputValue(),'切换期间保留的候选草稿');
  assert.equal(await page.locator('#sourceForm [name=title]').inputValue(),'切换期间保留的来源草稿');
  assert.equal(await page.locator('#sourceForm [name=content]').inputValue(),'尚未提交的原文。');
}
for(const failure of ['403','network'])test(`project switch clears old interactions before delayed data and ${failure}, then recovers`,async()=>{
  const {page,errors}=await openPage();
  try{
    const pending=await projectBoundaryFixture(page);
    assert.equal(await page.getByRole('button',{name:'用最新版本填写新候选',exact:true}).count(),1);
    await page.locator('#project').selectOption('2');await pending.observed;
    await assertClearedBoundary(page);
    pending.release(failure);await page.locator('#notice').getByText(failure==='403'?/工作台加载失败：403 合成项目权限拒绝/:/工作台加载失败：网络连接失败/).waitFor();
    await page.waitForFunction(()=>['facts','history','candidates','sources','audit'].every(id=>document.querySelector(`#${id}`).getAttribute('aria-busy')==='false'));
    await assertClearedBoundary(page);
    pending.recover();await page.locator('#refreshWorkspace').click();await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);
    assert.equal(await page.locator('#sourceSelect').inputValue(),'20');
    await page.locator('#candidates').getByText(/合成候选20/).waitFor();
    assert.doesNotMatch(await page.locator('#candidates').textContent(),/合成冲突/);
    assert.equal(await page.locator('#proposal [name=value]').inputValue(),'切换期间保留的候选草稿');
    assert.equal(await page.locator('#sourceForm [name=title]').inputValue(),'切换期间保留的来源草稿');
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('late project B data and lists cannot replace project A after returning',async()=>{
  const {page,errors}=await openPage();
  try{
    const pending=await projectBoundaryFixture(page);
    await page.locator('#project').selectOption('2');await pending.observed;await assertClearedBoundary(page);
    await page.locator('#project').selectOption('1');await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled&&['facts','history','candidates','sources','audit'].every(id=>document.querySelector(`#${id}`).getAttribute('aria-busy')==='false'));
    const original=await page.locator('#workspace').textContent(),selection=await page.locator('#sourceSelect').inputValue();
    const completed=Promise.all(['data',...pagedLists.map(config=>config.root)].map(resource=>page.waitForResponse(response=>new URL(response.url()).pathname===`/api/projects/2/${resource}`)));
    pending.release('ok');await bounded(Promise.all((await completed).map(response=>response.finished())),'finishing delayed project responses');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#project').inputValue(),'1');
    assert.equal(await page.locator('#workspace').textContent(),original);
    assert.equal(await page.locator('#sourceSelect').inputValue(),selection);
    assert.equal(await page.locator('#proposal [name=value]').inputValue(),'切换期间保留的候选草稿');
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('cleanup releases an abandoned held route and closes the page within its deadline',async()=>{
  const {page}=await openPage();
  try{
    const pending=await hold(page,'**/api/login');
    await submitTwice(page,'#loginForm');await pending.observed;
    // Model an assertion failing before the normal pending.release() path.
    await closePage(page);assert.equal(page.isClosed(),true);
  }finally{if(!page.isClosed())await closePage(page)}
});

test('browser cleanup failure still destroys an unfinished HTTP connection and remains a failure',async()=>{
  const isolated=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{"unfinished":')});
  let request;
  try{
    await new Promise(resolve=>isolated.listen(0,'127.0.0.1',resolve));
    const response=await bounded(new Promise((resolve,reject)=>{request=http.get(`http://127.0.0.1:${isolated.address().port}`,resolve);request.on('error',reject)}),'opening unfinished test response');
    const disconnected=new Promise(resolve=>response.once('close',resolve));response.on('error',()=>{});
    await assert.rejects(closeFixture({browser:{close:async()=>{throw new Error('synthetic browser close failure')}},server:isolated}),error=>error instanceof AggregateError&&error.errors.some(error=>error.message==='synthetic browser close failure'));
    await bounded(disconnected,'destroying unfinished HTTP connection');assert.equal(isolated.listening,false);
  }finally{request?.destroy();isolated.closeAllConnections();isolated.close()}
});

test('keyboard login moves focus into the loaded workspace',async()=>{
  const {page,errors}=await openPage();
  try{
    await page.locator('#loginForm [name=password]').focus();await page.keyboard.press('Enter');await settled(page,'#loginForm');
    assert.equal(await page.locator('#project').evaluate(node=>document.activeElement===node),true);
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});
for(const failure of ['empty','503'])test(`initial project ${failure} leaves a keyboard reachable retry after login`,async()=>{
  const {page,errors}=await openPage();
  try{
    let attempts=0;
    await page.route('**/api/projects',async route=>{
      if(++attempts===1)await route.fulfill(failure==='empty'?{json:[]}:{status:503,json:{error:'合成初始项目故障'}});
      else await route.fallback();
    });
    await page.locator('#loginForm [name=password]').focus();await page.keyboard.press('Enter');await settled(page,'#loginForm');
    assert.equal(await page.locator('#refreshWorkspace').evaluate(node=>document.activeElement===node),true);
    assert.equal(await page.locator('#proposal button').isDisabled(),true);
    await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);
    assert.equal(attempts,2);assert.equal(await page.locator('#project').inputValue(),'1');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('login completion does not steal focus from a draft edited during project loading',async()=>{
  const {page,errors}=await openPage();
  try{
    const projects=await hold(page,'**/api/projects','GET');
    await page.locator('#loginForm button').click();await projects.observed;
    await page.locator('#proposal [name=value]').fill('用户主动编辑的候选草稿');
    projects.release([{id:1,name:'合成项目一',role:'owner'}]);await settled(page,'#loginForm');
    assert.equal(await page.locator('#proposal [name=value]').evaluate(node=>document.activeElement===node),true);
    assert.equal(await page.locator('#proposal [name=value]').inputValue(),'用户主动编辑的候选草稿');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a successful workspace retry clears its resolved failure notice and remains keyboard reachable',async()=>{
  const {page,errors}=await openPage();
  try{
    let attempts=0;
    await page.route('**/api/projects/1/data?*',async route=>{
      if(++attempts===1)await route.fulfill({status:503,json:{error:'合成工作台故障'}});else await route.fallback();
    });
    await page.locator('#loginForm [name=password]').focus();await page.keyboard.press('Enter');await settled(page,'#loginForm');
    assert.match(await page.locator('#notice').textContent(),/工作台加载失败：503 合成工作台故障/);
    const retryWasFocused=await page.locator('#refreshWorkspace').evaluate(node=>document.activeElement===node);
    await page.locator('#refreshWorkspace').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);
    assert.equal(await page.locator('#notice').textContent(),'');assert.equal(retryWasFocused,true);assert.equal(attempts,2);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('workspace recovery preserves a newer uncertain-operation notice',async()=>{
  const {page,errors}=await openPage();
  try{
    await page.route('**/api/projects/1/data?*',route=>route.fulfill({status:503,json:{error:'合成工作台故障'}}));
    await page.locator('#loginForm button').click();await settled(page,'#loginForm');
    const recovery=await hold(page,'**/api/projects/1/data?*','GET');
    await page.locator('#refreshWorkspace').click();await recovery.observed;
    await page.route('**/api/logout',route=>route.fulfill({status:503,json:{error:'合成退出故障，写入结果可能不确定'}}));
    await page.locator('#identity button').click();await page.locator('#notice').getByText(/503 合成退出故障/).waitFor();
    const newer=await page.locator('#notice').textContent();
    recovery.release({sourceTextIsUntrusted:true,role:'owner'});await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);
    assert.equal(await page.locator('#notice').textContent(),newer);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('late login completion cannot move focus after the user changes workspace',async()=>{
  const {page,errors}=await openPage();
  try{
    const initial=await hold(page,'**/api/projects/1/data?*','GET');
    await page.locator('#loginForm button').click();await initial.observed;
    await page.locator('#project').selectOption('2');await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);
    await page.locator('.intro h1').click();assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);
    initial.release({sourceTextIsUntrusted:true,role:'owner'});await settled(page,'#loginForm');
    assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);
    assert.equal(await page.locator('#project').inputValue(),'2');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a malformed bootstrap cannot become accepted workspace data or enable writes',async()=>{
  const {page,errors}=await openPage();
  try{
    await page.route('**/api/projects/1/data?*',route=>route.fulfill({json:{}}));
    await page.locator('#loginForm button').click();await settled(page,'#loginForm');
    assert.equal(await page.evaluate(()=>data),null);
    for(const selector of ['#proposal button','#sourceForm button','#stale','#injection'])assert.equal(await page.locator(selector).isDisabled(),true);
    assert.match(await page.locator('#notice').textContent(),/工作台响应格式异常/);
    await page.unroute('**/api/projects/1/data?*');await page.locator('#refreshWorkspace').click();await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);
    assert.equal(await page.locator('#notice').textContent(),'');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a malformed project list cannot publish partial options at a refreshed access boundary',async()=>{
  const {page,errors}=await openPage();
  try{
    await conflictFixture(page);await page.waitForFunction(()=>['facts','history','candidates','sources','audit'].every(id=>document.querySelector(`#${id}`).getAttribute('aria-busy')==='false'));
    await page.locator('#proposal [name=value]').fill('保留的候选草稿');
    const priorText=await page.locator('#proposal [name=value]').inputValue();
    await page.route('**/api/projects',route=>route.fulfill({json:[{id:9,name:'不可部分接纳的项目',role:'owner'},null]}));
    await page.evaluate(()=>loadProjects());
    assert.equal(await page.evaluate(()=>projectId),null);
    assert.equal(await page.locator('#project option').count(),0);assert.equal(await page.locator('#sourceSelect option').count(),0);
    for(const root of ['facts','history','candidates','sources','audit'])assert.equal(await page.locator('#'+root).textContent(),'');
    assert.equal(await page.locator('#proposal [name=value]').inputValue(),priorText);
    assert.equal(await page.locator('#proposal [name=value]').inputValue(),'保留的候选草稿');assert.match(await page.locator('#notice').textContent(),/项目列表响应格式异常/);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('an invalid project id cannot create invalid API paths and the project list can be retried',async()=>{
  const {page,errors}=await openPage();
  try{
    const invalid=[];page.on('request',request=>{if(/\/api\/projects\/(?:NaN|null|undefined|0)\//.test(request.url()))invalid.push(request.url())});
    await page.route('**/api/projects',route=>route.fulfill({json:[{id:'not-a-number',name:'合成坏项目',role:'owner'}]}));
    await page.locator('#loginForm button').click();await settled(page,'#loginForm');
    assert.equal(await page.locator('#project option').count(),0);assert.deepEqual(invalid,[]);
    assert.equal(await page.evaluate(()=>projectId),null);assert.equal(await page.locator('#sourceForm button').isDisabled(),true);
    await page.unroute('**/api/projects');await page.locator('#refreshWorkspace').click();await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);
    assert.equal(await page.locator('#project').inputValue(),'1');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('bad bootstrap receipts keep writes unavailable and drafts intact until a valid role and trust receipt',async()=>{
  const {page,errors}=await openPage();
  try{
    let receipt={};await page.route('**/api/projects/1/data?*',route=>route.fulfill({json:receipt}));
    await page.locator('#loginForm button').click();await settled(page,'#loginForm');
    await page.locator('#proposal [name=value]').fill('坏回执期间保留的候选草稿');
    await page.locator('#addSourceShortcut').click();await page.locator('#sourceForm [name=title]').fill('坏回执期间保留的来源草稿');
    for(const value of [null,[],{}, {role:'owner'}, {sourceTextIsUntrusted:true}, {role:'admin',sourceTextIsUntrusted:true}, {role:'owner',sourceTextIsUntrusted:false}, {role:'owner',sourceTextIsUntrusted:'true'}]){
      receipt=value;await page.evaluate(()=>load());
      assert.equal(await page.evaluate(()=>data),null);assert.match(await page.locator('#notice').textContent(),/工作台响应格式异常/);
      for(const selector of ['#proposal button','#sourceForm button','#stale','#injection'])assert.equal(await page.locator(selector).isDisabled(),true);
      assert.equal(await page.locator('#proposal [name=value]').inputValue(),'坏回执期间保留的候选草稿');
      assert.equal(await page.locator('#sourceForm [name=title]').inputValue(),'坏回执期间保留的来源草稿');
      assert.equal(await page.locator('#sourceSelect').inputValue(),'1','independently valid source pages remain readable');
    }
    receipt={sourceTextIsUntrusted:true,role:'owner',additiveMetadata:{ignored:'not rendered or retained'}};
    await page.locator('#refreshWorkspace').click();await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);
    assert.deepEqual(await page.evaluate(()=>data),{role:'owner',sourceTextIsUntrusted:true});assert.equal(await page.locator('#notice').textContent(),'');
    assert.equal(await page.locator('#proposal [name=value]').inputValue(),'坏回执期间保留的候选草稿');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('project receipts reject invalid shapes and identities while allowing actual unconstrained names',async()=>{
  const {page,errors}=await openPage();
  try{
    let receipt={};const invalidPaths=[];
    page.on('request',request=>{if(/\/api\/projects\/(?:NaN|null|undefined|0|-1)\//.test(request.url()))invalidPaths.push(request.url())});
    await page.route('**/api/projects',route=>route.fulfill({json:receipt}));
    await page.locator('#loginForm button').click();await settled(page,'#loginForm');
    const valid={id:1,name:'合成项目',role:'owner'};
    for(const value of [null,{},[null],[{}],[{...valid,id:0}],[{...valid,id:1.5}],[{...valid,id:'1'}],[{...valid,id:2147483648}],[{...valid,role:'admin'}],[{...valid,name:null}],[valid,{...valid,name:'重复编号'}]]){
      receipt=value;await page.evaluate(()=>loadProjects());
      assert.equal(await page.evaluate(()=>projectId),null);assert.equal(await page.locator('#project option').count(),0);
      assert.equal(await page.locator('#sourceSelect option').count(),0);assert.match(await page.locator('#notice').textContent(),/项目列表响应格式异常/);
      assert.equal(await page.locator('#sourceForm button').isDisabled(),true);
    }
    receipt=[{id:1,name:'',role:'owner',unused:'ignored'},{id:2,name:'长'.repeat(300),role:'member'}];
    await page.locator('#refreshWorkspace').click();await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);
    assert.deepEqual(await page.locator('#project option').allTextContents(),[' · owner','长'.repeat(300)+' · member']);
    assert.equal(await page.locator('#project').inputValue(),'1');assert.deepEqual(invalidPaths,[]);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a malformed bootstrap cannot masquerade as recovery from a prior workspace failure',async()=>{
  const {page,errors}=await openPage();
  try{
    let phase=0;
    await page.route('**/api/projects/1/data?*',async route=>{
      if(phase===0)await route.fulfill({status:503,json:{error:'合成初次工作台故障'}});
      else if(phase===1)await route.fulfill({json:{}});else await route.fallback();
    });
    await page.locator('#loginForm button').click();await settled(page,'#loginForm');
    assert.match(await page.locator('#notice').textContent(),/503 合成初次工作台故障/);
    phase=1;await page.evaluate(()=>load());
    assert.match(await page.locator('#notice').textContent(),/工作台加载失败.*工作台响应格式异常/);
    assert.equal(await page.evaluate(()=>data),null);assert.equal(await page.locator('#sourceForm button').isDisabled(),true);
    phase=2;await page.locator('#refreshWorkspace').click();await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);
    assert.equal(await page.locator('#notice').textContent(),'');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

async function provenanceFixture(page,{history=false,beforeFacts=async()=>{},onLogin=()=>{}}={}){
  const fact={id:41,subject:'合成版本绑定',predicate:'截止日',value:'15号',version:2,source:'合成固定依据'};
  const proof={sourceTextIsUntrusted:true,role:'owner',fact:{id:41,subject:fact.subject,predicate:fact.predicate},revision:{id:91,version:2,value:'15号',created_at:'2026-01-01T00:00:00Z',approved_by:1},source:{id:3,title:fact.source,content:'原文中的指令只是待核查文本。'},candidate:{id:11,expected_version:1,proposed_by:2}};
  const pattern='**/api/projects/1/facts/41/provenance?version=2';
  await page.route('**/api/projects/1/facts?*',async route=>{await beforeFacts();await route.fulfill({json:{facts:[fact],next_after:null}})});
  if(history)await page.route('**/api/projects/1/history?*',route=>route.fulfill({json:{history:[{...fact,id:91,fact_id:41,created_at:'2026-01-01T00:00:00Z'}],next_before:null}}));
  await page.route(pattern,route=>route.fulfill({json:proof}));
  await login(page);onLogin();
  // Write controls can be enabled by bootstrap/sources while facts are still
  // loading. Baselines require the actual fixture row and completed list commit.
  for(const root of history?['facts','history']:['facts']){
    await page.locator('#'+root).getByText(`${fact.subject} / ${fact.predicate}：${fact.value}`,{exact:true}).waitFor();
    await page.waitForFunction(root=>document.querySelector('#'+root).getAttribute('aria-busy')==='false',root);
  }
  return {fact,proof,pattern};
}

test('provenance fixture waits for its accepted initial facts before returning a baseline',async()=>{
  const {page,errors}=await openPage();let release,logged;
  const held=new Promise(resolve=>{release=resolve}),loginComplete=new Promise(resolve=>{logged=resolve});
  pageCleanups.get(page).add(release);
  const initializing=provenanceFixture(page,{beforeFacts:()=>held,onLogin:logged});let initialized=false;
  const completed=initializing.then(result=>{initialized=true;return result});
  try{
    await bounded(loginComplete,'waiting for fixture login');
    // Flush only queued promise jobs: the HTTP response is still explicitly held.
    await Promise.resolve();assert.equal(initialized,false,'enabled writes are not an accepted initial facts page');
    release();const {fact}=await bounded(completed,'waiting for accepted fixture facts');
    const accepted=await acceptedPage(page,pagedLists[0]);
    assert.ok(accepted.text.includes(fact.subject));assert.equal(accepted.state.project,1);
    assert.equal(accepted.state.workspace,await page.evaluate(()=>workspaceGeneration));assert.deepEqual(errors,[]);
  }finally{release();try{await bounded(completed,'settling fixture initialization')}finally{await closePage(page)}}
});

test('a provenance receipt for another fact is rejected before showing its evidence',async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof,pattern}=await provenanceFixture(page);const wrong=structuredClone(proof);wrong.fact.id=99;
    await page.route(pattern,route=>route.fulfill({json:wrong}));
    await page.locator('#facts').getByRole('button',{name:'查看依据',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#facts button').disabled);
    assert.match(await page.locator('#facts .provenance-detail').textContent(),/依据回执格式异常/);
    assert.equal(await page.locator('#facts').getByRole('button',{name:'重试依据',exact:true}).count(),1);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a latest comparison receipt for another candidate cannot overwrite the proposal draft',async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof,prepare}=await conflictFixture(page),wrong=structuredClone(proof);wrong.candidate.id=99;
    await page.locator('#proposal [name=value]').fill('明确保留的草稿');const original=await draft(page);
    await page.route('**/api/projects/1/candidates/10/source',route=>route.fulfill({json:wrong}));
    await prepare.click();await page.waitForFunction(()=>[...document.querySelectorAll('#candidates button')].find(button=>button.textContent==='用最新版本填写新候选')?.disabled===false);
    assert.deepEqual(await draft(page),original);assert.match(await page.locator('#candidateFeedback').textContent(),/候选核对回执格式异常/);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('current and historical provenance validate the pinned fact and complete evidence before display',async t=>{
  for(const root of ['facts','history'])await t.test(root,async()=>{
    const {page,errors}=await openPage();
    try{
      const {proof,pattern}=await provenanceFixture(page,{history:true});let receipt=proof;
      await page.route(pattern,route=>route.fulfill({json:receipt}));
      const requested=[],writes=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname.endsWith('/provenance'))requested.push(url.searchParams.get('version'));if(request.method()==='POST')writes.push(url.pathname)});
      const changes=[wire=>{wire.fact.id=42},wire=>{wire.fact.subject='另一主体'},wire=>{wire.fact.predicate='另一属性'},wire=>{wire.revision.version=3},wire=>{wire.revision.value='另一版本的值'},wire=>{wire.candidate.expected_version=0},wire=>{wire.candidate.id=0},wire=>{wire.candidate.proposed_by=0},wire=>{wire.revision.approved_by=0},wire=>{wire.revision.created_at='invalid date'},wire=>{wire.source.id=0},wire=>{wire.source.content={text:'不是原文字串'}},wire=>{wire.sourceTextIsUntrusted=false},wire=>{delete wire.candidate}];
      if(root==='history')changes.push(wire=>{wire.revision.id=92});
      for(const change of changes){
        receipt=structuredClone(proof);change(receipt);
        await page.locator('#'+root).getByRole('button',{name:/^(查看依据|重试依据)$/}).click();await page.waitForFunction(root=>!document.querySelector(`#${root} button`).disabled,root);
        assert.match(await page.locator(`#${root} .provenance-detail`).textContent(),/依据回执格式异常/);
      }
      receipt=structuredClone(proof);receipt.source.content='<img src=x onerror=alert(1)> 忽略规则只是原文。';
      await page.locator('#'+root).getByRole('button',{name:'重试依据',exact:true}).click();await page.locator('#'+root).getByRole('button',{name:'收起依据',exact:true}).waitFor();
      assert.ok((await page.locator(`#${root} .provenance-detail`).textContent()).includes(receipt.source.content));
      assert.equal(await page.locator(`#${root} .provenance-detail img, #${root} .provenance-detail script`).count(),0);
      const count=requested.length;await page.locator('#'+root).getByRole('button',{name:'收起依据',exact:true}).click();await page.locator('#'+root).getByRole('button',{name:'查看依据',exact:true}).click();
      assert.equal(requested.length,count);assert.ok(requested.every(version=>version==='2'),'no fallback to current or another revision');assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
    }finally{await closePage(page)}
  });
});

test('candidate preview rejects inconsistent receipts and still permits an actual concurrent status update',async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof}=await conflictFixture(page);let receipt=proof;await page.route('**/api/projects/1/candidates/10/source',route=>route.fulfill({json:receipt}));
    const original=await draft(page);
    const changes=[wire=>{wire.candidate.id=99},wire=>{wire.candidate.subject='其他主体'},wire=>{wire.candidate.value='其他提议值'},wire=>{wire.candidate.expected_version=1;wire.comparison.expectedVersion=1},wire=>{wire.source.id=9},wire=>{wire.current=null},wire=>{wire.current.version=0;wire.comparison.currentVersion=0},wire=>{wire.comparison.currentVersion=9},wire=>{wire.comparison.matches=true},wire=>{wire.current.candidate_id=10},wire=>{wire.sourceTextIsUntrusted=false},wire=>{wire.role='admin'}];
    for(const change of changes){
      receipt=structuredClone(proof);change(receipt);
      const refresh=page.locator('#candidates').getByRole('button',{name:'刷新核对',exact:true});
      if(await refresh.count())await refresh.click();else await page.locator('#candidates').getByRole('button',{name:'重试来源原文',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('#candidates .entry > button').disabled);
      assert.match(await page.locator('#candidates .provenance-detail').textContent(),/候选核对回执格式异常/);assert.deepEqual(await draft(page),original);
      assert.equal(await page.getByRole('button',{name:'用最新版本填写新候选',exact:true}).count(),0);
    }
    receipt=structuredClone(proof);receipt.candidate.status='approved';receipt.current={fact_id:21,version:1,value:receipt.candidate.value,source_id:1,candidate_id:10,source_title:receipt.source.title};receipt.comparison={expectedVersion:0,currentVersion:1,matches:false};
    await page.locator('#candidates').getByRole('button',{name:'重试来源原文',exact:true}).click();await page.locator('#candidates').getByRole('button',{name:'刷新核对',exact:true}).waitFor();
    assert.match(await page.locator('#candidates .provenance-detail').textContent(),/该候选已处理/);assert.match(await page.locator('#candidates .provenance-detail').textContent(),/读取时已批准/);
    assert.deepEqual(await draft(page),original);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('invalid latest comparison or source bindings preserve both draft and the prior reviewed panel',async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof,prepare}=await conflictFixture(page);let receipt=proof;await page.route('**/api/projects/1/candidates/10/source',route=>route.fulfill({json:receipt}));
    await page.locator('#proposal [name=value]').fill('不可被坏回执替换的草稿');const original=await draft(page),panel=await page.locator('#candidates .provenance-detail').textContent();
    for(const change of [wire=>{wire.source.id=2},wire=>{wire.candidate.source_id=2;wire.source.id=2},wire=>{wire.comparison.expectedVersion=9},wire=>{wire.comparison.currentVersion=-1},wire=>{wire.comparison.matches='false'},wire=>{wire.current=null;wire.comparison.currentVersion=2},wire=>{wire.source.content=null}]){
      receipt=structuredClone(proof);change(receipt);await prepare.click();await page.waitForFunction(()=>[...document.querySelectorAll('#candidates button')].find(button=>button.textContent==='用最新版本填写新候选')?.disabled===false);
      assert.match(await page.locator('#candidateFeedback').textContent(),/候选核对回执格式异常/);assert.deepEqual(await draft(page),original);assert.equal(await page.locator('#candidates .provenance-detail').textContent(),panel);
    }
    receipt=proof;await prepare.click();await page.locator('#proposalFeedback').getByText(/已用读取时 v2.*尚未提交/).waitFor();
    assert.equal((await draft(page)).value,proof.candidate.value);assert.equal((await draft(page)).expected_version,'2');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('late fact and comparison details cannot populate a later A to B to A visit',async t=>{
  for(const kind of ['facts','candidates'])await t.test(kind,async()=>{
    const {page,errors}=await openPage();
    try{
      let proof,pattern;
      if(kind==='facts')({proof,pattern}=await provenanceFixture(page));else{({proof}=await conflictFixture(page));pattern='**/api/projects/1/candidates/10/source'}
      const pending=await hold(page,pattern,'GET');
      await page.locator('#'+kind).getByRole('button',{name:kind==='facts'?'查看依据':'刷新核对',exact:true}).click();await pending.observed;
      await returnToFirstProject(page);
      const panel=page.locator(`#${kind} .provenance-detail`);assert.equal(await panel.isHidden(),true);
      const response=page.waitForResponse(pattern);pending.release(proof);await (await response).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await panel.isHidden(),true);assert.equal(await panel.textContent(),'');assert.deepEqual(errors,[]);
    }finally{await closePage(page)}
  });
});

async function realHTTP(page,pathname,handler,{method='GET',pattern='**'+pathname}={}){
  const key=method+' '+pathname;assert.equal(httpResponses.has(key),false);
  httpResponses.set(key,handler);pageCleanups.get(page).add(()=>httpResponses.delete(key));
  await page.route(pattern,async route=>{if(route.request().method()===method)await route.continue();else await route.fallback()});
}

test('real HTTP JSON larger than one MiB is rejected rather than accepted in full',async()=>{
  const {page,errors}=await openPage();
  try{
    await realHTTP(page,'/__test__/large-json',(req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({padding:'x'.repeat(1048576)}))});
    const result=await page.evaluate(async()=>{try{await api('/__test__/large-json');return {accepted:true}}catch(error){return {accepted:false,message:error.message}}});
    assert.equal(result.accepted,false);assert.match(result.message,/响应超过 1 MiB/);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('real HTTP malformed UTF-8 inside an otherwise valid JSON string is rejected',async()=>{
  const {page,errors}=await openPage();
  try{
    await realHTTP(page,'/__test__/invalid-utf8',(req,res)=>{res.setHeader('Content-Type','application/json');res.end(Buffer.concat([Buffer.from('{"text":"'),Buffer.from([0xff]),Buffer.from('"}')]))});
    const result=await page.evaluate(async()=>{try{await api('/__test__/invalid-utf8');return {accepted:true}}catch(error){return {accepted:false,message:error.message}}});
    assert.equal(result.accepted,false);assert.match(result.message,/不是有效 UTF-8/);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

function oversizedOpenBody(res,status=200){
  const disconnected=new Promise(resolve=>res.once('close',()=>resolve(!res.writableEnded)));
  res.writeHead(status,{'Content-Type':'application/json'});res.write('{"padding":"');res.write('x'.repeat(1048576));
  // Deliberately do not finish: only actual client cancellation can close this response.
  return disconnected;
}

test('oversized real HTTP GET cancels its open connection, keeps the accepted page and can recover',async()=>{
  const {page,errors}=await openPage();
  try{
    const {fact}=await provenanceFixture(page);let oversized=true,disconnected;
    const original=await acceptedPage(page,pagedLists[0]);
    assert.ok(original.text.includes(fact.subject),'oversized-response baseline must include the accepted initial fact');
    assert.equal(original.state.project,1);assert.equal(original.state.workspace,await page.evaluate(()=>workspaceGeneration));
    await realHTTP(page,'/api/projects/1/facts',(req,res)=>{if(oversized)disconnected=oversizedOpenBody(res);else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({facts:[fact],next_after:null}))}},{pattern:'**/api/projects/1/facts?*'});
    await page.locator('#searchForm [name=q]').fill('超限后人工重试');await page.locator('#searchForm button').click();
    await page.locator('#factsStatus').getByText(/响应超过 1 MiB/).waitFor();
    assert.equal(await bounded(disconnected,'cancelling oversized real GET'),true);assert.deepEqual(await acceptedPage(page,pagedLists[0]),original);
    oversized=false;await page.locator('#searchForm button').click();await page.locator('#factsStatus').getByText(/第 1 页/).waitFor();
    assert.equal(await page.evaluate(()=>factState.query),'超限后人工重试');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

for(const mode of ['large-200','large-403','utf8-403'])test(`real HTTP ${mode} creation receipt stays uncertain and reuses its key on manual retry`,async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);await page.locator('#addSourceShortcut').click();
    await page.locator('#sourceForm [name=title]').fill('真实HTTP合成重试来源');await page.locator('#sourceForm [name=content]').fill('失败时保留的原文');
    const keys=[];let recover=false,disconnected;
    await realHTTP(page,'/api/projects/1/sources',(req,res)=>{
      keys.push(req.headers['idempotency-key']);
      if(recover){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:81,project_id:1,title:'真实HTTP合成重试来源',content:'失败时保留的原文'}));return}
      if(mode==='utf8-403'){res.writeHead(403,{'Content-Type':'application/json'});res.end(Buffer.concat([Buffer.from('{"error":"'),Buffer.from([0xff]),Buffer.from('"}')]))}
      else disconnected=oversizedOpenBody(res,mode==='large-403'?403:200);
    },{method:'POST'});
    await page.locator('#sourceForm button').click();await settled(page,'#sourceForm');
    assert.match(await page.locator('#sourceFeedback').textContent(),mode==='utf8-403'?/不是有效 UTF-8.*写入结果可能不确定/:/响应超过 1 MiB.*写入结果可能不确定/);
    assert.ok(!(await page.locator('#sourceFeedback').textContent()).includes('缩小范围'),'uncertain creation must not suggest changing the request intent');
    if(disconnected)assert.equal(await bounded(disconnected,'cancelling oversized creation response'),true);
    assert.equal(await page.locator('#sourceForm [name=content]').inputValue(),'失败时保留的原文');assert.equal(keys.length,1,'no automatic replay');
    recover=true;await page.locator('#sourceForm button').click();await settled(page,'#sourceForm');
    assert.equal(keys.length,2);assert.equal(keys[1],keys[0]);assert.equal(await page.locator('#sourceSelect').inputValue(),'81');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('exactly one MiB of real UTF-8 JSON is accepted without clipping legitimate Unicode',async()=>{
  const {page,errors}=await openPage();
  try{
    const marker='😀�',padding=1048576-Buffer.byteLength(JSON.stringify({marker,padding:''})),body=JSON.stringify({marker,padding:'x'.repeat(padding)});
    assert.equal(Buffer.byteLength(body),1048576);
    await realHTTP(page,'/__test__/exact-limit',(req,res)=>{res.setHeader('Content-Type','application/json');res.end(body)});
    assert.deepEqual(await page.evaluate(async()=>{const result=await api('/__test__/exact-limit');return {marker:result.marker,padding:result.padding.length}}),{marker,padding});assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

async function apiWithBrokenReaderCleanup(page,pathname,{create=false}={}){
  return page.evaluate(async({pathname,create})=>{
    const cancel=ReadableStreamDefaultReader.prototype.cancel,release=ReadableStreamDefaultReader.prototype.releaseLock;
    ReadableStreamDefaultReader.prototype.cancel=()=>{throw new Error('synthetic-private-cleanup-canary')};
    ReadableStreamDefaultReader.prototype.releaseLock=()=>{throw new Error('synthetic-private-cleanup-canary')};
    try{if(create)await createRecord(pathname,{title:'synthetic'});else await api(pathname);return {unexpectedSuccess:true}}
    catch(error){return {message:error.message,status:error.status??null}}
    finally{ReadableStreamDefaultReader.prototype.cancel=cancel;ReadableStreamDefaultReader.prototype.releaseLock=release}
  },{pathname,create});
}

test('reader cleanup exceptions do not hide the size error or leave the real HTTP body open',async()=>{
  const {page,errors}=await openPage();
  try{
    let disconnected;await realHTTP(page,'/__test__/cleanup-size',(req,res)=>{disconnected=oversizedOpenBody(res)});
    const result=await apiWithBrokenReaderCleanup(page,'/__test__/cleanup-size');
    assert.match(result.message,/响应超过 1 MiB/);assert.equal(result.status,null);assert.ok(!result.message.includes('canary'));
    assert.equal(await bounded(disconnected,'aborting HTTP despite synthetic reader cleanup failure'),true);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a fully read real HTTP 403 remains definitive despite reader cleanup exceptions',async()=>{
  const {page,errors}=await openPage();
  try{
    const keys=[];await realHTTP(page,'/__test__/cleanup-403',(req,res)=>{keys.push(req.headers['idempotency-key']);res.writeHead(403,{'Content-Type':'application/json'});res.end('{"error":"合成权限拒绝"}')},{method:'POST'});
    for(let i=0;i<2;i++)assert.deepEqual(await apiWithBrokenReaderCleanup(page,'/__test__/cleanup-403',{create:true}),{message:'403 合成权限拒绝',status:403});
    assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1],'complete validated rejection clears the creation intent');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('strict decoding accepts a valid multi-byte character split across real HTTP writes',async()=>{
  const {page,errors}=await openPage();
  try{
    await realHTTP(page,'/__test__/split-utf8',(req,res)=>{
      const emoji=Buffer.from('😀');res.writeHead(200,{'Content-Type':'application/json'});res.write(Buffer.concat([Buffer.from('{"text":"'),emoji.subarray(0,2)]));
      const timer=setTimeout(()=>res.end(Buffer.concat([emoji.subarray(2),Buffer.from('"}')])),15);res.once('close',()=>clearTimeout(timer));
    });
    assert.deepEqual(await page.evaluate(()=>api('/__test__/split-utf8')),{text:'😀'});assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a malformed successful login cannot alter authentication state or hide the form',async()=>{
  const {page,errors}=await openPage();
  try{
    let projectRequests=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/projects')projectRequests++});
    await page.route('**/api/login',route=>route.fulfill({json:{csrf:'synthetic-sensitive-opaque-canary'}}));
    await page.locator('#loginForm button').click();await settled(page,'#loginForm');
    assert.equal(await page.locator('#login').isVisible(),true);assert.equal(await page.locator('#workspace').isHidden(),true);
    assert.equal(await page.evaluate(()=>csrf===''),true);assert.equal(await page.locator('#identity').textContent(),'');assert.equal(projectRequests,0);
    assert.match(await page.locator('#notice').textContent(),/登录回执格式异常/);assert.ok(!(await page.locator('body').textContent()).includes('synthetic-sensitive-opaque-canary'));assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a malformed successful logout cannot reload or discard the current draft',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);await settled(page,'#loginForm');await page.locator('#proposal [name=value]').fill('退出未确认时保留的草稿');
    await page.route('**/api/logout',route=>route.fulfill({json:{}}));
    await page.locator('#identity button').click();
    await page.waitForFunction(()=>document.querySelector('#login').hidden===false||document.querySelector('#notice').textContent.includes('退出回执格式异常'));
    assert.equal(await page.locator('#workspace').isVisible(),true);assert.equal(await page.locator('#proposal [name=value]').inputValue(),'退出未确认时保留的草稿');
    assert.match(await page.locator('#notice').textContent(),/退出回执格式异常/);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('login receipts reject malformed names or unsafe header values and accept an unchanged opaque token',async()=>{
  const {page,errors}=await openPage();
  try{
    const marker='synthetic-sensitive-opaque-canary',name='synthetic-private-name',opaque='Opaque.Token-_/:+=~';let receipt={},projectRequests=0,headerPreserved=false;
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/projects'){projectRequests++;headerPreserved=request.headers()['x-csrf-token']===opaque}});
    await page.route('**/api/login',route=>route.fulfill({json:receipt}));
    const invalid=[null,[],{}, {name}, {csrf:marker}, {name:42,csrf:marker}, {name:'   ',csrf:marker}, {name:'前\ud800后',csrf:marker}, {name,csrf:''}, {name,csrf:12}, ...[' '+marker,marker+' ',marker+'\r\n',marker+'\0','非ASCII','\t',marker+'\u007f'].map(csrf=>({name,csrf}))];
    for(const value of invalid){
      receipt=value;await page.locator('#loginForm button').click();await settled(page,'#loginForm');
      assert.equal(await page.locator('#login').isVisible(),true);assert.equal(await page.locator('#workspace').isHidden(),true);
      assert.equal(await page.evaluate(()=>csrf===''),true);assert.equal(await page.locator('#identity').textContent(),'');assert.equal(projectRequests,0);
      assert.match(await page.locator('#notice').textContent(),/登录回执格式异常/);
      const shown=await page.locator('body').textContent();assert.ok(!shown.includes(marker)&&!shown.includes(name));
      assert.equal(await page.locator('#loginForm [name=password]').inputValue(),'demo-owner');assert.equal(await page.locator('#loginForm button').isEnabled(),true);
    }
    receipt={name:'合成显示名😀',csrf:opaque,unused:'not rendered'};
    await page.locator('#loginForm button').click();await settled(page,'#loginForm');
    assert.equal(projectRequests,1);assert.equal(headerPreserved,true);assert.match(await page.locator('#identity').textContent(),/合成显示名😀/);
    assert.equal(await page.evaluate(token=>csrf===token&&![...document.querySelectorAll('input,select,textarea')].some(node=>node.value===token)&&!document.documentElement.outerHTML.includes(token)&&localStorage.length===0&&sessionStorage.length===0,opaque),true);
    assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('logout accepts only an explicit acknowledgement, preserving identity and drafts until a valid retry',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);await settled(page,'#loginForm');await page.locator('#proposal [name=value]').fill('退出确认前的草稿');
    const identity=await page.locator('#identity').textContent();let receipt={},navigations=0;
    page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++});
    await page.route('**/api/logout',route=>route.fulfill({json:receipt}));
    for(const value of [null,[],{}, {ok:false}, {ok:'true'}, {ok:1}, {name:'synthetic-private-name',csrf:'synthetic-sensitive-opaque-canary'}]){
      receipt=value;await page.locator('#switchAccount').click();await settled(page,'#switchAccount');
      assert.equal(navigations,0);assert.equal(await page.locator('#workspace').isVisible(),true);assert.equal(await page.locator('#identity').textContent(),identity);
      assert.equal(await page.locator('#proposal [name=value]').inputValue(),'退出确认前的草稿');assert.match(await page.locator('#notice').textContent(),/尚未确认退出/);
      assert.equal(await page.locator('#switchAccount').isEnabled(),true);assert.equal(await page.locator('#switchAccount').evaluate(node=>document.activeElement===node),true);
      assert.ok(!(await page.locator('#notice').textContent()).includes('synthetic-'));
    }
    receipt={ok:true,unused:'ignored'};const reloaded=page.waitForNavigation({waitUntil:'domcontentloaded'});await page.locator('#switchAccount').click();await reloaded;
    assert.equal(navigations,1);assert.equal(await page.locator('#login').isVisible(),true);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('account switching is single-flight and a failed acknowledgement does not steal draft focus',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);await settled(page,'#loginForm');const pending=await hold(page,'**/api/logout');
    await page.locator('#switchAccount').focus();await page.keyboard.press('Enter');await pending.observed;
    await page.evaluate(()=>{document.querySelector('#switchAccount').onclick();document.querySelector('#switchAccount').onclick()});
    assert.equal(pending.requests.length,1);assert.equal(await page.locator('#switchAccount').isDisabled(),true);assert.equal(await page.locator('#switchAccount').getAttribute('aria-busy'),'true');
    await page.locator('#proposal [name=value]').fill('退出等待期间主动编辑');pending.release({ok:false});await settled(page,'#switchAccount');
    assert.equal(await page.locator('#proposal [name=value]').evaluate(node=>document.activeElement===node),true);
    assert.equal(await page.locator('#proposal [name=value]').inputValue(),'退出等待期间主动编辑');assert.equal(await page.locator('#switchAccount').isEnabled(),true);
    assert.match(await page.locator('#notice').textContent(),/尚未确认退出/);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a complete known logout 401 still returns to the login screen',async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);await settled(page,'#loginForm');await page.route('**/api/logout',route=>route.fulfill({status:401,json:{error:'请先登录'}}));
    const reloaded=page.waitForNavigation({waitUntil:'domcontentloaded'});await page.locator('#switchAccount').click();await reloaded;
    assert.equal(await page.locator('#login').isVisible(),true);assert.equal(await page.locator('#workspace').isHidden(),true);assert.equal(await page.evaluate(()=>csrf===''),true);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

for(const form of ['sourceForm','proposal'])test(`a late ${form} failure preserves the user's current draft focus and caret`,async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);
    const input=form==='sourceForm'?'#sourceForm [name=content]':'#proposal [name=value]',feedback=form==='sourceForm'?'#sourceFeedback':'#proposalFeedback',endpoint=form==='sourceForm'?'sources':'candidates';
    if(form==='sourceForm'){
      await page.locator('#addSourceShortcut').click();
      await page.locator('#sourceForm [name=title]').fill('合成待保存来源');
      await page.locator(input).fill('最初提交的正文');
    }
    const pending=await hold(page,`**/api/projects/1/${endpoint}`);
    await page.locator(`#${form} button`).click();await pending.observed;
    await page.locator(input).fill('读取期间继续编辑的草稿');await page.keyboard.press('ArrowLeft');
    const caret=await page.locator(input).evaluate(node=>({start:node.selectionStart,end:node.selectionEnd}));
    pending.release({error:'合成延迟写入故障'},503);await settled(page,`#${form}`);
    assert.match(await page.locator(feedback).textContent(),/写入结果可能不确定/);
    assert.equal(await page.locator(input).inputValue(),'读取期间继续编辑的草稿');
    assert.equal(await page.locator(input).evaluate(node=>node===document.activeElement),true,'late failure must not take focus from active draft input');
    assert.deepEqual(await page.locator(input).evaluate(node=>({start:node.selectionStart,end:node.selectionEnd})),caret);
    await page.keyboard.type('继续');assert.equal(await page.locator(input).inputValue(),'读取期间继续编辑的草继续稿');
    assert.equal(await page.locator(`#${form} button`).isEnabled(),true);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

for(const form of ['sourceForm','proposal'])test(`a ${form} failure with lost focus keeps feedback and keyboard retry reachable`,async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);
    const feedback=form==='sourceForm'?'#sourceFeedback':'#proposalFeedback',endpoint=form==='sourceForm'?'sources':'candidates';
    if(form==='sourceForm'){
      await page.locator('#addSourceShortcut').click();
      await page.locator('#sourceForm [name=title]').fill('合成可重试来源');
      await page.locator('#sourceForm [name=content]').fill('完整保留的重试正文');
    }
    const initial=await page.locator(`#${form}`).evaluate(node=>Object.fromEntries(new FormData(node))),pending=await hold(page,`**/api/projects/1/${endpoint}`);
    await page.locator(`#${form} button`).focus();await page.keyboard.press('Enter');await pending.observed;
    // Disabling the submitting button normally leaves BODY active in Chromium.
    // Explicit blur also covers the lost-focus recovery contract independently.
    await page.evaluate(()=>document.activeElement.blur());
    pending.release({error:'合成可重试写入故障'},503);await settled(page,`#${form}`);
    assert.equal(await page.locator(feedback).evaluate(node=>node===document.activeElement),true);
    assert.match(await page.locator(feedback).textContent(),/写入结果可能不确定/);
    await page.keyboard.press('Tab');assert.equal(await page.locator(`#${form} button`).evaluate(node=>node===document.activeElement),true);
    const retry=await hold(page,`**/api/projects/1/${endpoint}`);await page.keyboard.press('Enter');await retry.observed;
    assert.equal(retry.requests[0].headers()['idempotency-key'],pending.requests[0].headers()['idempotency-key']);
    assert.deepEqual(retry.requests[0].postDataJSON(),initial);
    retry.release(healthyCreationReceipt(retry.requests[0],form==='sourceForm'?7:8));await settled(page,`#${form}`);
    assert.match(await page.locator(feedback).textContent(),form==='sourceForm'?/来源 #7 已保存/:/候选已提交/);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

async function detailFocusFixture(page,kind){
  if(kind!=='candidates')return provenanceFixture(page,{history:kind==='history'});
  const {proof}=await conflictFixture(page);await page.locator('#refreshCandidates').click();
  await page.locator('#candidates').getByRole('button',{name:'核对来源原文',exact:true}).waitFor();
  return {proof,pattern:'**/api/projects/1/candidates/10/source'};
}
async function keyboardDetailTrigger(page,kind,{refresh=false}={}){
  await page.locator('#'+kind+'Title').focus();
  const text=refresh?'刷新核对':kind==='candidates'?'核对来源原文':'查看依据';
  for(let step=0;step<30;step++){
    await page.keyboard.press('Tab');
    if(await page.evaluate(({kind,text})=>{const node=document.activeElement;return node.tagName==='BUTTON'&&node.closest('#'+kind)&&node.textContent===text},{kind,text}))return;
  }
  assert.fail('detail trigger must be reachable with Tab');
}
async function keyboardDraft(page,direction){
  for(let step=0;step<35;step++){
    await page.keyboard.press(direction);
    if(await page.locator('#proposal [name=value]').evaluate(node=>node===document.activeElement))return;
  }
  assert.fail('draft must remain keyboard reachable during detail loading');
}
for(const kind of ['facts','history','candidates'])test(`keyboard ${kind} detail failure and successful retry restore the current trigger`,async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof,pattern}=await detailFocusFixture(page,kind);await settled(page,'#loginForm');
    await keyboardDetailTrigger(page,kind);const pending=await hold(page,pattern,'GET');await page.keyboard.press('Enter');await pending.observed;
    await page.keyboard.press('Enter');assert.equal(pending.requests.length,1,'a repeated Enter cannot start a duplicate pending detail');
    pending.release({error:'合成键盘详情故障'},503);
    const retry=page.locator('#'+kind).getByRole('button',{name:kind==='candidates'?'重试来源原文':'重试依据',exact:true});await retry.waitFor();
    const panel=page.locator('#'+kind+' .provenance-detail');assert.equal(await panel.getAttribute('aria-live'),'polite');assert.match(await panel.textContent(),/503 合成键盘详情故障/);
    assert.equal(await retry.evaluate(node=>node===document.activeElement),true);assert.equal(await retry.evaluate(node=>getComputedStyle(node).outlineStyle),'solid');
    const next=await hold(page,pattern,'GET');await page.keyboard.press('Enter');await next.observed;proof.source.content='合成完整长来源😀\n'+'长文本'.repeat(600);next.release(proof);
    const trigger=page.locator('#'+kind).getByRole('button',{name:kind==='candidates'?'收起来源原文':'收起依据',exact:true});await trigger.waitFor();
    assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);assert.ok((await panel.textContent()).includes(proof.source.content));
    await page.keyboard.press('Enter');assert.equal(await panel.isHidden(),true);assert.equal(await page.evaluate(({kind})=>document.activeElement.closest('#'+kind)!==null&&document.activeElement.textContent===(kind==='candidates'?'核对来源原文':'查看依据'),{kind}),true);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});
for(const kind of ['facts','candidates'])test(`late ${kind} detail completion leaves an actively edited draft and caret alone`,async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof,pattern}=await detailFocusFixture(page,kind);await settled(page,'#loginForm');await keyboardDetailTrigger(page,kind);
    const pending=await hold(page,pattern,'GET');await page.keyboard.press('Enter');await pending.observed;await keyboardDraft(page,kind==='facts'?'Tab':'Shift+Tab');
    await page.keyboard.press('Control+a');await page.keyboard.type('读取期间保留的新草稿');await page.keyboard.press('ArrowLeft');const input=page.locator('#proposal [name=value]'),caret=await input.evaluate(node=>[node.selectionStart,node.selectionEnd]);
    pending.release(proof);await page.locator('#'+kind).getByRole('button',{name:kind==='candidates'?'收起来源原文':'收起依据',exact:true}).waitFor();
    assert.equal(await input.evaluate(node=>node===document.activeElement),true);assert.deepEqual(await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),caret);await page.keyboard.type('继续');assert.equal(await input.inputValue(),'读取期间保留的新草继续稿');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});
test('keyboard comparison refresh respects a newer draft focus and retains caret and manual submission intent',async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof}=await conflictFixture(page);await settled(page,'#loginForm');await keyboardDetailTrigger(page,'candidates',{refresh:true});
    const pending=await hold(page,'**/api/projects/1/candidates/10/source','GET');await page.keyboard.press('Enter');await pending.observed;await keyboardDraft(page,'Shift+Tab');
    await page.keyboard.press('Control+a');await page.keyboard.type('刷新期间的新草稿');await page.keyboard.press('ArrowLeft');const input=page.locator('#proposal [name=value]'),caret=await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),original=await draft(page);
    pending.release(proof);await page.locator('#candidates').getByRole('button',{name:'刷新核对',exact:true}).waitFor();
    assert.equal(await input.evaluate(node=>node===document.activeElement),true);assert.deepEqual(await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),caret);assert.deepEqual(await draft(page),original);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});
test('a late keyboard detail cannot focus a different A to B to A visit or populate its replacement row',async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof,pattern}=await provenanceFixture(page);await settled(page,'#loginForm');await keyboardDetailTrigger(page,'facts');const pending=await hold(page,pattern,'GET');await page.keyboard.press('Enter');await pending.observed;
    await page.locator('#project').focus();for(const key of ['ArrowDown','ArrowUp']){await page.keyboard.press(key);await page.waitForFunction(()=>['facts','history','candidates','sources','audit'].every(root=>document.querySelector('#'+root).getAttribute('aria-busy')==='false'))}
    assert.equal(await page.locator('#project').inputValue(),'1');const focus=await page.evaluate(()=>document.activeElement.id),response=page.waitForResponse(pattern);pending.release(proof);await (await response).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>document.activeElement.id),focus);assert.equal(focus,'project');assert.equal(await page.locator('#facts .provenance-detail').isHidden(),true);assert.equal(await page.locator('#facts .provenance-detail').textContent(),'');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});
test('an older detail response cannot restore focus ahead of a newer keyboard detail request',async()=>{
  const {page,errors}=await openPage();
  try{
    const {fact,proof,pattern}=await provenanceFixture(page),second={...fact,id:42,subject:'第二个键盘事实'},secondProof=structuredClone(proof);secondProof.fact.id=42;secondProof.fact.subject=second.subject;secondProof.revision.id=92;secondProof.candidate.id=12;
    await page.route('**/api/projects/1/facts?*',route=>route.fulfill({json:{facts:[fact,second],next_after:null}}));await page.locator('#refreshWorkspace').click();await page.locator('#factsStatus').getByText(/2 条/).waitFor();await keyboardDetailTrigger(page,'facts');
    const first=await hold(page,pattern,'GET'),next=await hold(page,'**/api/projects/1/facts/42/provenance?version=2','GET');await page.keyboard.press('Enter');await first.observed;
    await page.keyboard.press('Tab');assert.equal(await page.locator('#facts .entry').nth(1).locator('button').evaluate(node=>node===document.activeElement),true);await page.keyboard.press('Enter');await next.observed;
    first.release(proof);await page.locator('#facts .entry').nth(0).getByRole('button',{name:'收起依据',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.activeElement===document.body),true);
    next.release(secondProof);const newest=page.locator('#facts .entry').nth(1).getByRole('button',{name:'收起依据',exact:true});await newest.waitFor();assert.equal(await newest.evaluate(node=>node===document.activeElement),true);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

const mutationSelectors=['#proposal button','#sourceForm button','#stale','#injection'];
async function settledLists(page){await page.waitForFunction(()=>['facts','history','candidates','sources','audit'].every(root=>document.querySelector('#'+root).getAttribute('aria-busy')==='false'))}
test('a refreshed viewer role disables all writes, safely updates its role cue and blocks scripted submits',async()=>{
  const {page,errors}=await openPage();
  try{
    const name='<img src=x onerror=alert(1)> · owner';await page.route('**/api/projects',route=>route.fulfill({json:[{id:1,name,role:'owner'}]}));
    const {proof}=await conflictFixture(page);await settled(page,'#loginForm');await page.locator('#proposal [name=value]').fill('降权后保留的草稿');await page.locator('#addSourceShortcut').click();await page.locator('#sourceForm [name=title]').fill('保留的来源草稿');await page.locator('#sourceForm [name=content]').fill('保留的原文');
    await page.route('**/api/projects/1/data?*',route=>route.fulfill({json:{role:'viewer',sourceTextIsUntrusted:true}}));
    await page.route('**/api/projects/1/candidates?*',route=>route.fulfill({json:{role:'viewer',candidates:[{...proof.candidate,source:proof.source.title}],next_before:null}}));
    await page.locator('#refreshWorkspace').focus();await page.keyboard.press('Enter');await settledLists(page);await page.waitForFunction(()=>data?.role==='viewer');
    for(const selector of mutationSelectors)assert.equal(await page.locator(selector).isDisabled(),true,selector);
    assert.match(await page.locator('#projectAccess').textContent(),/只读/);assert.equal(await page.locator('#projectAccess').getAttribute('role'),'status');assert.equal(await page.locator('#project option').textContent(),name+' · 只读 viewer');assert.equal(await page.locator('.intro img').count(),0);
    const writes=[];page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/projects/'))writes.push(request.url())});
    for(const form of ['proposal','sourceForm']){await page.evaluate(form=>document.querySelector('#'+form).requestSubmit(),form);await settled(page,'#'+form)}await page.evaluate(()=>document.querySelector('#stale').onclick());await settled(page,'#stale');
    assert.deepEqual(writes,[]);assert.match(await page.locator('#proposalFeedback').textContent(),/只读/);assert.equal(await page.locator('#proposal [name=value]').inputValue(),'降权后保留的草稿');assert.equal(await page.locator('#sourceForm [name=content]').inputValue(),'保留的原文');assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});
test('a current project read 403 locks retained owner mutations without removing accepted pages or drafts',async()=>{
  const {page,errors}=await openPage();
  try{
    await conflictFixture(page);await settled(page,'#loginForm');await page.locator('#proposal [name=value]').fill('撤权时保留的草稿');const before=await acceptedPage(page,pagedLists[2]),original=await draft(page);
    await page.route('**/api/projects/1/candidates?*',route=>route.fulfill({status:403,json:{error:'合成成员资格已停用'}}));
    await page.locator('#refreshCandidates').focus();await page.keyboard.press('Enter');await page.locator('#candidatesStatus').getByText(/403 合成成员资格已停用/).waitFor();
    for(const selector of mutationSelectors)assert.equal(await page.locator(selector).isDisabled(),true,selector);
    for(const name of ['批准','驳回','用最新版本填写新候选'])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true,name);
    assert.deepEqual(await acceptedPage(page,pagedLists[2]),before);assert.deepEqual(await draft(page),original);assert.equal(await page.locator('#candidates .provenance-detail').isVisible(),true);assert.match(await page.locator('#projectAccess').textContent(),/读取被拒绝/);
    let projects=0;page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/projects/'))projects++});
    await page.locator('#proposal [name=value]').focus();await page.evaluate(()=>[...document.querySelectorAll('#candidates button')].find(button=>button.textContent==='批准').onclick());await page.locator('#candidateFeedback').getByText(/读取被拒绝/).waitFor();
    assert.equal(projects,0);assert.equal(await page.locator('#proposal [name=value]').evaluate(node=>node===document.activeElement),true);assert.deepEqual(await draft(page),original);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

test('a project read denial survives late owner bootstrap and automatic loads until a fresh explicit refresh',async()=>{
  const {page,errors}=await openPage();
  try{
    await conflictFixture(page);await settled(page,'#loginForm');await page.locator('#proposal [name=value]').fill('混合失败保留的草稿');const original=await draft(page);
    const owner=await hold(page,'**/api/projects/1/data?*','GET');await page.route('**/api/projects/1/history?*',route=>route.fulfill({status:403,json:{error:'合成历史权限拒绝'}}));
    await page.locator('#refreshWorkspace').focus();await page.keyboard.press('Enter');await owner.observed;await page.locator('#historyStatus').getByText(/403 合成历史权限拒绝/).waitFor();
    owner.release({sourceTextIsUntrusted:true,role:'owner'});await settledLists(page);await page.waitForFunction(()=>data===null);
    for(const selector of mutationSelectors)assert.equal(await page.locator(selector).isDisabled(),true);assert.equal(await page.locator('#candidates').getByRole('button',{name:'批准',exact:true}).isDisabled(),true);assert.match(await page.locator('#projectAccess').textContent(),/读取被拒绝/);
    await page.unroute('**/api/projects/1/history?*');await page.evaluate(()=>load());assert.equal(await page.evaluate(()=>data.role),'owner');assert.equal(await page.locator('#proposal button').isDisabled(),true,'automatic read completion cannot clear an access denial');
    await page.locator('#refreshWorkspace').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);await settledLists(page);
    assert.equal(await page.locator('#candidates').getByRole('button',{name:'批准',exact:true}).isEnabled(),true);assert.doesNotMatch(await page.locator('#projectAccess').textContent(),/读取被拒绝/);assert.deepEqual(await draft(page),original);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});
test('late owner prepare, page and detail receipts cannot re-enable mutations after a current data 403',async()=>{
  const {page,errors}=await openPage();
  try{
    const {proof,prepare}=await conflictFixture(page);await settled(page,'#loginForm');await page.locator('#proposal [name=value]').fill('迟到回执不能替换的草稿');const original=await draft(page);
    const prepared=await hold(page,'**/api/projects/1/candidates/10/source','GET');await prepare.focus();await page.keyboard.press('Enter');await prepared.observed;
    const candidates=await hold(page,'**/api/projects/1/candidates?*','GET');await page.route('**/api/projects/1/data?*',route=>route.fulfill({status:403,json:{error:'合成当前项目读取拒绝'}}));
    await page.locator('#refreshWorkspace').focus();await page.keyboard.press('Enter');await candidates.observed;await page.locator('#notice').getByText(/403 合成当前项目读取拒绝/).waitFor();
    prepared.release(proof);await page.locator('#candidateFeedback').getByText(/读取被拒绝/).waitFor();assert.equal(await prepare.isDisabled(),true);assert.deepEqual(await draft(page),original);
    candidates.release({role:'owner',candidates:[{...proof.candidate,source:proof.source.title}],next_before:null});await page.locator('#candidates').getByRole('button',{name:'核对来源原文',exact:true}).waitFor();
    await keyboardDetailTrigger(page,'candidates');await page.keyboard.press('Enter');await page.locator('#candidates').getByRole('button',{name:'收起来源原文',exact:true}).waitFor();
    for(const name of ['批准','驳回','用最新版本填写新候选'])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true,name);for(const selector of mutationSelectors)assert.equal(await page.locator(selector).isDisabled(),true);assert.deepEqual(await draft(page),original);assert.deepEqual(errors,[]);
    const notice=await page.locator('#notice').textContent();await page.unroute('**/api/projects/1/data?*');await page.evaluate(()=>load());assert.equal(await page.locator('#notice').textContent(),notice,'an automatic owner read must not clear the unresolved project-access error');
  }finally{await closePage(page)}
});
test('an in-flight approval finally cannot unlock retained actions after a read denial',async()=>{
  const {page,errors}=await openPage();
  try{
    await conflictFixture(page);await settled(page,'#loginForm');const approval=await hold(page,'**/api/projects/1/candidates/10/approve');await page.locator('#candidates').getByRole('button',{name:'批准',exact:true}).focus();await page.keyboard.press('Enter');await approval.observed;
    await page.route('**/api/projects/1/candidates?*',route=>route.fulfill({status:403,json:{error:'合成成员已撤权'}}));await page.locator('#refreshCandidates').focus();await page.keyboard.press('Enter');await page.locator('#candidatesStatus').getByText(/403 合成成员已撤权/).waitFor();
    approval.release({error:'合成写入权限拒绝'},403);await page.locator('#candidateFeedback').getByText(/403 合成写入权限拒绝/).waitFor();
    const button=page.locator('#candidates').getByRole('button',{name:'批准',exact:true});assert.equal(await button.getAttribute('aria-busy'),'false');assert.equal(await button.isDisabled(),true);assert.match(await page.locator('#projectAccess').textContent(),/读取被拒绝/);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});
test('write 403 and transient read 503 do not create a project-access denial',async()=>{
  const {page,errors}=await openPage();
  try{
    await conflictFixture(page);await settled(page,'#loginForm');await page.route('**/api/projects/1/candidates/10/approve',route=>route.fulfill({status:403,json:{error:'合成审批或CSRF拒绝'}}));
    await page.locator('#candidates').getByRole('button',{name:'批准',exact:true}).focus();await page.keyboard.press('Enter');await page.locator('#candidateFeedback').getByText(/403 合成审批或CSRF拒绝/).waitFor();
    assert.equal(await page.locator('#proposal button').isEnabled(),true);assert.equal(await page.locator('#candidates').getByRole('button',{name:'批准',exact:true}).isEnabled(),true);assert.doesNotMatch(await page.locator('#projectAccess').textContent(),/读取被拒绝/);
    await page.route('**/api/projects/1/data?*',route=>route.fulfill({status:503,json:{error:'合成暂时无法读取权限'}}));await page.route('**/api/projects/1/candidates?*',route=>route.fulfill({status:503,json:{error:'合成候选读取失败'}}));
    await page.locator('#refreshWorkspace').focus();await page.keyboard.press('Enter');await page.locator('#notice').getByText(/503 合成暂时无法读取权限/).waitFor();await settledLists(page);
    assert.equal(await page.locator('#proposal button').isDisabled(),true);for(const name of ['批准','用最新版本填写新候选'])assert.equal(await page.getByRole('button',{name,exact:true}).isEnabled(),true);assert.doesNotMatch(await page.locator('#projectAccess').textContent(),/读取被拒绝/);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});
for(const kind of ['data','detail'])test(`a stale ${kind} 403 cannot deny a newer A to B to A workspace`,async()=>{
  const {page,errors}=await openPage();let release;
  try{
    if(kind==='data')await conflictFixture(page);else await provenanceFixture(page);await settled(page,'#loginForm');
    const pattern=kind==='data'?'**/api/projects/1/data?*':'**/api/projects/1/facts/41/provenance?version=2',seen=(()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}})(),gate=new Promise(resolve=>{release=resolve});pageCleanups.get(page).add(release);
    await page.route(pattern,async route=>{seen.resolve();await gate;await route.fulfill({status:403,json:{error:'旧工作区合成拒绝'}})},{times:1});
    if(kind==='data'){await page.locator('#refreshWorkspace').focus();await page.keyboard.press('Enter')}else{await keyboardDetailTrigger(page,'facts');await page.keyboard.press('Enter')}await bounded(seen.promise,'waiting for old access read');
    await page.locator('#project').focus();for(const key of ['ArrowDown','ArrowUp']){await page.keyboard.press(key);await settledLists(page);await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled)}
    const response=page.waitForResponse(r=>new URL(r.url()).pathname===(kind==='data'?'/api/projects/1/data':'/api/projects/1/facts/41/provenance')&&r.status()===403);release();await (await response).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#project').inputValue(),'1');assert.equal(await page.locator('#proposal button').isEnabled(),true);assert.doesNotMatch(await page.locator('#projectAccess').textContent(),/读取被拒绝/);assert.equal(await page.locator('#project').evaluate(node=>node===document.activeElement),true);assert.deepEqual(errors,[]);
  }finally{release?.();await closePage(page)}
});

for(const form of ['sourceForm','proposal'])test(`${form} rejects wrong complete JSON creation receipts before clearing its key or changing drafts`,async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);
    if(form==='sourceForm'){await page.locator('#addSourceShortcut').click();await page.locator('#sourceForm [name=title]').fill(' 原始标题😀 ');await page.locator('#sourceForm [name=content]').fill(' 原始全文😀\n ')}
    else for(const name of ['subject','predicate','value'])await page.locator(`#proposal [name=${name}]`).fill(' 原始'+name+'😀 ');
    const initial=await page.locator('#'+form).evaluate(node=>Object.fromEntries(new FormData(node))),feedback=form==='sourceForm'?'#sourceFeedback':'#proposalFeedback',endpoint=form==='sourceForm'?'sources':'candidates',keys=[];
    const changes=[wire=>({...wire,project_id:2}),wire=>({...wire,id:0}),wire=>({...wire,id:'91'}),()=>({}),()=>null,()=>[],wire=>{const copy={...wire};delete copy.project_id;return copy},wire=>({...wire,[form==='sourceForm'?'title':'value']:'synthetic-private-receipt'})];
    if(form==='sourceForm')changes.push(wire=>({...wire,content:'different full text'}));else changes.push(wire=>({...wire,source_id:2}),wire=>({...wire,expected_version:99}),wire=>({...wire,source_id:String(wire.source_id)}),wire=>({...wire,status:'approved'}));
    for(const change of changes){
      const pending=await hold(page,`**/api/projects/1/${endpoint}`);await page.locator('#'+form+' button').focus();await page.keyboard.press('Enter');await pending.observed;keys.push(pending.requests[0].headers()['idempotency-key']);pending.release(change(healthyCreationReceipt(pending.requests[0],91)));await settled(page,'#'+form);
      assert.match(await page.locator(feedback).textContent(),/创建回执格式异常.*写入结果可能不确定/);assert.ok(!(await page.locator(feedback).textContent()).includes('synthetic-private'));assert.deepEqual(await page.locator('#'+form).evaluate(node=>Object.fromEntries(new FormData(node))),initial);assert.equal(await page.locator('#sourceSelect').inputValue(),'1');
    }
    const valid=await hold(page,`**/api/projects/1/${endpoint}`);await page.locator('#'+form+' button').focus();await page.keyboard.press('Enter');await valid.observed;keys.push(valid.requests[0].headers()['idempotency-key']);valid.release({...healthyCreationReceipt(valid.requests[0],91),unusedMetadata:'synthetic-unused'});await settled(page,'#'+form);
    assert.equal(new Set(keys).size,1);assert.match(await page.locator(feedback).textContent(),form==='sourceForm'?/来源 #91 已保存/:/候选已提交/);assert.equal(await page.evaluate(()=>pendingCreations.size),0);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});
for(const form of ['sourceForm','proposal'])for(const first of ['lost','503'])test(`${form} ${first} then write403 keeps one key through permission reactivation and verified success`,async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);if(form==='sourceForm'){await page.locator('#addSourceShortcut').click();await page.locator('#sourceForm [name=title]').fill('同一来源意图');await page.locator('#sourceForm [name=content]').fill('不能丢失的全文')}
    const endpoint=form==='sourceForm'?'sources':'candidates',feedback=form==='sourceForm'?'#sourceFeedback':'#proposalFeedback',keys=[];let attempts=0;
    await page.route(`**/api/projects/1/${endpoint}`,async route=>{if(route.request().method()!=='POST')return route.fallback();attempts++;keys.push(route.request().headers()['idempotency-key']);if(attempts===1&&first==='lost')return route.abort();return route.fulfill({status:attempts===1?503:403,json:{error:'合成写入响应不确定或当前拒绝'}})});
    const original=await page.locator('#'+form).evaluate(node=>Object.fromEntries(new FormData(node)));
    for(let i=0;i<2;i++){await page.locator('#'+form+' button').focus();await page.keyboard.press('Enter');await settled(page,'#'+form);assert.match(await page.locator(feedback).textContent(),/写入结果可能不确定/);assert.deepEqual(await page.locator('#'+form).evaluate(node=>Object.fromEntries(new FormData(node))),original)}
    await page.route('**/api/projects/1/audit?*',route=>route.fulfill({status:403,json:{error:'合成项目读取拒绝'}}));await page.locator('#refreshAudit').focus();await page.keyboard.press('Enter');await page.locator('#projectAccess').getByText(/读取被拒绝/).waitFor();assert.equal(await page.locator('#'+form+' button').isDisabled(),true);
    await page.unroute('**/api/projects/1/audit?*');await page.locator('#refreshWorkspace').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#proposal button').disabled);await settledLists(page);
    const pending=await hold(page,`**/api/projects/1/${endpoint}`);await page.locator('#'+form+' button').focus();await page.keyboard.press('Enter');await pending.observed;keys.push(pending.requests[0].headers()['idempotency-key']);pending.release(healthyCreationReceipt(pending.requests[0],92));await settled(page,'#'+form);
    assert.equal(keys.length,3,'only manual submissions send writes');assert.equal(new Set(keys).size,1);assert.match(await page.locator(feedback).textContent(),form==='sourceForm'?/来源 #92 已保存/:/候选已提交/);assert.equal(await page.evaluate(()=>pendingCreations.size),0);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

for(const scenario of ['stale','injection'])test(`${scenario} simulated client rejects a mismatched candidate receipt and manually retries the same intent`,async()=>{
  const {page,errors}=await openPage();
  try{
    await login(page);const keys=[],draftBefore=await draft(page);let writes=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/projects/'))writes++});
    for(const valid of [false,true]){
      const pending=await hold(page,'**/api/projects/1/candidates');await page.locator('#'+scenario).focus();await page.keyboard.press('Enter');await pending.observed;keys.push(pending.requests[0].headers()['idempotency-key']);const wire=healthyCreationReceipt(pending.requests[0],93);pending.release(valid?wire:{...wire,status:'approved'});await settled(page,'#'+scenario);
      assert.match(await page.locator('#notice').textContent(),valid?/模拟客户端已提交候选，尚未改变当前事实/:/创建回执格式异常.*写入结果可能不确定/);assert.deepEqual(await draft(page),draftBefore);
    }
    assert.equal(writes,2,'manual proposals never issue approval requests');assert.equal(new Set(keys).size,1);assert.equal(await page.evaluate(()=>pendingCreations.size),0);assert.deepEqual(errors,[]);
  }finally{await closePage(page)}
});

for(const [action,label,invalid,valid] of [['approve','批准',{status:'approved',version:99},{status:'approved',version:1}],['reject','驳回',{status:'approved'},{status:'rejected'}]])test(`${action} requires a matching receipt before announcing success, preserving the accepted page and edited draft through a failed refresh`,async()=>{
  const {page,errors}=await openPage();const requests=[];
  try{
    page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))requests.push({method:request.method(),path:new URL(request.url()).pathname})});
    const {proof}=await conflictFixture(page);await settled(page,'#loginForm');await settledLists(page);
    assert.equal(proof.candidate.expected_version,0,'positive approval receipt is expected_version + 1');
    const accepted=await page.locator('#candidates').textContent(),trigger=await page.locator('#candidates').getByRole('button',{name:label,exact:true}).elementHandle(),pending=await hold(page,`**/api/projects/1/candidates/10/${action}`),start=requests.length;
    await page.locator('#candidates').getByRole('button',{name:label,exact:true}).focus();await page.keyboard.press('Enter');await pending.observed;
    const input=page.locator('#proposal [name=value]');await input.focus();await page.keyboard.press('Control+a');await page.keyboard.type('审批期间继续编辑的草稿');await page.keyboard.press('ArrowLeft');const original=await draft(page),caret=await input.evaluate(node=>[node.selectionStart,node.selectionEnd]);
    pending.release(invalid);await page.waitForFunction(button=>button.getAttribute('aria-busy')==='false',trigger);
    assert.match(await page.locator('#candidateFeedback').textContent(),/回执.*未确认.*刷新核对/);assert.doesNotMatch(await page.locator('#candidateFeedback').textContent(),/成功|v99|undefined/);assert.equal(await page.locator('#candidateFeedback').getAttribute('role'),'status');
    assert.equal(await page.locator('#candidates').textContent(),accepted);assert.deepEqual(await draft(page),original);assert.equal(await input.evaluate(node=>node===document.activeElement),true);assert.deepEqual(await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),caret);assert.deepEqual(requests.slice(start),[{method:'POST',path:`/api/projects/1/candidates/10/${action}`}],'a bad receipt triggers neither automatic retry nor automatic reload');
    const unavailable=route=>route.request().method()==='GET'?route.fulfill({status:503,json:{error:'合成后续刷新暂不可用'}}):route.fallback();await page.route('**/api/projects/1/**',unavailable);
    await page.locator('#refreshWorkspace').focus();await page.keyboard.press('Enter');await page.locator('#notice').getByText(/工作台加载失败：503 合成后续刷新暂不可用/).waitFor();await settledLists(page);
    assert.match(await page.locator('#candidateFeedback').textContent(),/未确认/);assert.equal(await page.locator('#candidates').textContent(),accepted);assert.deepEqual(await draft(page),original);assert.deepEqual(await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),caret);assert.equal(requests.slice(start).filter(request=>request.method==='POST').length,1);
    await page.unroute('**/api/projects/1/**',unavailable);await page.locator('#refreshWorkspace').focus();await page.keyboard.press('Enter');await settledLists(page);await page.waitForFunction(()=>data?.role==='owner');assert.match(await page.locator('#candidates').textContent(),/待审批/);assert.deepEqual(await draft(page),original);
    const confirmed=await hold(page,`**/api/projects/1/candidates/10/${action}`);await page.locator('#candidates').getByRole('button',{name:label,exact:true}).focus();await page.keyboard.press('Enter');await confirmed.observed;confirmed.release(valid);
    await page.locator('#candidateFeedback').getByText(action==='approve'?/批准成功：本次生成 v1/:/驳回成功：候选保留为已驳回/).waitFor();await settledLists(page);
    assert.deepEqual(await draft(page),original);assert.equal(requests.slice(start).filter(request=>request.method==='POST').length,2,'only the two deliberate keyboard actions send decisions');assert.deepEqual(errors,[]);
    console.log('Synthetic decision receipt browser:',JSON.stringify({action,apiRequests:requests.length,decisionPosts:2,databaseQueries:0,modelCalls:0,realCommitNotClaimed:true}));
  }finally{await closePage(page)}
});
