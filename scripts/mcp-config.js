// Print a reviewable configuration fragment. Never reads or writes host settings.
const path=require('node:path');
function configuration(host){
  if(!['claude-desktop','vscode'].includes(host))throw new Error('UNSUPPORTED_HOST');
  const server={...(host==='vscode'?{type:'stdio'}:{}),command:process.execPath,args:[path.join(__dirname,'mcp-server.js')],env:{MEMZ_BASE_URL:'http://127.0.0.1:3000',MEMZ_PROJECT_ID:'1',MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',MEMZ_MCP_ALLOW_PROPOSALS:'0'}};
  return {[host==='vscode'?'servers':'mcpServers']:{memz:server}};
}
if(require.main===module){
  try{if(process.argv.length!==4||process.argv[2]!=='--host')throw new Error('USAGE');process.stdout.write(JSON.stringify(configuration(process.argv[3]),null,2)+'\n')}
  catch{process.stderr.write('Usage: node scripts/mcp-config.js --host claude-desktop|vscode\n');process.exitCode=1}
}
module.exports={configuration};
