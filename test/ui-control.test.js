// Import the real UI controller only. These are short, synthetic callbacks:
// no browser launch, HTTP server, PostgreSQL, model or copied controller logic.
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {createUIControl}=require('./ui');
let handlerCalls=0,cancelCalls=0,abortCalls=0;
const never=()=>new Promise(()=>{});

test('a route failure before observation immediately rejects fatal and releases held work',async()=>{
  const c=createUIControl({workMs:300,stageMs:100,onCancel:()=>{cancelCalls++}});
  let released=false;
  const held=c.hold(()=>{}).then(()=>{released=true});
  const observation=c.watch('original route observation',never());
  const rejected=assert.rejects(observation,error=>error.message==='UI_ROUTE_FAILED at failing route');
  try{
    await c.route('failing route',async()=>{handlerCalls++;throw new Error('SYNTHETIC_PRIVATE_ROUTE_REASON')})({abort:async()=>{abortCalls++}});
    await rejected;await held;
    assert.equal(released,true);assert.equal(c.cancelled,true);assert.equal(c.signal.aborted,true);
    const primary=await c.fatal.catch(error=>error);assert.equal(primary.message,'UI_ROUTE_FAILED at failing route');assert.ok(!primary.message.includes('SYNTHETIC_PRIVATE'));
  }finally{c.stop()}
});
test('the shortened stage deadline cancels and releases a still-unobserved held route',async()=>{
  let cancellations=0;
  const c=createUIControl({workMs:300,stageMs:15,onCancel:()=>{cancelCalls++;cancellations++}});
  let released=false;const held=c.hold(()=>{}).then(()=>{released=true});
  try{
    await assert.rejects(c.watch('never observed',never()),error=>error.message==='UI_STAGE_TIMEOUT at never observed');
    await held;assert.equal(released,true);assert.equal(cancellations,1);assert.equal(c.signal.aborted,true);assert.throws(c.check,/UI_CANCELLED/);
  }finally{c.stop()}
});
test('the shortened work deadline keeps its first error and prevents later route/fetch actions',async()=>{
  let cancellations=0,forbiddenActions=0;
  const c=createUIControl({workMs:15,stageMs:300,onCancel:()=>{cancelCalls++;cancellations++}});
  c.at('held original work');const held=c.hold(()=>{});
  try{
    const first=await c.fatal.catch(error=>error);assert.equal(first.message,'UI_WORK_TIMEOUT at held original work');await held;
    c.abort(new Error('SYNTHETIC_LATER_FAILURE'));
    assert.ok(await c.fatal.catch(error=>error)===first,'later cancellation must retain the exact first error');
    await c.route('late action',()=>{forbiddenActions++})({abort:async()=>{abortCalls++}});
    await assert.rejects(c.fetch({fetch:async()=>{forbiddenActions++}}),/UI_CANCELLED/);
    assert.equal(forbiddenActions,0);assert.equal(cancellations,1);assert.throws(c.check,/UI_CANCELLED/);
  }finally{c.stop()}
});
test('stop clears real work/stage timers and releases holds without cancelling twice',async t=>{
  const nativeSet=globalThis.setTimeout,nativeClear=globalThis.clearTimeout,created=[],cleared=[];
  t.mock.method(globalThis,'setTimeout',(...args)=>{const timer=nativeSet(...args);created.push(timer);return timer});
  t.mock.method(globalThis,'clearTimeout',timer=>{cleared.push(timer);return nativeClear(timer)});
  let cancellations=0,signalEvents=0,releasePending;
  const c=createUIControl({workMs:15,stageMs:15,onCancel:()=>{cancelCalls++;cancellations++}});
  c.signal.addEventListener('abort',()=>{signalEvents++});
  const held=c.hold(()=>{}),pending=new Promise(resolve=>{releasePending=resolve}),watch=c.watch('stop while watching',pending);
  try{
    assert.equal(created.length,2,'one real work timer and one real stage timer');
    c.stop();c.stop();c.abort(new Error('SYNTHETIC_AFTER_STOP'));
    assert.ok(created.every(timer=>cleared.includes(timer)),'both actual controller timers must be cleared');
    await held;releasePending('original result');assert.equal(await watch,'original result');
    assert.equal(signalEvents,1);assert.equal(cancellations,0);assert.equal(c.cancelled,true);assert.throws(c.check,/UI_CANCELLED/);
  }finally{c.stop();for(const timer of created)nativeClear(timer)}
});
after(()=>console.log('Synthetic UI controller resources:',JSON.stringify({handlerCalls,cancelCalls,abortCalls,browserLaunches:0,httpRequests:0,postgresQueries:0,modelCalls:0,scope:'actual exported controller with shortened test-only limits; no browser/UI or real transport claim'})));
