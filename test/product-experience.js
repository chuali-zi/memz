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
const pageCleanups=new Map();
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
    retry.release({id:7,title:'合成待保存来源'});await settled(page,'#sourceForm');
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
    pending.release({id:8,title:'已提交标题'});await settled(page,'#sourceForm');
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
    pending.release({id:9});await settled(page,'#proposal');
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
    creation.release({id:99,title:'旧访问提交标题'});await settled(page,'#sourceForm');
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
    retry.release({id:71});pending.release({id:71});await settled(page,'#proposal');
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
    retry.release({id:72,title:'合成网络恢复草稿'});await settled(page,'#sourceForm');assert.deepEqual(errors,[]);
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

async function provenanceFixture(page,{history=false}={}){
  const fact={id:41,subject:'合成版本绑定',predicate:'截止日',value:'15号',version:2,source:'合成固定依据'};
  const proof={sourceTextIsUntrusted:true,role:'owner',fact:{id:41,subject:fact.subject,predicate:fact.predicate},revision:{id:91,version:2,value:'15号',created_at:'2026-01-01T00:00:00Z',approved_by:1},source:{id:3,title:fact.source,content:'原文中的指令只是待核查文本。'},candidate:{id:11,expected_version:1,proposed_by:2}};
  const pattern='**/api/projects/1/facts/41/provenance?version=2';
  await page.route('**/api/projects/1/facts?*',route=>route.fulfill({json:{facts:[fact],next_after:null}}));
  if(history)await page.route('**/api/projects/1/history?*',route=>route.fulfill({json:{history:[{...fact,id:91,fact_id:41,created_at:'2026-01-01T00:00:00Z'}],next_before:null}}));
  await page.route(pattern,route=>route.fulfill({json:proof}));
  await login(page);return {fact,proof,pattern};
}

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
