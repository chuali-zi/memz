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
async function hold(page,pattern){
  let seen,finish;
  const observed=new Promise(resolve=>{seen=resolve}),completion=new Promise(resolve=>{finish=resolve}),requests=[];
  await page.route(pattern,async route=>{
    if(route.request().method()!=='POST'){await route.fallback();return}
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
