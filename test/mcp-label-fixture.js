const assert=require('node:assert/strict');
const http=require('node:http');
const path=require('node:path');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {page,sampleFacts}=require('./label-context-fixture');
const {currentLabelsReceipt,exactContextReceipt}=require('../scripts/exact-context-protocol');
const selector={subject:'晨桥服务',predicate:'交付时间'};
const question=selector.subject+'的'+selector.predicate+'是什么？';
function metadata({labels=[selector],complete=true,projectId=7}={}){
  return {...currentLabelsReceipt(),projectId,role:'viewer',sourceTextIsUntrusted:true,limit:512,complete,labels};
}
function exact({key=selector,projectId=7}={}){
  const wire=page({facts:[{...sampleFacts[0],subject:key.subject,predicate:key.predicate}]});
  return {...exactContextReceipt(),projectId,selector:{...key},role:'viewer',sourceTextIsUntrusted:true,facts:wire.facts,provenance:wire.provenance,sources:wire.sources};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const result=value=>JSON.parse(value.content[0].text);
async function withHttp(handler,run){
  const requests=[],server=http.createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      const request={path:req.url,method:req.method,headers:req.headers,body:chunks.length?JSON.parse(Buffer.concat(chunks)):undefined};requests.push(request);
      const send=(data,status=200,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(data))};
      handler(request,{res,send});
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{return await run({baseURL:`http://127.0.0.1:${server.address().port}`,requests})}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}
function respond(request,{send},{labels=metadata(),context=exact(),status=200}={}){
  if(request.path==='/api/login')return send({csrf:'synthetic-mcp-label-csrf'},200,{'set-cookie':'sid=synthetic-mcp-label-session; HttpOnly'});
  if(request.path==='/api/logout')return send({ok:true});
  if(request.path==='/api/projects/7/current-labels')return send(labels);
  if(request.path==='/api/projects/7/context/exact')return send(context,status);
  assert.fail('Unexpected HTTP fallback or write: '+request.path);
}
async function withMcp(baseURL,run,env={}){
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(__dirname,'../scripts/mcp-server.js')],env:{MEMZ_BASE_URL:baseURL,MEMZ_PROJECT_ID:'7',MEMZ_MCP_ENABLE_LABEL_CONTEXT:'1',MEMZ_MCP_ALLOW_PROPOSALS:'0',...env},stderr:'pipe',maxBufferSize:262144});
  const client=new Client({name:'synthetic-mcp-label-contract',version:'1'});let stderr='';transport.stderr.on('data',chunk=>stderr+=chunk);
  try{await client.connect(transport,{timeout:10000});return await run(client,transport)}
  finally{await client.close();assert.equal(stderr,'')}
}
const call=(client,arguments_={question},options)=>client.callTool({name:'memz_read_label_context',arguments:arguments_},undefined,{timeout:10000,...options});
module.exports={selector,question,metadata,exact,deferred,result,withHttp,respond,withMcp,call};
