// Explicit synthetic fixtures against real Express/HTTP/PostgreSQL. No models.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const os=require('node:os'),{execFileSync}=require('node:child_process');
const {Client}=require('pg');
const a=require('../scripts/memz_adapter');
const {submitProposal}=require('../../../scripts/proposal-client');
const {createSource}=require('../../../scripts/source-client');
const {readContext}=require('../../../scripts/context-client');
test('synthetic real-service memz benchmark adapter boundaries',async t=>{
  const adminURL=process.env.MEMORY_TEST_DATABASE_URL;
  assert.ok(adminURL,'Set MEMORY_TEST_DATABASE_URL to a disposable initialized PostgreSQL administrator connection');
  const admin=new Client({connectionString:adminURL}),db=`memz_memory_${crypto.randomBytes(8).toString('hex')}`;
  let owner,service,server,created=false;
  const evidence=process.env.MEMORY_TEST_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'memz-integration-'));
  if(process.env.MEMORY_TEST_OUTPUT){fs.mkdirSync(path.dirname(evidence),{recursive:true});fs.mkdirSync(evidence)}
  try{
    await admin.connect();await admin.query(`CREATE DATABASE ${db}`);created=true;
    const url=new URL(adminURL);url.pathname=`/${db}`;owner=new Client({connectionString:url.href});await owner.connect();
    await owner.query(fs.readFileSync(path.join(__dirname,'../../../db/schema.sql'),'utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    const ids=(await owner.query("INSERT INTO projects(name) VALUES('synthetic scope A'),('synthetic scope B') RETURNING id")).rows.map(r=>r.id);
    await owner.query("INSERT INTO memberships VALUES($1,1,'owner'),($1,2,'member'),($1,3,'viewer'),($2,4,'owner')",ids);
    url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;
    service=require('../../../server');server=await new Promise(resolve=>{const s=service.app.listen(0,'127.0.0.1',()=>resolve(s))});
    const baseURL=`http://127.0.0.1:${server.address().port}`,target={baseURL,projectId:ids[0]};
    const reader={username:'viewer',password:'demo-viewer'};
    const h={scope:'synthetic-a',documents:[{id:'D1',session_id:'S1',date:'2026-01-01',text:'Old color blue.'},
      {id:'D2',session_id:'S2',date:'2026-01-02',text:'Current color green.'}]};
    const imported=await a.ingestHistory(a.prepareHistory(h),target);
    assert.equal(imported.status,'prepared_for_review');const ingested=imported.artifact;
    async function decision(candidateId,action='approve'){
      const login=await fetch(`${baseURL}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'demo-owner'})});
      const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
      try{const r=await fetch(`${baseURL}/api/projects/${ids[0]}/candidates/${candidateId}/${action}`,{method:'POST',headers:{cookie,'x-csrf-token':csrf}});return r.status}
      finally{await fetch(`${baseURL}/api/logout`,{method:'POST',headers:{cookie,'x-csrf-token':csrf}})}
    }
    let serial=0;
    async function proposal(value,expectedVersion=0,{subject='color',source=0,action='approve'}={}){
      const p=await submitProposal({baseURL,proposal:{projectId:ids[0],sourceId:ingested.sources[source].sourceId,
        subject,predicate:'status',value,expectedVersion,idempotencyKey:`synthetic-benchmark-${++serial}`}});
      if(action)return {receipt:p,httpStatus:await decision(p.candidateId,action)};return {receipt:p};
    }
    const q={id:'q1',scope:'synthetic-a',question:'color'};
    let frozen;
    await t.test('history import writes sources only; review remains explicit',async()=>{
      assert.equal(imported.autoApproved,false);assert.equal(imported.candidatesCreated,0);
      assert.equal((await owner.query('SELECT count(*)::int n FROM candidates WHERE project_id=$1',ids.slice(0,1))).rows[0].n,0);
      const blank=await a.freezeApproved(ingested,reader);assert.equal(blank.status,'frozen');
      const row=await a.queryFrozen(blank.artifact,q,reader);assert.equal(row.provenance.length,0);assert.equal(row.answer,null);
    });
    await t.test('explicit synthetic approvals exclude old, pending, rejected and conflicting versions',async()=>{
      assert.equal((await proposal('blue')).httpStatus,200);
      assert.equal((await proposal('green',1,{source:1})).httpStatus,200);
      await proposal('PENDING_SENTINEL',2,{action:null});await proposal('REJECTED_SENTINEL',2,{action:'reject'});
      assert.equal((await proposal('STALE_SENTINEL',1)).httpStatus,409);
      const f=await a.freezeApproved(ingested,reader);assert.equal(f.status,'frozen');frozen=f.artifact;
      assert.equal(frozen.snapshot.facts[0].version,2);assert.equal(frozen.snapshot.facts[0].value,'green');
    });
    await t.test('memz_current uses product context and flat baseline uses the same approved facts',async()=>{
      const requests=[],cookies=[];
      const traced=async(url,opts)=>{requests.push(new URL(url).pathname);const r=await fetch(url,opts);if(new URL(url).pathname==='/api/login')cookies.push(r.headers.get('set-cookie').split(';')[0]);return r};
      const memz=await a.queryFrozen(frozen,q,reader,{fetchImpl:traced});
      const flat=await a.queryFrozen(frozen,q,reader,{method:'flat_same_facts'});
      assert.equal(memz.status,'context_ready_no_generation');assert.equal(flat.status,'context_ready_no_generation');
      assert.equal(memz.context,flat.context);assert.deepEqual(memz.retrievedDocumentIds,['D2']);assert.equal(memz.provenance[0].version,2);
      assert.equal(requests.filter(p=>p.endsWith('/context')).length,3);assert.equal(requests.length,15);
      assert.ok(memz.spans.some(s=>s.stage==='product_query_with_auth'));assert.equal(memz.modelCalls,0);assert.equal(memz.answerE2EMs,null);
      assert.ok(!/PENDING_SENTINEL|REJECTED_SENTINEL|STALE_SENTINEL|GOLD_SENTINEL/.test(memz.context));
      for(const cookie of cookies)assert.equal((await fetch(`${baseURL}/api/me`,{headers:{cookie}})).status,401);
      for(const [name,value] of [['batch.json',{frozen,queries:[q]}],['rows.json',[memz,flat]]])
        fs.writeFileSync(path.join(evidence,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
      // Gold is created only after the reader calls; only the Python evaluator opens it.
      fs.writeFileSync(path.join(evidence,'gold.private.jsonl'),JSON.stringify({id:q.id,answer:'GOLD_SENTINEL',evidence_ids:['D2']})+'\n',{flag:'wx',mode:0o600});
      execFileSync('python3',[path.join(__dirname,'../scripts/memz_score.py'),'--batch',path.join(evidence,'batch.json'),
        '--rows',path.join(evidence,'rows.json'),'--gold',path.join(evidence,'gold.private.jsonl'),'--output',path.join(evidence,'score.json')]);
      const score=JSON.parse(fs.readFileSync(path.join(evidence,'score.json')));
      assert.equal(score.summary.memz_current.evidence_recall,1);assert.equal(score.summary.memz_current.answer_accuracy,null);
    });
    await t.test('scope, account and live project authorization cannot be supplied by a query',async()=>{
      const other=await a.ingestHistory(a.prepareHistory({...h,scope:'synthetic-b'}),{baseURL,projectId:ids[1]},{username:'other',password:'demo-other'});
      assert.equal(other.status,'prepared_for_review');
      assert.equal((await a.queryFrozen(frozen,{...q,scope:'synthetic-b'},reader)).error.code,'INVALID_QUERY_FIELDS');
      assert.equal((await a.queryFrozen(frozen,q,{username:'other',password:'demo-other'})).error.code,'READER_BINDING_MISMATCH');
      // Seal the actual body, not an object containing an old hash.
      const {sha256:old,...body}=frozen.ingested;
      const forged=a.seal({...body,binding:{baseURL,projectId:ids[1]}});
      const {sha256:oldFrozen,...fbody}=frozen;
      const result=await a.queryFrozen(a.seal({...fbody,ingested:forged}),q,reader);
      assert.equal(result.error.httpStatus,403);assert.equal(result.context,null);
    });
    await t.test('no-match, excessive query, injected labels and context budget failures retain rows',async()=>{
      const empty=await a.queryFrozen(frozen,{...q,question:'no matching value'},reader);assert.equal(empty.status,'context_ready_no_generation');assert.equal(empty.provenance.length,0);
      for(const query of [{...q,question:'x'.repeat(201)},{...q,evidence_ids:['GOLD_SENTINEL']},{...q,answer:'GOLD_SENTINEL'}]){
        const row=await a.queryFrozen(frozen,query,reader);assert.equal(row.status,'error');assert.equal(row.context,null);assert.equal(row.error.code,'INVALID_QUERY_FIELDS');
      }
      assert.equal((await a.queryFrozen(frozen,q,reader,{maxContextBytes:1})).error.code,'CONTEXT_BUDGET_EXCEEDED');
    });
    await t.test('malformed provenance and source page omissions/duplicates fail closed (HTTP fault injection)',async()=>{
      for(const fault of ['proof','omission','duplicate']){
        const fetchImpl=async(url,opts)=>{const r=await fetch(url,opts),u=new URL(url);
          if(fault==='proof'&&u.pathname.endsWith('/context')&&u.searchParams.get('q')==='color'){
            const data=await r.json();data.provenance[0].revision.version++;return Response.json(data,{headers:r.headers});
          }
          if(fault!=='proof'&&u.pathname.endsWith('/sources')){
            const data=await r.json();if(fault==='omission')data.next_after=data.sources.at(-1).id;else data.sources.push(data.sources[0]);return Response.json(data,{headers:r.headers});
          }return r;
        };
        const row=await a.queryFrozen(frozen,q,reader,{fetchImpl});assert.equal(row.status,'error');assert.equal(row.context,null);
      }
    });
    await t.test('source changes and new source rows after freeze are rejected',async()=>{
      const sourceId=ingested.sources[1].sourceId;
      await owner.query("UPDATE sources SET content='synthetic out-of-band drift' WHERE id=$1",[sourceId]);
      assert.equal((await a.queryFrozen(frozen,q,reader)).error.code,'SOURCE_DRIFT');
      await owner.query('UPDATE sources SET content=$1 WHERE id=$2',[h.documents[1].text,sourceId]);
      const source=await createSource({baseURL,source:{projectId:ids[0],title:'new synthetic source',content:'new text',idempotencyKey:'synthetic-extra'}});
      assert.equal((await a.queryFrozen(frozen,q,reader)).error.code,'UNREGISTERED_SOURCE');
      await owner.query('DELETE FROM sources WHERE id=$1',[source.sourceId]);
    });
    await t.test('approval between retrieval and final validation invalidates the complete row',async()=>{
      let changed=false;
      const fetchImpl=async(url,opts)=>{const r=await fetch(url,opts),u=new URL(url);
        if(!changed&&u.pathname.endsWith('/context')&&u.searchParams.get('q')==='color'){changed=true;assert.equal((await proposal('late-green',2,{source:1})).httpStatus,200)}return r;
      };
      const row=await a.queryFrozen(frozen,q,reader,{fetchImpl});assert.ok(changed);assert.equal(row.error.code,'FROZEN_STATE_DRIFT');assert.equal(row.context,null);
      assert.equal((await a.queryFrozen(frozen,q,reader)).error.code,'FROZEN_STATE_DRIFT');
    });
    await t.test('newly approved facts invalidate a prior frozen set',async()=>{
      const fresh=await a.freezeApproved(ingested,reader);assert.equal(fresh.status,'frozen');
      assert.equal((await proposal('new-value',0,{subject:'new-field'})).httpStatus,200);
      assert.equal((await a.queryFrozen(fresh.artifact,q,reader)).error.code,'FROZEN_STATE_DRIFT');
    });
    await t.test('approval during freeze is detected between the two bounded scans',async()=>{
      let reads=0;
      const fetchImpl=async(url,opts)=>{const u=new URL(url);
        if(u.pathname.endsWith('/context')&&u.searchParams.get('q')===''&&++reads===2){
          assert.equal((await proposal('freeze-drift',3,{source:1})).httpStatus,200);
        }return fetch(url,opts);
      };
      const result=await a.freezeApproved(ingested,reader,{fetchImpl});assert.equal(result.error.code,'FREEZE_DRIFT');assert.equal(result.artifact,undefined);
    });
    await t.test('more than 25 approved facts refuses freezing instead of treating pages as one snapshot',async()=>{
      for(let i=0;i<24;i++)assert.equal((await proposal(`value-${i}`,0,{subject:`synthetic-${i}`})).httpStatus,200);
      const result=await a.freezeApproved(ingested,reader);assert.equal(result.status,'error');assert.equal(result.error.code,'FACT_PAGE_LIMIT');assert.equal(result.artifact,undefined);
    });
  }finally{
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});if(service)await service.pool.end();if(owner)await owner.end();
    if(created)await admin.query(`DROP DATABASE ${db}`);await admin.end();
    if(!process.env.MEMORY_TEST_OUTPUT)fs.rmSync(evidence,{recursive:true,force:true});
  }
});
