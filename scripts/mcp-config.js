// Print a reviewable configuration fragment. Never reads or writes host settings.
const path=require('node:path');
function configuration(host,options={}){
  if(!['claude-desktop','vscode'].includes(host))throw new Error('UNSUPPORTED_HOST');
  if(!options||typeof options!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(options))||Reflect.ownKeys(options).some(key=>key!=='labelContext'))throw new Error('INVALID_OPTIONS');
  const option=Object.getOwnPropertyDescriptor(options,'labelContext');
  if(option&&(!Object.hasOwn(option,'value')||typeof option.value!=='boolean'))throw new Error('INVALID_OPTIONS');
  const server={...(host==='vscode'?{type:'stdio'}:{}),command:process.execPath,args:[path.join(__dirname,'mcp-server.js')],env:{MEMZ_BASE_URL:'http://127.0.0.1:3000',MEMZ_PROJECT_ID:'1',MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',MEMZ_MCP_ALLOW_PROPOSALS:'0',MEMZ_MCP_ENABLE_LABEL_CONTEXT:option?.value?'1':'0'}};
  return {[host==='vscode'?'servers':'mcpServers']:{memz:server}};
}
function argumentsConfiguration(args){
  let host,labelContext=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--host'&&host===undefined&&i+1<args.length)host=args[++i];
    else if(args[i]==='--label-context'&&!labelContext)labelContext=true;
    else throw new Error('USAGE');
  }
  return configuration(host,{labelContext});
}
if(require.main===module){
  try{process.stdout.write(JSON.stringify(argumentsConfiguration(process.argv.slice(2)),null,2)+'\n')}
  catch{process.stderr.write('Usage: node scripts/mcp-config.js --host claude-desktop|vscode [--label-context]\n');process.exitCode=1}
}
module.exports={configuration};
