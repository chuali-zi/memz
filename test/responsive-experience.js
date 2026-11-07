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
