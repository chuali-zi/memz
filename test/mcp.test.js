const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {config}=require('../scripts/mcp-server');
const {once}=require('node:events');
function child(env={}){
  const proc=spawn(process.execPath,['scripts/mcp-server.js'],{env:{...process.env,MEMZ_BASE_URL:'http://127.0.0.1:9',MEMZ_MCP_ALLOW_PROPOSALS:'0',...env},stdio:['pipe','pipe','pipe']});
  let buffer='',stderr='';const queue=[],waiting=[];
  proc.stderr.on('data',b=>stderr+=b);proc.stdin.on('error',()=>{});
  proc.stdout.on('data',b=>{buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(waiting.length)waiting.shift()(m);else queue.push(m)}});
  const closed=once(proc,'close');
  return {proc,closed,stderr:()=>stderr,async request(method,params,id=1){proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return Promise.race([queue.length?Promise.resolve(queue.shift()):new Promise(r=>waiting.push(r)),new Promise((_,reject)=>setTimeout(()=>reject(new Error('MCP response timeout')),3000).unref())])},notify(method){proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method})+'\n')},async close(){proc.stdin.end();await closed}};
}
test('MCP configuration fixes local project scope and defaults to read-only',()=>{
  assert.equal(config({}).allowProposals,false);
  for(const env of [{MEMZ_BASE_URL:'https://example.com'},{MEMZ_BASE_URL:'http://localhost:3000'},{MEMZ_BASE_URL:'http://127.0.0.1/path'},{MEMZ_BASE_URL:'http://user:secret@127.0.0.1'},{MEMZ_PROJECT_ID:'0'},{MEMZ_MCP_ALLOW_PROPOSALS:'yes'}])assert.throws(()=>config(env),/INVALID_CONFIG/);
});
test('real stdio handshake, read-only discovery, unknown tools and scope injection rejection',async()=>{
  const c=child();try{
    assert.equal((await c.request('tools/list',{})).error.code,-32600);
    const init=await c.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-test',version:'1'}});
    assert.equal(init.result.protocolVersion,'2025-11-25');assert.deepEqual(init.result.capabilities,{tools:{}});
    assert.equal((await c.request('tools/list',{})).error.code,-32600);
    c.notify('notifications/initialized');
    const listed=await c.request('tools/list',{});assert.deepEqual(listed.result.tools.map(t=>t.name),['memz_read_context']);
    for(const name of ['memz_submit_proposal','approve','sources/create'])assert.equal((await c.request('tools/call',{name,arguments:{}})).error.code,-32602);
    for(const arguments_ of [{projectId:2},{baseURL:'http://example.com'},{username:'owner'},{limit:26},{maxOutputBytes:999999},{query:'\ud800'}]){
      const response=await c.request('tools/call',{name:'memz_read_context',arguments:arguments_});assert.equal(response.result.isError,true);
    }
    assert.equal((await c.request('server/discover',{})).error.code,-32601,'newer protocol is not claimed');
    assert.equal(c.stderr(),'');
  }finally{await c.close()}
});
test('stdio closes on malformed, oversized and invalid UTF-8 without echoing inputs',async()=>{
  for(const bytes of [Buffer.from('{"secret":"synthetic-canary"\n'),Buffer.from('x'.repeat(16385)),Buffer.from([0xff,10])]){
    const c=child();c.proc.stdin.end(bytes);await c.closed;assert.equal(c.stderr(),'MCP_PROTOCOL_ERROR\n');
  }
});

test('unsupported handshake version negotiates the documented compatibility version',async()=>{
  const c=child();try{
    const response=await c.request('initialize',{protocolVersion:'2026-07-28',capabilities:{},clientInfo:{name:'synthetic-test',version:'1'}});
    assert.equal(response.result.protocolVersion,'2025-11-25');
  }finally{await c.close()}
});
