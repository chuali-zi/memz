const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const script=path.resolve(__dirname,'../scripts/mcp-config.js');
test('generated host configurations launch real stdio processes outside the repository with minimal environment',async()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'memz host config '));
  try{
    for(const host of ['claude-desktop','vscode']){
      // Deliberately hostile inherited MEMZ settings must not leak into generated defaults.
      const printed=execFileSync(process.execPath,[script,'--host',host],{cwd,env:{MEMZ_PASSWORD:'synthetic-config-canary',MEMZ_MCP_ALLOW_PROPOSALS:'1'},encoding:'utf8'});
      assert.ok(!printed.includes('synthetic-config-canary'));
      const config=JSON.parse(printed),entry=config[host==='vscode'?'servers':'mcpServers'].memz;
      if(host==='vscode')assert.equal(entry.type,'stdio');
      assert.ok(path.isAbsolute(entry.command));assert.ok(path.isAbsolute(entry.args[0]));assert.equal(entry.env.MEMZ_MCP_ALLOW_PROPOSALS,'0');
      const transport=new StdioClientTransport({...entry,cwd,stderr:'pipe'});
      const client=new Client({name:'synthetic-host-config-test',version:'1'});let stderr='';transport.stderr.on('data',b=>stderr+=b);
      try{
        await client.connect(transport);
        assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['memz_read_context']);
        await assert.rejects(()=>client.callTool({name:'memz_submit_proposal',arguments:{}}));
        await assert.rejects(()=>client.callTool({name:'approve',arguments:{}}));
      }finally{await client.close()}
      assert.equal(stderr,'');assert.deepEqual(fs.readdirSync(cwd),[],'generator and server must not create configuration or credential files');
    }
  }finally{fs.rmSync(cwd,{recursive:true,force:true})}
});
test('config generator refuses unknown host and extra arguments without partial JSON',()=>{
  for(const args of [['--host','other'],['--host','vscode','extra']])assert.throws(()=>execFileSync(process.execPath,[script,...args],{stdio:['ignore','pipe','pipe']}),e=>e.status===1&&e.stdout.length===0);
});
