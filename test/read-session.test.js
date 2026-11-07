const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readContext}=require('../scripts/context-client');
test('response size remains the primary failure when cancelling an oversized body rejects',async()=>{
  const paths=[];let cancelled=0;
  await assert.rejects(()=>readContext({maxResponseBytes:64,fetchImpl:async(url)=>{
    const path=new URL(url).pathname;paths.push(path);
    if(path==='/api/login')return Response.json({csrf:'synthetic'},{headers:{'set-cookie':'sid=synthetic; HttpOnly'}});
    if(path==='/api/logout')return Response.json({ok:true});
    return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(65))},cancel(){cancelled++;throw new Error('synthetic-private-cancel-error')}}));
  }}),error=>error.code==='RESPONSE_TOO_LARGE'&&error.message==='RESPONSE_TOO_LARGE'&&error.cause===undefined);
  assert.equal(cancelled,1);assert.deepEqual(paths,['/api/login','/api/projects/1/facts','/api/logout']);
});
test('an errored response stream remains a fixed JSON failure and still closes transport and logs out',async()=>{
  const paths=[],signals=[];
  await assert.rejects(()=>readContext({fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname;paths.push(path);signals.push(options.signal);
    if(path==='/api/login')return Response.json({csrf:'synthetic'},{headers:{'set-cookie':'sid=synthetic; HttpOnly'}});
    if(path==='/api/logout')return Response.json({ok:true});
    return new Response(new ReadableStream({start(controller){controller.error(new Error('synthetic-private-stream-error'))}}));
  }}),error=>error.code==='INVALID_JSON_RESPONSE'&&error.message==='INVALID_JSON_RESPONSE'&&error.cause===undefined);
  assert.deepEqual(paths,['/api/login','/api/projects/1/facts','/api/logout']);assert.ok(signals.every(signal=>signal.aborted));
});
test('a failed HTTP status remains primary when cancelling its error body rejects',async()=>{
  const paths=[];let cancelled=0;
  await assert.rejects(()=>readContext({fetchImpl:async(url)=>{
    const path=new URL(url).pathname;paths.push(path);
    if(path==='/api/login')return Response.json({csrf:'synthetic'},{headers:{'set-cookie':'sid=synthetic; HttpOnly'}});
    if(path==='/api/logout')return Response.json({ok:true});
    return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1))},cancel(){cancelled++;throw new Error('synthetic-private-cancel-error')}}),{status:503});
  }}),error=>error.code==='HTTP_503'&&error.status===503&&error.message==='HTTP_503'&&error.cause===undefined);
  assert.equal(cancelled,1);assert.deepEqual(paths,['/api/login','/api/projects/1/facts','/api/logout']);
});
