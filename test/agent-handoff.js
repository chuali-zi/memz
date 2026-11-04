// Browser-driven operator approval, separate CLI workers, synthetic records only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process'),{randomUUID}=require('node:crypto'),http=require('node:http');
module.exports=async({page,baseURL,capture,dir})=>{
  const subject='外部进程交接-'+randomUUID(),source={projectId:1,title:'进程交接依据（合成）',content:'本次交接项目截止日为18号。',idempotencyKey:randomUUID()};
  let interruptedId,interrupted=false,abandonedAuth;
  async function worker(script,input,{username=script==='context-client'?'viewer':'member',interrupt=false}={}){
    let proxy,child;let target=baseURL;
    if(interrupt){
      proxy=http.createServer(async(req,res)=>{
        try{
          const chunks=[];for await(const chunk of req)chunks.push(chunk);
          const response=await fetch(new URL(req.url,baseURL),{method:req.method,headers:{'content-type':'application/json',...(req.headers.cookie?{cookie:req.headers.cookie}:{}),...(req.headers['x-csrf-token']?{'x-csrf-token':req.headers['x-csrf-token']}:{}),...(req.headers['idempotency-key']?{'idempotency-key':req.headers['idempotency-key']}:{})},body:Buffer.concat(chunks),signal:AbortSignal.timeout(5000)});
          const bytes=Buffer.from(await response.arrayBuffer());
          if(req.url==='/api/login'&&response.status===200)abandonedAuth={cookie:response.headers.get('set-cookie').split(';')[0],csrf:JSON.parse(bytes).csrf};
          if(req.url==='/api/projects/1/candidates'&&response.status===200){interruptedId=JSON.parse(bytes).id;interrupted=child.kill('SIGKILL');res.destroy();return}
          res.writeHead(response.status,{'content-type':'application/json',...(response.headers.get('set-cookie')?{'set-cookie':response.headers.get('set-cookie')}:{})});res.end(bytes);
        }catch{res.destroy()}
      });
      await new Promise(r=>proxy.listen(0,'127.0.0.1',r));target=`http://127.0.0.1:${proxy.address().port}`;
    }
    try{
      return await new Promise((resolve,reject)=>{
        child=spawn(process.execPath,[`scripts/${script}.js`,'--stdin'],{env:{...process.env,MEMZ_BASE_URL:target,MEMZ_USERNAME:username,MEMZ_PASSWORD:`demo-${username}`},stdio:['pipe','pipe','pipe']});
        let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('handoff worker timeout'))},25000);
        child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.stdin.on('error',()=>{});child.on('error',reject);
        child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr})});child.stdin.end(JSON.stringify(input));
      });
    }finally{if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r))}}
  }
  const sourcePath=path.join(dir,'agent-source-intent.json'),proposalPath=path.join(dir,'agent-proposal-intent.json');
  fs.writeFileSync(sourcePath,JSON.stringify(source,null,2)+'\n');
  const sourceRun=await worker('source-client',JSON.parse(fs.readFileSync(sourcePath)));assert.equal(sourceRun.code,0,sourceRun.stderr);const sourceId=JSON.parse(sourceRun.stdout).sourceId;
  const proposal={projectId:1,sourceId,subject,predicate:'截止日',value:'18号',expectedVersion:0,idempotencyKey:randomUUID()};fs.writeFileSync(proposalPath,JSON.stringify(proposal,null,2)+'\n');
  try{
    const stopped=await worker('proposal-client',JSON.parse(fs.readFileSync(proposalPath)),{interrupt:true});assert.equal(stopped.signal,'SIGKILL');assert.equal(stopped.stdout,'');assert.equal(interrupted,true);assert.ok(interruptedId);
  }finally{
    // SIGKILL prevents client logout; explicitly release only this synthetic test session.
    if(abandonedAuth){const response=await fetch(baseURL+'/api/logout',{method:'POST',headers:{cookie:abandonedAuth.cookie,'x-csrf-token':abandonedAuth.csrf}});assert.equal(response.status,200);await response.json();abandonedAuth=null}
  }
  const resumed=await worker('proposal-client',JSON.parse(fs.readFileSync(proposalPath)));assert.equal(resumed.code,0,resumed.stderr);const candidateId=JSON.parse(resumed.stdout).candidateId;assert.equal(candidateId,interruptedId);
  const denied=await worker('proposal-client',{...proposal,idempotencyKey:randomUUID()},{username:'viewer'});assert.equal(denied.code,1);assert.equal(JSON.parse(denied.stderr).status,403);assert.equal(denied.stdout,'');
  const query={projectId:1,query:subject,maxOutputBytes:4096};
  const before=await worker('context-client',query);assert.equal(before.code,0,before.stderr);assert.equal(JSON.parse(before.stdout).facts.length,0);
  await page.locator('#searchForm [name=q]').fill(subject);await page.getByRole('button',{name:'搜索',exact:true}).click();await page.getByText('没有匹配的当前事实',{exact:true}).waitFor();await page.locator('#refreshWorkspace').click();
  const entry=page.locator('#candidates .entry').filter({hasText:`${subject} / 截止日 → 18号`});await entry.getByText('待审批',{exact:true}).waitFor();
  await capture('25-agent-pending-handoff.png','独立候选进程提交后被SIGKILL，新进程以原键恢复；候选仍待人工审批',`#candidates .entry:has-text("${subject}")`);
  await entry.getByRole('button',{name:'批准',exact:true}).click();await page.locator('#candidateFeedback').getByText(/批准成功/).waitFor();
  await page.locator('#facts').getByRole('button',{name:'查看依据',exact:true}).click();await page.locator('#facts').getByText(source.content,{exact:true}).waitFor();
  const after=await worker('context-client',query);assert.equal(after.code,0,after.stderr);const context=JSON.parse(after.stdout);assert.equal(context.facts.length,1);assert.equal(context.facts[0].value,'18号');assert.equal(context.facts[0].version,1);assert.equal(context.facts[0].source.id,sourceId);assert.equal(context.facts[0].source.content,source.content);assert.equal(context.facts[0].candidateId,candidateId);
  const foreign=await worker('context-client',query,{username:'other'});assert.equal(foreign.code,1);assert.match(foreign.stderr,/HTTP_403/);assert.equal(foreign.stdout,'');
  const persisted=await page.evaluate(async id=>{const data=await api('/api/projects/1/data');return {candidates:data.candidates.filter(c=>c.id===id),audit:data.audit.filter(a=>a.action==='propose'&&a.detail===`候选 ${id}`)}},candidateId);assert.equal(persisted.candidates.length,1);assert.equal(persisted.audit.length,1);assert.equal(persisted.candidates[0].status,'approved');
  await capture('26-agent-approved-context.png','浏览器操作批准后，另一个独立只读进程取得18号v1及同一来源原文；无模型调用','.card:has(#facts)');
  return {synthetic:true,workerInterruptedAfterCommit:true,restartedWithSavedIntent:true,candidateId,sourceId,pendingContextEmpty:true,approvalThroughBrowser:true,singleProposalAudit:true,viewerWrite403:true,otherRead403:true,intents:{source,proposal},context};
};
