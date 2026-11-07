// Real Chromium checks of client interaction with explicitly synthetic, controlled HTTP responses.
// No database, external service, model, or existing demo data is used.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
let server,browser,baseURL;
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
  browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve))});
async function openPage(){
  const page=await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN'}),errors=[];
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),resource=url.pathname.split('/').at(-1);
    let body;
    if(url.pathname==='/api/login')body={csrf:'synthetic-csrf',name:'Synthetic owner'};
    else if(url.pathname==='/api/projects')body=[{id:1,name:'合成项目一',role:'owner'},{id:2,name:'合成项目二',role:'owner'}];
    else if(resource==='data')body={role:'owner'};
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
  await page.route(pattern,async route=>{
    if(route.request().method()!==method){await route.fallback();return}
    requests.push(route.request());seen();
    const {status,body}=await completion;
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return {observed,requests,release:(body,status=200)=>finish({body,status})};
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
});

async function conflictFixture(page){
  const source={id:1,title:'合成依据',content:'仅用于交互测试。'},alternative={id:2,title:'另一合成依据',content:'另一份人工草稿依据。'};
  const candidate={id:10,subject:'合成冲突',predicate:'截止日',value:'原候选值',status:'pending',expected_version:0,source_id:1,source:source.title};
  const proof={candidate,source,role:'owner',comparison:{matches:false,expectedVersion:0,currentVersion:2},current:{value:'当前批准值',version:2,source_id:2,candidate_id:11,source_title:alternative.title}};
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
  }finally{await page.close()}
});

test('unchanged conflict recovery still fills the latest version without submitting',async()=>{
  const {page,errors}=await openPage();
  try{
    const {prepare}=await conflictFixture(page),writes=[];
    page.on('request',request=>{if(request.method()==='POST')writes.push(request.url())});
    await prepare.click();await page.locator('#proposalFeedback').getByText(/已用读取时 v2.*尚未提交/).waitFor();
    assert.equal((await draft(page)).value,'原候选值');assert.equal((await draft(page)).expected_version,'2');assert.equal((await draft(page)).source_id,'1');
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
    }finally{await page.close()}
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
  }finally{await page.close()}
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
  }finally{await page.close()}
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
    }finally{await page.close()}
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
    }finally{await page.close()}
  });
});
