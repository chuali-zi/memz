// Original synthetic labels only. Loopback transports never call a model.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {selectLabelTemplate,QUESTION_CONNECTORS,QUESTION_ENDINGS}=require('../scripts/label-template-core');
const {planLabelQuery}=require('../scripts/label-query-plan');
const {planExactLabelQuery,EXACT_PLANNER_MODE,EXACT_QUESTION_MAX_LENGTH}=require('../scripts/label-query-plan-v2');
const {readLabelContext}=require('../scripts/label-context');
const {validateExactSelector}=require('../scripts/exact-context-protocol');
const {parseSearchQuery}=require('../scripts/search-query');
const {metadata,exact,respond,withHttp,withMcp,call,result}=require('./mcp-label-fixture');
const keys=[{subject:'S'.repeat(100),predicate:'P'.repeat(100)},{subject:'😀'.repeat(50),predicate:'🚀'.repeat(50)}];
const question=key=>key.subject+'当前批准的'+key.predicate+'是哪一天？';
const reply=key=>(request,response)=>respond(request,response,{labels:metadata({labels:[key]}),context:exact({key})});

test('v2 derives 210 UTF-16 units and preserves complete legal ASCII and surrogate-pair keys',()=>{
  assert.equal(EXACT_QUESTION_MAX_LENGTH,100*2+Math.max(...QUESTION_CONNECTORS.map(x=>x.length))+Math.max(...QUESTION_ENDINGS.map(x=>x.length))+1);
  assert.equal(EXACT_QUESTION_MAX_LENGTH,210);
  for(const key of keys){
    assert.deepEqual(validateExactSelector(key),key);assert.equal(key.subject.length,100);assert.equal(key.predicate.length,100);
    for(const connector of ['目前批准的','当前批准的'])for(const mark of ['','?','？']){
      const input=key.subject+connector+key.predicate+'是哪一天'+mark;
      assert.equal(input.length,209+mark.length);
      assert.deepEqual(planExactLabelQuery({question:input,labels:[key]}),{schemaVersion:1,mode:EXACT_PLANNER_MODE,view:'current',status:'planned',selector:key,template:{connector,ending:'是哪一天'}});
    }
  }
});

test('raw v2 length precedes outer trimming and never splits or accepts broken Unicode',()=>{
  const labels=[keys[0]],full=question(keys[0]),withoutMark=full.slice(0,-1);
  for(const raw of [full,' '+withoutMark,withoutMark+' '])assert.equal(planExactLabelQuery({question:raw,labels}).status,'planned');
  for(const raw of [' '+full,full+' ',full+'？','x'.repeat(211),'前\ud800后','前\udc00后','前\0后']){
    assert.throws(()=>planExactLabelQuery({question:raw,labels}),{code:'INVALID_PLANNER_QUESTION'});
  }
});

test('v1 retains its default 200-unit question, 25-row, eight-term and 200-unit query limits',()=>{
  assert.throws(()=>selectLabelTemplate({question:question(keys[0]),labels:keys},512),{code:'INVALID_PLANNER_QUESTION'});
  assert.throws(()=>planLabelQuery({question:question(keys[0]),labels:keys}),{code:'INVALID_PLANNER_QUESTION'});
  assert.throws(()=>planLabelQuery({question:'x'.repeat(201),labels:[]}),{code:'INVALID_PLANNER_QUESTION'});
  assert.throws(()=>parseSearchQuery(keys[0].subject+' '+keys[0].predicate,'all_terms'),{code:'INVALID_QUERY'});
  const key={subject:'a b c d e f g h',predicate:'i'},input={question:key.subject+'的i是什么？',labels:[key]};
  assert.equal(planLabelQuery(input).reason,'KEY_SEARCH_LIMIT');assert.equal(planExactLabelQuery(input).status,'planned');
  assert.equal(planLabelQuery({question:'甲的乙是什么',labels:Array(26).fill({subject:'甲',predicate:'乙'})}).reason,'SCOPE_TOO_LARGE');
});

test('v2 rejects 211, unknown protocols and caller evidence or capacity before any fetch or gold getter',async()=>{
  let fetches=0,reads=0;const fetchImpl=async()=>{fetches++;assert.fail('Invalid input must not fetch')};
  const defaults={projectId:7,question:question(keys[0]),protocol:'metadata_exact_v2',fetchImpl};
  for(const extra of [{question:' '+defaults.question},{question:defaults.question+' '},{question:'x'.repeat(211)}])await assert.rejects(()=>readLabelContext({...defaults,...extra}),{code:'INVALID_PLANNER_QUESTION'});
  for(const protocol of ['snapshot_filter_v1',undefined])await assert.rejects(()=>readLabelContext({...defaults,protocol}),{code:'INVALID_PLANNER_QUESTION'});
  await assert.rejects(()=>readLabelContext({...defaults,protocol:'unknown'}),{code:'INVALID_LABEL_PROTOCOL'});
  for(const field of ['gold','selector','maxcap','questionMaxLength']){
    const pure={question:defaults.question,labels:keys},module={...defaults};
    for(const input of [pure,module])Object.defineProperty(input,field,{get(){reads++;assert.fail('Unknown fields must not be read')}});
    assert.throws(()=>planExactLabelQuery(pure),{code:'INVALID_PLANNER_INPUT'});
    await assert.rejects(()=>readLabelContext(module),{code:'INVALID_LABEL_CONTEXT_INPUT'});
  }
  const labelsInput={...defaults};Object.defineProperty(labelsInput,'labels',{get(){reads++;assert.fail('Caller labels must not be read')}});
  await assert.rejects(()=>readLabelContext(labelsInput),{code:'INVALID_LABEL_CONTEXT_INPUT'});
  assert.equal(reads,0);assert.equal(fetches,0);
});

test('real loopback v2 module reads the complete longest labels without altering exact receipt or mode',{timeout:15000},async()=>{
  for(const key of keys)await withHttp(reply(key),async({baseURL,requests})=>{
    const output=await readLabelContext({baseURL,projectId:7,question:question(key),protocol:'metadata_exact_v2'});
    assert.equal(output.status,'matched');assert.equal(output.protocol,'metadata_exact_v2');assert.equal(output.plan.mode,EXACT_PLANNER_MODE);
    assert.deepEqual(output.plan.selector,key);assert.deepEqual(output.context,exact({key}));assert.equal(output.execution.modelCalls,0);
    assert.equal(requests.length,4);assert.deepEqual(requests[2].body,{selector:key});assert.equal(requests.at(-1).path,'/api/logout');
  });
});

function cli(baseURL,input){
  const child=spawn(process.execPath,['scripts/label-context.js','--stdin'],{env:{...process.env,MEMZ_BASE_URL:baseURL,MEMZ_PROJECT_ID:'7',MEMZ_USERNAME:'viewer',MEMZ_PASSWORD:'demo-viewer',MEMZ_LABEL_PROTOCOL:'snapshot_filter_v1'},stdio:['pipe','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',failed=false;const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL')},10000);
    const collect=(target,bytes,max)=>{if(Buffer.byteLength(target)+bytes.length>max){failed=true;child.kill('SIGKILL');return target}return target+bytes};
    child.stdout.on('data',bytes=>{stdout=collect(stdout,bytes,1048576)});child.stderr.on('data',bytes=>{stderr=collect(stderr,bytes,8192)});child.stdin.on('error',()=>{});
    child.once('error',()=>{failed=true});
    child.once('close',code=>{clearTimeout(timer);if(failed)reject(new Error('Synthetic long-question CLI failed or exceeded its bound'));else resolve({code,stdout,stderr})});
    child.stdin.end(input);
  });
}
test('real stdin CLI accepts both longest v2 questions while preserving no-HTTP rejection and 16 KiB input',{timeout:20000},async()=>{
  for(const key of keys)await withHttp(reply(key),async({baseURL,requests})=>{
    const input={projectId:7,question:question(key),protocol:'metadata_exact_v2'},good=await cli(baseURL,JSON.stringify(input));
    assert.equal(good.code,0);assert.equal(good.stderr,'');const output=JSON.parse(good.stdout);
    assert.equal(output.status,'matched');assert.deepEqual(output.context,exact({key}));assert.equal(output.execution.modelCalls,0);assert.equal(requests.length,4);
    const rejected=[[{...input,question:input.question+' '},'INVALID_PLANNER_QUESTION'],[{...input,protocol:'snapshot_filter_v1'},'INVALID_PLANNER_QUESTION'],[{...input,protocol:'unknown'},'INVALID_LABEL_PROTOCOL'],[{...input,gold:'synthetic-answer'},'INVALID_STDIN_REQUEST']];
    for(const [value,code] of rejected){const before=requests.length,bad=await cli(baseURL,JSON.stringify(value));assert.equal(bad.code,1);assert.equal(bad.stdout,'');assert.equal(bad.stderr,'Label context failed: '+code+'\n');assert.equal(requests.length,before)}
    const before=requests.length,oversized=await cli(baseURL,'x'.repeat(16385));assert.equal(oversized.code,1);assert.equal(oversized.stdout,'');assert.match(oversized.stderr,/INPUT_TOO_LARGE/);assert.equal(requests.length,before);
  });
});

test('SDK advertises only the label-tool increase and runtime rejects raw 211 without HTTP',{timeout:20000},async()=>{
  for(const key of keys)await withHttp(reply(key),async({baseURL,requests})=>withMcp(baseURL,async client=>{
    const tools=(await client.listTools()).tools;
    assert.equal(tools.find(x=>x.name==='memz_read_label_context').inputSchema.properties.question.maxLength,210);
    assert.equal(tools.find(x=>x.name==='memz_read_context').inputSchema.properties.query.maxLength,200);
    assert.equal(tools.find(x=>x.name==='memz_read_label_context').inputSchema.properties.maxOutputBytes.maximum,32768);
    const value=await call(client,{question:question(key)});assert.equal(value.isError,false);assert.deepEqual(result(value).context,exact({key}));assert.equal(requests.length,4);
    const before=requests.length;
    for(const raw of [' '+question(key),question(key)+' ']){
      const bad=await call(client,{question:raw});assert.equal(bad.isError,true);assert.deepEqual(result(bad),{code:'INVALID_ARGUMENTS',outcome:'read_failed'});
    }
    assert.equal(requests.length,before);
  }));
});
