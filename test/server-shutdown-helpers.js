const {spawn}=require('node:child_process');

async function startChild(args,env={}){
  const child=spawn(process.execPath,args,{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,...env},stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='',result;
  const messages=[];child.on('message',message=>messages.push(message));
  const watchdog=setTimeout(()=>child.kill('SIGKILL'),35000);
  child.once('exit',(code,signal)=>{result={code,signal}});
  const exit=new Promise(resolve=>child.once('close',()=>{clearTimeout(watchdog);resolve(result)}));
  child.stderr.on('data',data=>stderr+=data);
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Shutdown test app did not start')),10000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Shutdown test app failed to start'))});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Shutdown test app exited before startup'))});
    child.stdout.on('data',data=>{stdout+=data;const match=stdout.match(/Memz (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1])}});
  });
  try{
    const base=await ready;
    return {child,base,exit,messages,stdout:()=>stdout,stderr:()=>stderr,result:()=>result,
      waitFor:async(predicate,timeout=5000)=>{
        const limit=Date.now()+timeout;
        while(!predicate()){
          if(result)throw new Error('Shutdown test app exited before the expected event');
          if(Date.now()>=limit)throw new Error('Shutdown test event timed out');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
      },
      stop:async()=>{if(!result)child.kill('SIGKILL');await exit}
    };
  }catch(error){if(!result)child.kill('SIGKILL');await exit;throw error}
}
module.exports={startChild};
