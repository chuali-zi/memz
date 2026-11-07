const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const {configuration}=require('../scripts/mcp-config');
const script=path.resolve(__dirname,'../scripts/mcp-config.js');
const usage='Usage: node scripts/mcp-config.js --host claude-desktop|vscode [--label-context] [--history-context]\n';
const entry=(value,host)=>value[host==='vscode'?'servers':'mcpServers'].memz;
const inherited={MEMZ_PASSWORD:'synthetic-generator-private',MEMZ_USERNAME:'owner',MEMZ_BASE_URL:'https://synthetic.invalid/',MEMZ_PROJECT_ID:'2',MEMZ_MCP_ALLOW_PROPOSALS:'1',MEMZ_MCP_ENABLE_LABEL_CONTEXT:'1'};
function generate(args,{file=script,cwd}={}){return spawnSync(process.execPath,[file,...args],{cwd,env:inherited,encoding:'utf8',timeout:10000})}
test('configuration(host) remains exactly the default read-only fragment; opt-in changes only its label flag',()=>{
  for(const host of ['claude-desktop','vscode']){
    const ordinary=configuration(host),explicit=configuration(host,{labelContext:false}),enabled=configuration(host,{labelContext:true});
    assert.deepEqual(ordinary,explicit);const changed=structuredClone(ordinary);entry(changed,host).env.MEMZ_MCP_ENABLE_LABEL_CONTEXT='1';assert.deepEqual(enabled,changed);
    const value=entry(ordinary,host);assert.equal(value.command,process.execPath);assert.equal(value.args[0],path.resolve(__dirname,'../scripts/mcp-server.js'));
    assert.deepEqual(value.env,{MEMZ_BASE_URL:'http://127.0.0.1:3000',MEMZ_PROJECT_ID:'1',MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',MEMZ_MCP_ALLOW_PROPOSALS:'0',MEMZ_MCP_ENABLE_LABEL_CONTEXT:'0'});
    assert.deepEqual(Object.keys(ordinary),[host==='vscode'?'servers':'mcpServers']);assert.deepEqual(Object.keys(value),host==='vscode'?['type','command','args','env']:['command','args','env']);
    if(host==='vscode')assert.equal(value.type,'stdio');
  }
});
test('module options accept only one own boolean data field and never invoke accessors',()=>{
  for(const options of [null,[],true,'--label-context',{labelContext:undefined},{labelContext:'1'},{labelContext:1},{signal:true},{password:'synthetic-generator-private'},{labelContext:true,allowProposals:true},Object.create({labelContext:true}),{[Symbol('private')]:true}])assert.throws(()=>configuration('vscode',options),error=>error.message==='INVALID_OPTIONS'&&error.cause===undefined);
  let calls=0;const accessor={get labelContext(){calls++;throw new Error('synthetic-generator-private')}};
  assert.throws(()=>configuration('vscode',accessor),{message:'INVALID_OPTIONS'});assert.equal(calls,0);
  assert.deepEqual(configuration('vscode',Object.assign(Object.create(null),{labelContext:true})),configuration('vscode',{labelContext:true}));
});
test('CLI opt-in is explicit in either argument order and hostile inherited settings cannot enable writes or replace defaults',()=>{
  for(const host of ['claude-desktop','vscode'])for(const args of [['--host',host],['--host',host,'--label-context'],['--label-context','--host',host]]){
    const result=generate(args);assert.equal(result.status,0);assert.equal(result.stderr,'');assert.ok(!result.stdout.includes('synthetic-generator-private'));
    assert.deepEqual(JSON.parse(result.stdout),configuration(host,{labelContext:args.includes('--label-context')}));
  }
});
test('missing, unknown, malformed and repeated flags return fixed usage and no partial JSON or input echo',()=>{
  const invalid=[[],['--label-context'],['--host'],['--host','other'],['--host','vscode','extra'],['--host','vscode','--host','vscode'],['--host','vscode','--label-context','--label-context'],['--label-context','--label-context','--host','vscode'],['--host','vscode','--label-context=1'],['--host','vscode','--label-context','true'],['--host=vscode'],['--host','vscode','--password','synthetic-generator-private'],['--host','--label-context','vscode'],['--host','vscode','--'],['--host','vscode','--allow-proposals']];
  for(const args of invalid){const result=generate(args);assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,usage)}
});
test('real SDK launches both generated host schemas from paths with spaces with one default or two opt-in read tools',{timeout:30000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memz label config ')),file=path.join(dir,'mcp config.js'),server=path.join(dir,'mcp-server.js');
  fs.copyFileSync(script,file);fs.symlinkSync(path.resolve(__dirname,'../scripts/mcp-server.js'),server);const files=fs.readdirSync(dir).sort();
  try{
    for(const host of ['claude-desktop','vscode'])for(const labelContext of [false,true]){
      const generated=generate(['--host',host,...(labelContext?['--label-context']:[])],{file,cwd:dir});assert.equal(generated.status,0);assert.equal(generated.stderr,'');
      const config=JSON.parse(generated.stdout),value=entry(config,host);assert.equal(value.args[0],server);assert.ok(value.args[0].includes(' '));assert.equal(value.env.MEMZ_MCP_ALLOW_PROPOSALS,'0');
      const transport=new StdioClientTransport({...value,cwd:dir,stderr:'pipe'}),client=new Client({name:'synthetic-generated-label-config',version:'1'});let stderr='';transport.stderr.on('data',chunk=>stderr+=chunk);
      try{
        await client.connect(transport,{timeout:10000});const tools=(await client.listTools()).tools;
        assert.deepEqual(tools.map(tool=>tool.name),['memz_read_context',...(labelContext?['memz_read_label_context']:[])]);
        assert.deepEqual(Object.keys(tools[0].inputSchema.properties),['query','limit','after','maxOutputBytes']);
        assert.ok(tools.every(tool=>tool.annotations.readOnlyHint===true&&tool.annotations.destructiveHint===false));
        if(labelContext){assert.deepEqual(Object.keys(tools[1].inputSchema.properties),['question','maxOutputBytes']);assert.deepEqual(tools[1].inputSchema.required,['question'])}
        for(const name of ['memz_submit_proposal','approve','reject','create_source',...(labelContext?[]:['memz_read_label_context'])])await assert.rejects(()=>client.callTool({name,arguments:{}}));
      }finally{await client.close()}
      assert.equal(stderr,'');assert.deepEqual(fs.readdirSync(dir).sort(),files,'no host configuration, credential or runtime files may be created');
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
