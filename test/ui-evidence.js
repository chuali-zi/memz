const fs=require('node:fs');
const crypto=require('node:crypto');
const {Client}=require('pg');
const {runUI}=require('./ui');
async function main(){
  if(!process.env.UI_TEST_DATABASE_URL)throw new Error('Set UI_TEST_DATABASE_URL to an initialized test PostgreSQL administrator connection.');
  const admin=new Client({connectionString:process.env.UI_TEST_DATABASE_URL});await admin.connect();
  const db=`memz_ui_${crypto.randomBytes(8).toString('hex')}`;
  let created=false,owner,pool,server;
  try{
    await admin.query(`CREATE DATABASE ${db}`);created=true;
    console.log(`UI fixture database: ${db}`);
    const url=new URL(process.env.UI_TEST_DATABASE_URL);url.pathname=`/${db}`;
    owner=new Client({connectionString:url.href});await owner.connect();
    await owner.query(fs.readFileSync('db/schema.sql','utf8').replace(/^CREATE ROLE memz_app .*;\r?\n/m,''));
    url.username='memz_app';url.password='memz_demo_only';process.env.DATABASE_URL=url.href;
    const service=require('../server');pool=service.pool;
    server=await new Promise(resolve=>{const s=service.app.listen(0,'127.0.0.1',()=>resolve(s))});
    await runUI({baseURL:`http://127.0.0.1:${server.address().port}`,executablePath:process.env.CHROMIUM_PATH||null,
      databaseVersion:(await owner.query('SHOW server_version')).rows[0].server_version,
      prepareSources:async({signal}={})=>{
        signal?.throwIfAborted();
        await service.tx(1,c=>c.query("INSERT INTO sources(project_id,title,content) SELECT 1,'来源演示'||lpad(n::text,2,'0'),repeat('X',4000) FROM generate_series(0,54) n"));
        signal?.throwIfAborted();
      },
      preparePagination:async({signal}={})=>{
        for(let i=0;i<55;i++){
          signal?.throwIfAborted();
          await service.tx(1,async c=>{
          const id=(await c.query("INSERT INTO candidates(project_id,subject,predicate,value,source_id,expected_version,proposed_by) VALUES(1,$1,'状态','合成分页事实',2,0,1) RETURNING id",[`分页演示${String(i).padStart(2,'0')}`])).rows[0].id;
          await service.decide(c,1,1,id,'approve');
          });
        }
        signal?.throwIfAborted();
      }});
  }finally{
    if(server)await new Promise((resolve,reject)=>{
      server.close(e=>e?reject(e):resolve());
      // runUI has finished or failed: this wrapper owns every fixture socket,
      // including speculative peers that native closeIdleConnections misses.
      server.closeAllConnections?.();
    });
    if(pool)await pool.end();if(owner)await owner.end();
    if(created)await admin.query(`DROP DATABASE ${db}`);
    await admin.end();
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
