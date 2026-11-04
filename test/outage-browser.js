const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
module.exports=async function({base,stop,start,count}){
  const dir='artifacts/outage-browser';fs.mkdirSync(dir,{recursive:true});
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN'});page.setDefaultTimeout(10000);
    await page.goto(base);await page.locator('#loginForm button').click();await page.locator('#sourceForm button').waitFor({state:'attached'});
    await page.waitForFunction(()=>!document.querySelector('#sourceForm button').disabled);
    await page.getByText('添加来源',{exact:true}).click();
    const title='浏览器停机恢复来源',content='合成正文：恢复前不得丢失。';
    await page.locator('#sourceForm [name=title]').fill(title);await page.locator('#sourceForm [name=content]').fill(content);
    await stop();
    await page.locator('#refreshSources').click();await page.locator('#sourcesStatus').filter({hasText:'503'}).waitFor();
    assert.match(await page.locator('#sourcesStatus').textContent(),/请刷新来源重试/);
    await page.locator('#sourcesTitle').scrollIntoViewIfNeeded();await page.screenshot({path:dir+'/01-read-unavailable.png'});
    await page.locator('#sourceForm button').click();await page.locator('#sourceFeedback').filter({hasText:'503'}).waitFor();
    await page.screenshot({path:dir+'/02-write-uncertain.png'});
    assert.equal(await page.locator('#sourceForm [name=title]').inputValue(),title);assert.equal(await page.locator('#sourceForm [name=content]').inputValue(),content);
    assert.match(await page.locator('#sourceFeedback').textContent(),/保持本页/,'UI must explain how to preserve its retry key without technical knowledge');
    await start();await page.locator('#sourceForm button').click();await page.locator('#sourceFeedback').filter({hasText:'已保存'}).waitFor();assert.equal(await count(title),1);
    await page.waitForFunction(()=>!document.querySelector('#sourceForm button').disabled);
    const lostTitle='浏览器提交后响应丢失';await page.locator('#sourceForm [name=title]').fill(lostTitle);await page.locator('#sourceForm [name=content]').fill(content);
    let lost=false;const keys=[];
    await page.route('**/api/projects/1/sources',async route=>{
      if(route.request().method()!=='POST')return route.continue();
      keys.push(route.request().headers()['idempotency-key']);
      if(!lost){lost=true;const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed')}
      return route.continue();
    });
    await page.locator('#sourceForm button').click();await page.locator('#sourceFeedback').filter({hasText:'结果可能不确定'}).waitFor();
    assert.equal(await count(lostTitle),1);assert.equal(keys.length,1,'no automatic replay');
    await page.screenshot({path:dir+'/03-response-lost.png'});
    assert.equal(await page.locator('#sourceForm [name=title]').inputValue(),lostTitle);
    await page.locator('#sourceForm button').click();await page.locator('#sourceFeedback').filter({hasText:'已保存'}).waitFor();
    assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(await count(lostTitle),1);
    await page.locator('#sourceFeedback').scrollIntoViewIfNeeded();await page.screenshot({path:dir+'/04-retry-saved.png'});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    return {passed:true,synthetic:true,screenshots:4,inputPreserved:true,sameKeyReplay:true,noDuplicate:true};
  }finally{await browser.close()}
};
