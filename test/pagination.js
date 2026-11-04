const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {app,pool,tx,decide}=require('../server');
const server=app.listen(0,'127.0.0.1');
const listening=require('node:events').once(server,'listening');
const cookies={},expected=[['项目','截止日','20号']];
after(async()=>{await new Promise(r=>server.close(r));await pool.end()});
async function create(subject,value,{user=1,project=1,source=2,version=0,decision='approve'}={}){
  await tx(user,async c=>{
    const id=(await c.query("INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by) VALUES($1,$2,'状态',$3,$4,$5,$6) RETURNING id",[project,subject,value,source,version,user])).rows[0].id;
    if(decision)await decide(c,user,project,id,decision);
  });
}
async function get(query='',user='owner',project=1){
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${project}/facts${query}`,{headers:{cookie:cookies[user]}});
  return {status:r.status,body:await r.json()};
}
async function all(query='',limit=7){
  const rows=[];let cursor=0,pages=0;
  do{
    const {status,body}=await get(`?q=${encodeURIComponent(query)}&limit=${limit}&after=${cursor}`);assert.equal(status,200);
    assert.deepEqual(Object.keys(body).sort(),['facts','next_after','role']);assert.ok(body.facts.length<=limit);
    for(const row of body.facts){assert.ok(row.id>cursor);cursor=row.id;rows.push(row)}
    if(body.next_after===null)break;
    assert.ok(body.facts.length>0);assert.equal(body.next_after,cursor);assert.ok(++pages<100);
  }while(true);
  assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);return rows;
}
before(async()=>{
  await listening;
  for(const name of ['owner','viewer','other']){
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:name,password:`demo-${name}`})});
    assert.equal(r.status,200);cookies[name]=r.headers.get('set-cookie').split(';')[0];await r.json();
  }
  for(let i=0;i<125;i++){
    const subject=`分页条目${String(i).padStart(4,'0')}`,value=`分页内容${i}${i===0?' 100%_':''}`;
    await create(subject,value);expected.push([subject,'状态',value]);
  }
  await create('版本对照','旧版本分页词');await create('版本对照','新版本分页词',{version:1});expected.push(['版本对照','状态','新版本分页词']);
  await create('待审对照','待审分页词',{decision:null});await create('驳回对照','驳回分页词',{decision:'reject'});
  await create('隔离对照','独立分页秘密',{user:4,project:2,source:4});
});
test('bounded defaults and complete cursor traversal preserve every current fact without duplicates',async()=>{
  const first=await get();assert.equal(first.status,200);assert.equal(first.body.facts.length,50);assert.equal(first.body.next_after,first.body.facts.at(-1).id);
  const rows=await all();assert.deepEqual(rows.map(r=>[r.subject,r.predicate,r.value]),expected);
  const max=await get('?limit=100');assert.equal(max.body.facts.length,100);
});
test('paged keyword matching excludes old, pending, rejected and foreign facts',async()=>{
  for(const q of ['旧版本分页词','待审分页词','驳回分页词','独立分页秘密'])assert.deepEqual(await all(q),[]);
  assert.equal((await all('新版本分页词')).length,1);
  for(const q of ['%','_','分页条目0124'])assert.equal((await all(q)).length,1);
  assert.equal((await all('状态',100)).length,126);
});
test('optional context response omits facts while legacy aggregate remains compatible',async()=>{
  async function context(query,user='owner'){
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/projects/1/data${query}`,{headers:{cookie:cookies[user]}});
    return {status:r.status,body:await r.json()};
  }
  const full=await context(''),explicit=await context('?include_facts=true'),contextOnly=await context('?include_facts=false');
  assert.equal(full.status,200);assert.ok(full.body.facts.length>100);assert.deepEqual(explicit,full);
  const {facts,...rest}=full.body;assert.deepEqual(contextOnly.body,rest);assert.equal(contextOnly.status,200);
  assert.equal((await context('?include_facts=false','other')).status,403);
  for(const q of ['?include_facts=no','?include_facts=false&include_facts=true'])assert.equal((await context(q)).status,400);
});
test('viewer access and project isolation remain enforced on every page',async()=>{
  const owner=await get('?limit=7'),viewer=await get('?limit=7','viewer');assert.equal(viewer.status,200);assert.equal(viewer.body.role,'viewer');assert.deepEqual(viewer.body.facts,owner.body.facts);
  assert.equal((await get('?after=1','other')).status,403);
  const other=await get('','other',2);assert.equal(other.status,200);assert.equal(other.body.facts.length,1);assert.equal(other.body.facts[0].value,'独立分页秘密');assert.equal(other.body.next_after,null);
});
test('invalid cursors, limits and repeated query parameters fail; empty/high cursors terminate',async()=>{
  for(const query of ['?limit=0','?limit=101','?limit=-1','?limit=1.5','?limit=1e2','?limit=','?limit=2&limit=3','?after=-1','?after=2147483648','?after=1e0','?after=','?after=2&after=3','?q=a&q=b'])assert.equal((await get(query)).status,400,query);
  assert.deepEqual((await get('?after=0')).body,(await get()).body);
  const end=await get('?after=2147483647');assert.equal(end.status,200);assert.deepEqual(end.body.facts,[]);assert.equal(end.body.next_after,null);
});
test('higher-ID inserts between pages do not repeat rows and appear on later pages',async()=>{
  const first=(await get('?q=分页条目&limit=100')).body;
  await create('分页条目新增','并发新增');
  const second=(await get(`?q=分页条目&limit=100&after=${first.next_after}`)).body;
  const combined=[...first.facts,...second.facts];assert.equal(combined.length,126);assert.equal(new Set(combined.map(r=>r.id)).size,126);
  assert.ok(second.facts.some(r=>r.subject==='分页条目新增'));assert.equal(second.next_after,null);
});

async function history(query='',user='owner',project=1){
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${project}/history${query}`,{headers:{cookie:cookies[user]}});
  return {status:r.status,body:await r.json()};
}
test('history pages exactly reproduce legacy order and optional omission preserves other sections',async()=>{
  const base=`http://127.0.0.1:${server.address().port}/api/projects/1/data`;
  const read=async q=>{const r=await fetch(base+q,{headers:{cookie:cookies.owner}});assert.equal(r.status,200);return r.json()};
  const full=await read(''),without=await read('?include_facts=false&include_history=false');
  const {facts,history:expected,...rest}=full;assert.deepEqual(without,rest);
  assert.deepEqual(await read('?include_history=true'),full);
  assert.equal((await history()).body.history.length,25);
  assert.equal((await history('?limit=100')).body.history.length,100);
  const rows=[];let before=null;
  do{
    const {status,body}=await history(`?limit=13${before===null?'':`&before=${before}`}`);assert.equal(status,200);
    assert.deepEqual(Object.keys(body).sort(),['history','next_before','role']);assert.ok(body.history.length<=13);
    for(const row of body.history){if(before!==null)assert.ok(row.id<before);before=row.id;rows.push(row)}
    if(body.next_before===null)break;
    assert.equal(body.next_before,before);assert.ok(rows.length<1000);
  }while(true);
  assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);
  assert.deepEqual(rows.map(({id,...r})=>r),expected);
  const viewer=await history('','viewer');assert.equal(viewer.status,200);assert.equal(viewer.body.role,'viewer');
  assert.deepEqual(viewer.body.history,(await history()).body.history);
  assert.equal((await history('','other')).status,403);
  assert.equal((await history('','other',2)).body.history.length,1);
  assert.deepEqual((await history('?before=1')).body.history,[]);
  assert.equal((await history('?before=1')).body.next_before,null);
  for(const q of ['?limit=0','?limit=101','?limit=1e2','?limit=1&limit=2','?before=0','?before=-1','?before=1.5','?before=2147483648','?before=','?before=2&before=3'])assert.equal((await history(q)).status,400,q);
  for(const q of ['?include_history=no','?include_history=false&include_history=true'])assert.equal((await fetch(base+q,{headers:{cookie:cookies.owner}})).status,400);
});
test('new revisions between descending history pages do not shift older pages; refresh sees the new revision',async()=>{
  const first=(await history()).body;
  const oldSecond=(await history(`?before=${first.next_before}`)).body;
  await create('历史翻页期间','新修订');
  const second=(await history(`?before=${first.next_before}`)).body;
  assert.deepEqual(second,oldSecond);
  assert.equal(new Set([...first.history,...second.history].map(r=>r.id)).size,50);
  const latest=(await history()).body;assert.equal(latest.history[0].subject,'历史翻页期间');assert.ok(latest.history[0].id>first.history[0].id);
});
