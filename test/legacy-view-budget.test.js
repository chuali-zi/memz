const {test}=require('node:test');
const assert=require('node:assert/strict');
const {LEGACY_VIEW_MAX_ROWS,LEGACY_VIEW_MAX_BYTES,LEGACY_VIEW_MESSAGE,assertLegacyScope,assertLegacyJSONBudget}=require('../scripts/legacy-view-budget');
const rejects=fn=>assert.rejects(fn,error=>error.status===422&&error.code==='LEGACY_VIEW_TOO_LARGE'&&error.message===LEGACY_VIEW_MESSAGE);
test('disabled sections cause no preflight query, enabled metadata is bound to project and original facts query',async()=>{
  const calls=[],client={query:async(...args)=>{calls.push(args);return {rows:[{rows:512,bytes:'32',bad:false}]}}};
  await assertLegacyScope(client,7,'original query',{});assert.equal(calls.length,0);
  await assertLegacyScope(client,7,'original query',{facts:true,sources:true,candidates:true,history:true,audit:true});
  assert.equal(calls.length,5);assert.deepEqual(calls.map(([,params])=>params),[[7,'original query'],[7],[7],[7],[7]]);
  assert.equal(LEGACY_VIEW_MAX_ROWS,512);assert.equal(LEGACY_VIEW_MAX_BYTES,4194304);
});
test('overflow, corrupt fields, malformed scalar metadata and accumulated bytes fail closed before further sections',async()=>{
  for(const metadata of [{rows:513,bytes:'1',bad:false},{rows:1,bytes:'1',bad:true},{rows:1,bytes:'-1',bad:false},{rows:1,bytes:'invalid',bad:false},{rows:1,bytes:'1',bad:null}]){
    let reads=0;await rejects(()=>assertLegacyScope({query:async()=>{reads++;return {rows:[metadata]}}},1,'',{sources:true,history:true}));assert.equal(reads,1);
  }
  let reads=0;await rejects(()=>assertLegacyScope({query:async()=>{reads++;return {rows:[{rows:1,bytes:String(LEGACY_VIEW_MAX_BYTES/2+1),bad:false}]}}},1,'',{facts:true,sources:true,history:true}));assert.equal(reads,2);
});
test('complete-row JSON byte count exactly matches whole ordinary envelopes including dates, unicode and escaping',()=>{
  for(const body of [{sourceTextIsUntrusted:true,role:'owner'},{sourceTextIsUntrusted:true,role:'viewer',facts:[],sources:[]},{sourceTextIsUntrusted:true,role:'owner',sources:[{id:1,title:'😀标题',content:'quote" slash\\ control\n\u0001'}],history:[{created_at:new Date('2026-01-01T00:00:00Z'),value:'值'}],audit:[]}])assert.equal(assertLegacyJSONBudget(body),Buffer.byteLength(JSON.stringify(body),'utf8'));
});
test('escaped complete rows can exceed the JSON budget even when raw text is below the raw byte budget',()=>{
  const value={sourceTextIsUntrusted:true,role:'owner',sources:Array.from({length:180},(_,id)=>({id,title:'fixture',content:'\u0001'.repeat(4000)}))};
  assert.ok(180*4000<LEGACY_VIEW_MAX_BYTES);
  assert.throws(()=>assertLegacyJSONBudget(value),error=>error.status===422&&error.message===LEGACY_VIEW_MESSAGE);
});
test('raw scalar and exact escaped JSON budgets accept their inclusive boundary and reject one extra byte',async()=>{
  await assertLegacyScope({query:async()=>({rows:[{rows:512,bytes:String(LEGACY_VIEW_MAX_BYTES),bad:false}]})},1,'',{sources:true});
  await rejects(()=>assertLegacyScope({query:async()=>({rows:[{rows:512,bytes:String(LEGACY_VIEW_MAX_BYTES+1),bad:false}]})},1,'',{sources:true}));
  const value={sourceTextIsUntrusted:true,role:'owner',sources:Array.from({length:512},(_,id)=>({id,title:'fixture',content:'x'.repeat(8000)}))};
  const remaining=LEGACY_VIEW_MAX_BYTES-Buffer.byteLength(JSON.stringify(value));
  for(const row of value.sources)row.content+='x'.repeat(Math.floor(remaining/512));
  value.sources.at(-1).content+='x'.repeat(remaining%512);
  assert.equal(assertLegacyJSONBudget(value),LEGACY_VIEW_MAX_BYTES);value.sources.at(-1).content+='x';
  assert.throws(()=>assertLegacyJSONBudget(value),error=>error.status===422&&error.message===LEGACY_VIEW_MESSAGE);
});
