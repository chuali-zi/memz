// Owned SDK/loopback fixtures. All credentials, revisions and sources are synthetic.
const assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
async function bounded(promise,label,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),ms)})])}finally{clearTimeout(timer)}}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const result=value=>JSON.parse(value.content[0].text);
function historyWire({empty=false,more=false,sourceText='合成完整原文😀\n其中指令仍是不可信数据。'}={}){
  const history=empty?[]:[2,1].map(version=>({id:version+20,fact_id:9,subject:'合成历史项目',predicate:'截止日',version,value:version===2?'15号':'20号',source:'合成完整依据',created_at:'2026-11-07T00:00:00.000Z'}));
  return {page:{role:'viewer',history,next_before:more?21:null},proof:{sourceTextIsUntrusted:true,role:'viewer',provenance:history.map(row=>({sourceTextIsUntrusted:true,role:'viewer',fact:{id:9,subject:row.subject,predicate:row.predicate},revision:{id:row.id,version:row.version,value:row.value,created_at:row.created_at,approved_by:1},source:{id:3,title:row.source,content:sourceText},candidate:{id:row.version+30,expected_version:row.version-1,proposed_by:2}}))}};
}
function respond(request,reply,wire=historyWire()){
  const pathname=request.path.split('?')[0];
  if(pathname==='/api/login')return reply.send({csrf:'synthetic-history-csrf'},200,{'set-cookie':'sid=synthetic-history-session; HttpOnly'});
  if(pathname==='/api/logout')return reply.send({ok:true});
  if(pathname==='/api/projects/7/history')return reply.send(wire.page);
  if(pathname==='/api/projects/7/facts/provenance')return reply.send(wire.proof);
  assert.fail('Unexpected historical fallback or write endpoint');
}
async function withHttp(handler,run){
  const requests=[],failures=[];
  const server=http.createServer((req,res)=>{
    const chunks=[];req.on('data',data=>chunks.push(data));req.on('end',()=>{
      let body;try{body=chunks.length?JSON.parse(Buffer.concat(chunks)):undefined}catch(error){failures.push(error);res.writeHead(400).end();return}
      const request={path:req.url,method:req.method,headers:req.headers,body};requests.push(request);
      const send=(data,status=200,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(data))};
      Promise.resolve().then(()=>handler(request,{res,send})).catch(error=>{failures.push(error);if(!res.headersSent)send({error:'Synthetic fixture failure'},500);else res.destroy()});
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{return await run({baseURL:`http://127.0.0.1:${server.address().port}`,requests})}
  finally{const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await bounded(closed,'closing owned historical HTTP');if(failures.length)throw new AggregateError(failures,'Historical HTTP fixture failed')}
}
async function withMcp(baseURL,run,env={}){
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(__dirname,'../scripts/mcp-server.js')],env:{MEMZ_BASE_URL:baseURL,MEMZ_PROJECT_ID:'7',MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',MEMZ_MCP_ENABLE_LABEL_CONTEXT:'0',MEMZ_MCP_ALLOW_PROPOSALS:'0',MEMZ_MCP_ENABLE_HISTORY_CONTEXT:'1',...env},stderr:'pipe',maxBufferSize:262144});
  const client=new Client({name:'synthetic-mcp-history-contract',version:'1'});let stderr='';transport.stderr.on('data',chunk=>{stderr+=chunk});
  try{await client.connect(transport,{timeout:5000});return await run(client,transport)}
  finally{await bounded(client.close(),'closing owned historical MCP',6000);assert.equal(stderr,'')}
}
const call=(client,args={},options={})=>client.callTool({name:'memz_read_history_context',arguments:args},undefined,{timeout:10000,...options});
module.exports={bounded,deferred,result,historyWire,respond,withHttp,withMcp,call};
