const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseTap}=require('../scripts/system-evidence');
const tap=({tests=2,pass=2,fail=0,cancelled=0,skipped=0,todo=0}={})=>`TAP version 13\nok 1 - example\nok 2 - example\n# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped ${skipped}\n# todo ${todo}\n`;
test('TAP evidence preserves exact successful counts',()=>assert.deepEqual(parseTap(tap()),{tests:2,pass:2,fail:0,cancelled:0,skipped:0,todo:0}));
test('TAP failure and skip counts remain explicit',()=>{
  assert.equal(parseTap(tap({pass:1,fail:1})).fail,1);
  assert.equal(parseTap(tap({pass:1,skipped:1})).skipped,1);
});
test('TAP missing or duplicate summaries cannot appear successful',()=>{
  assert.throws(()=>parseTap(tap().replace('# fail 0\n','')),/Missing or duplicate/);
  assert.throws(()=>parseTap(tap()+'# pass 2\n'),/Missing or duplicate/);
});
test('TAP contradictions, empty tests and not-ok with a success summary are rejected',()=>{
  assert.throws(()=>parseTap(tap({tests:3})),/counts disagree/);
  assert.throws(()=>parseTap(tap({tests:0,pass:0})),/No tests/);
  assert.throws(()=>parseTap(tap().replace('ok 1','not ok 1')),/contradicts/);
});
