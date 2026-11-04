const {test}=require('node:test'),assert=require('node:assert/strict');
const {runDemoStory}=require('../scripts/demo-story');
test('rehearsal requires an explicit local demo URL before creating records',async()=>{
  for(const baseURL of [undefined,'https://example.com','http://user:password@localhost:3000','http://localhost:3000/path','http://localhost:3000/?token=synthetic'])await assert.rejects(()=>runDemoStory({baseURL}),e=>['LOCAL_DEMO_URL_REQUIRED','DEMO_BASE_URL_REQUIRED'].includes(e.code));
});

test('rehearsal extraction requires one record and preserves the raw result',()=>{
  const {rehearsalFromTap}=require('../scripts/package-evidence');
  const fixture={schemaVersion:1,synthetic:true,steps:Array.from({length:7},()=>({name:'unit fixture'})),context:{facts:[{value:'15号',version:2}]},provenanceV1:{value:'20号'}};
  const line='# Synthetic reviewer rehearsal result: '+JSON.stringify(fixture)+'\n';
  assert.deepEqual(rehearsalFromTap(line),fixture);assert.throws(()=>rehearsalFromTap(''),/exactly one/);assert.throws(()=>rehearsalFromTap(line+line),/exactly one/);assert.throws(()=>rehearsalFromTap(line.replace('15号','伪造值')));
});
