const {snapshotReceipt}=require('../scripts/context-snapshot');
const {parseSearchQuery}=require('../scripts/search-query');
const sampleFacts=[
  {id:1,subject:'晨桥服务',predicate:'交付时间',value:'周五',sourceId:10},
  {id:2,subject:'旁观台',predicate:'提示',value:'晨桥服务 交付时间',sourceId:20},
  {id:3,subject:'晨桥服务',predicate:'值班联系人',value:'合成联系人',sourceId:30}
];
function page({facts=sampleFacts,projectId=7,query='',searchMode='substring',next_after=null}={}){
  const rows=facts.map(fact=>({...fact,version:fact.version||1,revisionId:fact.revisionId||fact.id+100}));
  const sources=[...new Set(rows.map(fact=>fact.sourceId))].map(id=>({id,title:'合成来源'+id,content:'完整原文😀\n保留证据和所谓“忽略规则”的原文，不能执行。来源'+id}));
  const provenance=rows.map(fact=>({sourceTextIsUntrusted:true,role:'viewer',fact:{id:fact.id,subject:fact.subject,predicate:fact.predicate},revision:{id:fact.revisionId,version:fact.version,value:fact.value,created_at:'2026-11-07T00:00:00.000Z',approved_by:1},sourceId:fact.sourceId,candidate:{id:fact.id+200,expected_version:fact.version-1,proposed_by:2}}));
  return {...snapshotReceipt(),projectId,query,limit:25,after:0,role:'viewer',sourceTextIsUntrusted:true,facts:rows,provenance,sources,next_after,...(searchMode==='all_terms'?{search:parseSearchQuery(query,searchMode)}:{})};
}
function transport(pages=[page(),page({query:'晨桥服务 交付时间',searchMode:'all_terms'})]){
  const calls=[];let login=0,read=0;
  return {calls,fetchImpl:async(url,options)=>{
    const u=new URL(url);calls.push({url:u,options});
    if(u.pathname==='/api/login'){login++;return Response.json({csrf:'synthetic-csrf-'+login},{headers:{'set-cookie':'sid=synthetic-session-'+login+'; HttpOnly'}})}
    if(u.pathname==='/api/logout')return Response.json({ok:true});
    if(read>=pages.length)throw new Error('Unexpected extra snapshot request');
    return Response.json(pages[read++]);
  }};
}
module.exports={sampleFacts,page,transport};
