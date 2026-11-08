'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {temporaryDatabase} = require('../cve/test/temporary-db');
const {importDocument} = require('../cve/store');
const {search, evidenceContext} = require('../cve/query');
const cve = require('../cve/test/fixtures/cve5.json');
async function main() {
  const report = await temporaryDatabase(process.env.CVE_TEST_DATABASE_URL, async pool => {
    for (const [source, raw] of [['cvelist',cve],['nvd',require('../cve/test/fixtures/nvd.json')],['ghsa',require('../cve/test/fixtures/ghsa.json')],['kev',require('../cve/test/fixtures/kev.json')]]) await importDocument(pool,source,raw);
    const second = structuredClone(cve);second.cveMetadata.cveId='CVE-2099-10002';
    second.containers={cna:{title:'SYNTHETIC portal reflected script',descriptions:[{lang:'en',value:'Synthetic reflected cross-site scripting in portal output.'}],affected:[{vendor:'OtherVendor',product:'ExamplePortal'}],problemTypes:[{descriptions:[{cweId:'CWE-79'}]}]}};
    await importDocument(pool,'cvelist',second);
    const rejected = structuredClone(second);rejected.cveMetadata.cveId='CVE-2099-10003';rejected.cveMetadata.state='REJECTED';rejected.containers.cna.rejectedReasons=[{lang:'en',value:'Synthetic duplicate'}];
    await importDocument(pool,'cvelist',rejected);
    const cases=[];
    for (const entry of require('../cve/test/evaluation-cases.json')) {
      const start=performance.now(), result=await search(pool,entry.query), elapsed=performance.now()-start;
      const actual=result.items.map(row=>row.cve_id);
      let passed=true;
      try {assert.deepEqual(actual,entry.expected);if(entry.version_assessment)assert.equal(result.version_assessment,entry.version_assessment);}catch{passed=false;}
      const context=evidenceContext(result);
      cases.push({...entry,actual,passed,elapsed_ms:+elapsed.toFixed(3),output_bytes:Buffer.byteLength(JSON.stringify(context)),citations:context.citations.length});
    }
    return {kind:'synthetic_contract_evaluation',generated_at:new Date().toISOString(),node:process.version,
      postgres:(await pool.query('SHOW server_version')).rows[0].server_version,
      corpus:{cves:3,source_records:6,synthetic:true},passed:cases.filter(c=>c.passed).length,total:cases.length,cases,
      limitations:'Hand-authored fixtures and golden cases only. No semantic quality, real-model, target-vulnerability or production-scale performance claim.'};
  });
  const directory=path.resolve(__dirname,'..','artifacts','cve');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'evaluation.json'),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(report.passed!==report.total)process.exitCode=1;
}
if(require.main===module)main().catch(()=>{process.stderr.write('CVE_EVALUATION_FAILED\n');process.exitCode=1;});
