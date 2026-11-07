// Audit-only observation, loaded into owned test processes. No raw parameters,
// credentials, cookies, CSRF, HTTP headers or response bodies are recorded.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const req=Module.createRequire(path.join(process.env.AUDIT_WORKTREE,'package.json'));
const {Client}=req('pg');
const metricFile=process.env.AUDIT_PREFIX+'.'+process.pid+'.json',journal=process.env.AUDIT_PREFIX+'.journal.jsonl';
const metric={pid:process.pid,sqlUtf8:0,parameterJson:0,resultRowsJson:0,httpRequestBody:0,httpResponseBody:0,httpRequests:0,cleanupBytes:0,violations:[],unsupported:0};
const reserve=65536,limit=Number(process.env.AUDIT_BYTE_ALLOWANCE),httpLimit=Number(process.env.AUDIT_HTTP_ALLOWANCE);
const total=()=>metric.sqlUtf8+metric.parameterJson+metric.resultRowsJson+metric.httpRequestBody+metric.httpResponseBody;
const save=()=>fs.writeFileSync(metricFile,JSON.stringify({...metric,totalApplicationBytes:total()}),{mode:0o600});
function charge(field,bytes,cleanup=false){metric[field]+=bytes;if(cleanup)metric.cleanupBytes+=bytes;save();if((cleanup&&metric.cleanupBytes>reserve)||(!cleanup&&total()-metric.cleanupBytes>limit)){metric.violations.push('APPLICATION_BYTE_LIMIT');save();throw Object.assign(new Error('AUDIT_APPLICATION_BYTE_LIMIT'),{code:'AUDIT_LIMIT'})}}
const event=(kind,database)=>fs.appendFileSync(journal,JSON.stringify({kind,database,pid:process.pid})+'\n',{mode:0o600});
const original=Client.prototype.query;
Client.prototype.query=function(...args){
  const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
  if(typeof sql!=='string'){metric.unsupported++;save();return original.apply(this,args)}
  const cleanup=sql==='ROLLBACK'||/^DROP DATABASE memz_[a-z0-9_]+ WITH \(FORCE\)$/.test(sql);
  const values=Array.isArray(args[1])?args[1]:[];
  charge('sqlUtf8',Buffer.byteLength(sql),cleanup);charge('parameterJson',Buffer.byteLength(JSON.stringify(values)),cleanup);
  const receive=result=>{
    const created=sql.match(/^CREATE DATABASE (memz_[a-z0-9_]+)$/),dropped=sql.match(/^DROP DATABASE (memz_[a-z0-9_]+) WITH \(FORCE\)$/);
    // Record ownership before result accounting can fail.
    if(created)event('created',created[1]);if(dropped)event('dropped',dropped[1]);
    charge('resultRowsJson',Buffer.byteLength(JSON.stringify(Array.isArray(result)?result.map(row=>row.rows):result.rows)),cleanup);return result;
  };
  if(typeof args.at(-1)==='function'){
    const callback=args.at(-1);args[args.length-1]=function(error,result){if(error)return callback.call(this,error,result);try{receive(result)}catch(problem){return callback.call(this,problem)}return callback.call(this,error,result)};
    return original.apply(this,args);
  }
  const pending=original.apply(this,args);return pending?.then?pending.then(receive):pending;
};
const fetchNative=globalThis.fetch;
globalThis.fetch=async function(url,options={}){
  if(++metric.httpRequests>httpLimit){metric.violations.push('HTTP_LIMIT');save();throw Object.assign(new Error('AUDIT_HTTP_LIMIT'),{code:'AUDIT_LIMIT'})}
  charge('httpRequestBody',options.body===undefined?0:Buffer.byteLength(options.body));
  const response=await fetchNative(url,options),text=response.text.bind(response);
  response.text=async()=>{const value=await text();charge('httpResponseBody',Buffer.byteLength(value));return value};
  response.json=async()=>JSON.parse(await response.text());return response;
};
process.on('exit',save);save();
