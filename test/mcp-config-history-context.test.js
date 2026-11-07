const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {configuration}=require('../scripts/mcp-config');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {bounded}=require('./mcp-history-fixture');
const script=path.resolve(__dirname,'../scripts/mcp-config.js'),usage='Usage: node scripts/mcp-config.js --host claude-desktop|vscode [--label-context] [--history-context]\n';
const entry=(value,host)=>value[host==='vscode'?'servers':'mcpServers'].memz;
function oldJSON(host,label=false){
  const server={...(host==='vscode'?{type:'stdio'}:{}),command:process.execPath,args:[path.resolve(__dirname,'../scripts/mcp-server.js')],env:{MEMZ_BASE_URL:'http://127.0.0.1:3000',MEMZ_PROJECT_ID:'1',MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',MEMZ_MCP_ALLOW_PROPOSALS:'0',MEMZ_MCP_ENABLE_LABEL_CONTEXT:label?'1':'0'}};
  return JSON.stringify({[host==='vscode'?'servers':'mcpServers']:{memz:server}},null,2)+'\n';
}
function generate(args,options={}){return spawnSync(process.execPath,[script,...args],{env:{MEMZ_MCP_ENABLE_HISTORY_CONTEXT:'1',MEMZ_MCP_ENABLE_LABEL_CONTEXT:'1',MEMZ_MCP_ALLOW_PROPOSALS:'1',MEMZ_USERNAME:'owner',MEMZ_PASSWORD:'synthetic-private-generator-input'},encoding:'utf8',timeout:5000,...options})}
test('both host defaults and false history preserve the exact previous JSON bytes including label behavior',()=>{
  for(const host of ['vscode','claude-desktop'])for(const labelContext of [false,true]){
    for(const options of [{labelContext},{labelContext,historyContext:false}])assert.equal(JSON.stringify(configuration(host,options),null,2)+'\n',oldJSON(host,labelContext));
    const enabled=configuration(host,{labelContext,historyContext:true}),expected=JSON.parse(oldJSON(host,labelContext));entry(expected,host).env.MEMZ_MCP_ENABLE_HISTORY_CONTEXT='1';
    assert.deepEqual(enabled,expected);assert.equal(entry(enabled,host).env.MEMZ_MCP_ALLOW_PROPOSALS,'0');
    const printed=generate(['--host',host,...(labelContext?['--label-context']:[])]);assert.equal(printed.status,0);assert.equal(printed.stderr,'');assert.equal(printed.stdout,oldJSON(host,labelContext));assert.ok(!printed.stdout.includes('synthetic-private'));
  }
});
test('history configuration only accepts own boolean data properties and never evaluates accessors',()=>{
  let reads=0;
  for(const options of [{historyContext:undefined},{historyContext:null},{historyContext:'1'},{historyContext:1},{historyContext:true,password:'synthetic-private'},Object.create({historyContext:true}),{[Symbol('historyContext')]:true},Object.defineProperty({},'gold',{value:'synthetic-private'}),{get historyContext(){reads++;return true}},{get labelContext(){reads++;return false},historyContext:true}])assert.throws(()=>configuration('vscode',options),{message:'INVALID_OPTIONS'});
  assert.equal(reads,0);assert.deepEqual(configuration('vscode',Object.assign(Object.create(null),{historyContext:true})),configuration('vscode',{historyContext:true}));
});
test('history CLI opt-in accepts either order and combined labels while malformed flags produce only fixed usage',()=>{
  for(const host of ['vscode','claude-desktop'])for(const args of [['--host',host,'--history-context'],['--history-context','--host',host],['--label-context','--history-context','--host',host]]){
    const printed=generate(args);assert.equal(printed.status,0);assert.equal(printed.stderr,'');assert.deepEqual(JSON.parse(printed.stdout),configuration(host,{labelContext:args.includes('--label-context'),historyContext:true}));
  }
  for(const args of [['--history-context'],['--host','vscode','--history-context','--history-context'],['--host','vscode','--history-context=1'],['--host','vscode','--history-context','true'],['--host','vscode','--signal','synthetic-private'],['--host','vscode','--as-of','2026-11-07']]){
    const printed=generate(args);assert.equal(printed.status,1);assert.equal(printed.stdout,'');assert.equal(printed.stderr,usage);
  }
});
test('real SDK launches both generated schemas with history opt-in from a space-containing cwd without host files',{timeout:20000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memz history generated ')),before=fs.readdirSync(dir);
  try{
    for(const host of ['vscode','claude-desktop']){
      const printed=generate(['--host',host,'--history-context']);assert.equal(printed.status,0);const value=entry(JSON.parse(printed.stdout),host);
      const transport=new StdioClientTransport({...value,cwd:dir,stderr:'pipe'}),client=new Client({name:'synthetic-generated-history-host',version:'1'});let stderr='';transport.stderr.on('data',chunk=>{stderr+=chunk});
      try{
        await client.connect(transport,{timeout:5000});const tools=(await client.listTools()).tools;assert.deepEqual(tools.map(t=>t.name),['memz_read_context','memz_read_history_context']);assert.equal(tools[1].annotations.readOnlyHint,true);
        for(const name of ['memz_submit_proposal','memz_read_label_context','approve','reject','create_source'])await assert.rejects(()=>client.callTool({name,arguments:{}}),/UNKNOWN_TOOL/);
        assert.equal(value.env.MEMZ_USERNAME,'viewer');assert.equal(value.env.MEMZ_PASSWORD,'demo-viewer');assert.equal(value.env.MEMZ_MCP_ALLOW_PROPOSALS,'0');
      }finally{await bounded(client.close(),'closing generated history SDK',6000)}assert.equal(stderr,'');
    }
    assert.deepEqual(fs.readdirSync(dir),before);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
