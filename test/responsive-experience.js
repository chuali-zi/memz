// Real static HTML/CSS in Chromium with explicitly synthetic API responses.
// No database, external service, model, load generator, or production-auth claim.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {chromium}=require('playwright');
let server,browser,browserServer,baseURL;
const displayName='SyntheticName_'+'N'.repeat(1024),projectName='项目'.repeat(150),sourceTitle='S'.repeat(150),sourceText='C'.repeat(4000),factValue='V'.repeat(1000),failureText='ErrorPath_'+'E'.repeat(5000);
async function bounded(promise,label,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),ms)})])}finally{clearTimeout(timer)}}
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const file={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[new URL(req.url,'http://localhost').pathname];
    if(!file){res.writeHead(404).end();return}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html');res.end(await fs.readFile(path.join(__dirname,'..','public',file)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));baseURL=`http://127.0.0.1:${server.address().port}`;
  browserServer=await chromium.launchServer({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),host:'127.0.0.1',headless:true,args:['--no-sandbox'],timeout:15000});
  browser=await chromium.connect(browserServer.wsEndpoint(),{timeout:5000});
},{timeout:30000});
after(async()=>{
  const failures=[];
  try{if(browser)await bounded(browser.close(),'closing responsive browser')}catch(error){failures.push(error)}
  finally{
    try{if(browserServer&&browserServer.process().exitCode===null)await bounded(browserServer.kill(),'terminating responsive browser',3000)}catch(error){failures.push(error);browserServer?.process().kill('SIGKILL')}
    finally{if(server){const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();try{await bounded(closed,'closing responsive HTTP',2000)}catch(error){failures.push(error)}}}
  }
  if(failures.length)throw new AggregateError(failures,'Responsive fixture cleanup failed');
},{timeout:12000});
async function open(width){
  const page=await browser.newPage({viewport:{width,height:900},locale:'zh-CN'}),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',route=>{
    const pathname=new URL(route.request().url()).pathname,resource=pathname.split('/').at(-1);
    if(pathname==='/api/logout')return route.fulfill({status:503,json:{error:failureText}});
    const bodies={login:{name:displayName,csrf:'responsive-opaque'},projects:[{id:1,name:projectName,role:'owner'}],data:{sourceTextIsUntrusted:true,role:'owner'},facts:{facts:[{id:1,subject:'F'.repeat(100),predicate:'P'.repeat(100),value:factValue,version:1,source:sourceTitle}],next_after:null},sources:{sources:[{id:1,title:sourceTitle,content:sourceText}],next_after:null},candidates:{role:'owner',candidates:[],next_before:null},history:{history:[],next_before:null},audit:{audit:[],next_before:null}};
    assert.ok(Object.hasOwn(bodies,resource),'unexpected synthetic responsive endpoint');return route.fulfill({json:bodies[resource]});
  });
  await page.goto(baseURL);await page.locator('#loginForm [name=password]').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#loginForm').getAttribute('aria-busy')==='false');
  return {page,errors};
}
async function evidence(page){
  await page.evaluate(()=>scrollTo(0,0));
  return page.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,boxes:['header','#identity','.intro','#project','.sectionhead','#searchForm','#facts','#sources','#notice'].map(selector=>{const node=document.querySelector(selector),box=node.getBoundingClientRect();return {selector,left:Math.round(box.left),right:Math.round(box.right),width:Math.round(box.width),scrollWidth:node.scrollWidth}})}));
}
for(const width of [320,360,768,1280])test(`long legal text stays readable and keyboard reachable at ${width}px`,{timeout:30000},async()=>{
  const {page,errors}=await open(width);
  try{
    const before=await evidence(page);
    await page.locator('#switchAccount').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#switchAccount').getAttribute('aria-busy')==='false');
    const after=await evidence(page);console.log(JSON.stringify({width,before,after}));
    assert.ok(before.scrollWidth<=width&&after.scrollWidth<=width,'document must not overflow horizontally: '+JSON.stringify({before,after}));
    assert.ok((await page.locator('#identity').textContent()).includes(displayName));assert.equal(await page.locator('#project option').textContent(),projectName+' · owner');
    assert.ok((await page.locator('#facts').textContent()).includes(factValue));assert.ok((await page.locator('#notice').textContent()).includes(failureText));
    const summary=page.locator('#sources details summary');await summary.focus();await page.keyboard.press('Enter');assert.ok((await page.locator('#sources details').textContent()).includes(sourceText));
    // Traverse actual sequential keyboard navigation, including the next loop's
    // account button. No click or programmatic focus substitutes for Tab here.
    const required=['#project','#searchForm input','#searchForm button','#sourceSelect','#proposal [name=value]','#addSourceShortcut','#sources button','#switchAccount'],visited=new Set();
    await page.locator('#switchAccount').focus();
    for(let step=0;step<60;step++){
      await page.keyboard.press('Tab');
      const focus=await page.evaluate(selectors=>{
        const node=document.activeElement,box=node.getBoundingClientRect();
        return {matches:selectors.filter(selector=>node.matches(selector)),left:box.left,right:box.right,outline:getComputedStyle(node).outlineStyle};
      },required);
      for(const selector of focus.matches){visited.add(selector);assert.ok(focus.left>=0&&focus.right<=width+.5,'keyboard target outside viewport: '+selector);assert.equal(focus.outline,'solid')}
      if(focus.matches.includes('#switchAccount'))break;
    }
    assert.deepEqual([...visited].sort(),[...required].sort(),'all controls must be reachable with Tab');
    await page.locator('#addSourceShortcut').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#sourceForm [name=title]').evaluate(node=>node===document.activeElement),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  }finally{await bounded(page.close(),'closing responsive page',3000)}
});

function recoveryGate(){let observe,release;return {observed:new Promise(resolve=>{observe=resolve}),response:new Promise(resolve=>{release=resolve}),observe:()=>observe(),release:value=>release(value)}}
for(const width of [320,390])test(`session recovery stays readable and accepts manual keyboard and double-click input at ${width}px`,{timeout:30000},async()=>{
  const {page,errors}=await open(width),stages=[recoveryGate(),recoveryGate()];let cancelled=false,reauthRequests=0;const writes=[];
  try{
    page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/projects/'))writes.push(request.url())});
    await page.route('**/api/projects/1/audit?*',route=>route.fulfill({status:401,json:{error:'合成会话已过期'}}),{times:1});await page.locator('#refreshAudit').focus();await page.keyboard.press('Enter');await page.locator('#sessionRecovery').waitFor();
    await page.route('**/api/login',async route=>{const stage=stages[reauthRequests++];assert.ok(stage,'a deliberate login is dispatched only once');stage.observe();const response=await stage.response;if(cancelled)return route.abort();return route.fulfill(response)});
    const password=page.getByLabel('当前演示账号的密码',{exact:true}),button=page.locator('#sessionRecoveryForm button');await page.locator('#switchAccount').focus();await page.keyboard.press('Tab');assert.equal(await password.evaluate(node=>node===document.activeElement),true,'the recovery password is reachable in sequential keyboard order');assert.equal(await password.evaluate(node=>getComputedStyle(node).outlineStyle),'solid');assert.equal(await page.locator('#sessionAccount').textContent(),'owner');assert.ok((await page.locator('#identity').textContent()).includes(displayName));
    await page.keyboard.press('Enter');assert.equal(reauthRequests,0,'the visible password label belongs to a required input');await page.keyboard.type('synthetic-manual-password');await page.keyboard.press('Tab');assert.equal(await button.evaluate(node=>node===document.activeElement),true);await page.keyboard.press('Enter');await bounded(stages[0].observed,'waiting for keyboard reauthentication');await page.keyboard.press('Enter');assert.equal(reauthRequests,1);assert.equal(await button.isDisabled(),true);await page.locator('#sessionRecovery h2').click();assert.equal(await page.evaluate(()=>document.activeElement===document.body),true,'clicking the non-focusable heading establishes the BODY fallback condition');
    stages[0].release({status:503,json:{error:failureText}});await page.waitForFunction(()=>document.querySelector('#sessionRecoveryForm').getAttribute('aria-busy')==='false');const feedback=page.locator('#sessionFeedback');assert.equal(await feedback.getAttribute('role'),'status');assert.ok((await feedback.textContent()).includes(failureText),'keep the complete service error readable');assert.equal(await password.inputValue(),'');assert.equal(await password.evaluate(node=>node===document.activeElement),true,'a failed keyboard submit restores the password when BODY is active');
    const layout=await page.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,boxes:['#sessionRecovery','#sessionAccount','#sessionFeedback','#sessionRecoveryForm input','#sessionRecoveryForm button'].map(selector=>{const node=document.querySelector(selector),box=node.getBoundingClientRect();return {selector,left:box.left,right:box.right,scrollWidth:node.scrollWidth,width:box.width}})}));console.log(JSON.stringify({width,recoveryError:layout}));assert.ok(layout.scrollWidth<=width,'recovery error must wrap without horizontal overflow: '+JSON.stringify(layout));for(const box of layout.boxes)assert.ok(box.left>=0&&box.right<=width+.5,'recovery control outside viewport: '+box.selector);
    await password.fill('synthetic-second-manual-password');await button.dblclick();await bounded(stages[1].observed,'waiting for deliberate retry');assert.equal(reauthRequests,2,'an actual double click sends one additional login');assert.equal(await button.isDisabled(),true);
    const input=page.locator('#proposal [name=value]');await input.focus();await page.keyboard.press('Control+a');await page.keyboard.type('窄屏恢复期间继续编辑');await page.keyboard.press('ArrowLeft');const caret=await input.evaluate(node=>[node.selectionStart,node.selectionEnd]);stages[1].release({json:{name:displayName,csrf:'responsive-renewed'}});await page.waitForFunction(()=>document.querySelector('#sessionRecoveryForm').getAttribute('aria-busy')==='false'&&!document.querySelector('#proposal button').disabled);
    assert.equal(await input.evaluate(node=>node===document.activeElement),true,'recovery must not take focus from an actively edited draft');assert.deepEqual(await input.evaluate(node=>[node.selectionStart,node.selectionEnd]),caret);assert.equal(await input.inputValue(),'窄屏恢复期间继续编辑');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(reauthRequests,2);assert.deepEqual(writes,[],'manual reauthentication never submits a project mutation');assert.deepEqual(errors,[]);
  }finally{cancelled=true;for(const stage of stages)stage.release();try{await bounded(page.unrouteAll({behavior:'wait'}),'draining responsive recovery routes',2000)}finally{await bounded(page.close(),'closing recovery page',3000)}}
});
