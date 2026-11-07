const {inspectSetupCatalog}=require('./setup-catalog');
function statusJSON(req,res,status,value){
  // res.json/send would apply Express freshness/ETag handling. A probe is a
  // new observation even when the caller supplies If-None-Match or HEAD.
  const body=JSON.stringify({status:value});
  res.statusCode=status;
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Content-Length',Buffer.byteLength(body));
  res.end(req.method==='HEAD'?undefined:body);
}
function createHealthProbes(tx){
  return {
    live:(req,res)=>statusJSON(req,res,200,'alive'),
    ready:async(req,res)=>{
      let ready=false;
      try{
        const result=await tx('',inspectSetupCatalog,{snapshot:true});
        ready=result.code==='BASIC_CHECKS_PASSED';
      }catch{}
      statusJSON(req,res,ready?200:503,ready?'ready':'not_ready');
    }
  };
}
module.exports={createHealthProbes};
