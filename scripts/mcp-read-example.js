// Minimal local MCP host: fixed public viewer role, no model and no configuration writes.
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {configuration}=require('./mcp-config');
const {config}=require('./mcp-server');
async function main(){
  const query=process.argv[2]||'',after=process.argv[3]===undefined?0:Number(process.argv[3]);
  if(process.argv.length>4||query.length>200||!query.isWellFormed()||query.includes('\0')||!Number.isInteger(after)||after<0||after>2147483647)throw new Error('INVALID_INPUT');
  const entry=configuration('claude-desktop').mcpServers.memz;
  entry.env.MEMZ_BASE_URL=process.env.MEMZ_DEMO_BASE_URL||entry.env.MEMZ_BASE_URL;
  entry.env.MEMZ_PROJECT_ID=process.env.MEMZ_DEMO_PROJECT_ID||entry.env.MEMZ_PROJECT_ID;
  config(entry.env); // Validate the local address and scope before spawning any server.
  const transport=new StdioClientTransport({...entry,stderr:'pipe',maxBufferSize:262144});
  // Drain diagnostics without forwarding potentially sensitive subprocess messages.
  transport.stderr.resume();
  const client=new Client({name:'memz-read-example',version:'0.1.0'});
  let context;
  try{
    await client.connect(transport,{timeout:5000});
    const tools=await client.listTools({}, {timeout:5000});
    if(tools.tools.length!==1||tools.tools[0].name!=='memz_read_context')throw new Error('UNEXPECTED_TOOLS');
    const result=await client.callTool({name:'memz_read_context',arguments:{query,after,limit:10,maxOutputBytes:32768}},undefined,{timeout:40000});
    if(result.content?.length!==1||result.content[0].type!=='text')throw new Error('INVALID_RESULT');
    const value=JSON.parse(result.content[0].text);
    if(result.isError){
      const code=typeof value.code==='string'&&/^(HTTP_[45][0-9]{2}|REQUEST_FAILED|REQUEST_TIMEOUT|TOTAL_TIMEOUT|OUTPUT_BUDGET_TOO_SMALL|BUSY)$/.test(value.code)?value.code:'MCP_READ_FAILED';
      throw Object.assign(new Error('READ_FAILED'),{safeCode:code});
    }
    if(value.schemaVersion!==1||value.projectId!==Number(entry.env.MEMZ_PROJECT_ID)||value.sourceTextIsUntrusted!==true||!Array.isArray(value.facts))throw new Error('INVALID_RESULT');
    context=value;
  }finally{await client.close()}
  process.stdout.write(JSON.stringify(context,null,2)+'\n');
}
main().catch(error=>{process.stderr.write(JSON.stringify({code:error.safeCode||'MCP_READ_FAILED'})+'\n');process.exitCode=1});
