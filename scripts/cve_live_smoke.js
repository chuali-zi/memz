'use strict';
// Explicit network smoke test; downloaded raw records stay only in a random temporary DB.
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const fs = require('node:fs/promises');
const path = require('node:path');
const {temporaryDatabase} = require('../cve/test/temporary-db');
const {createDownloader} = require('../cve/sync');
const {importDocument} = require('../cve/store');
const {search,evidenceContext} = require('../cve/query');
const {digest} = require('../cve/normalize');
async function head(repository) {
  const {stdout}=await exec('git',['ls-remote',`https://github.com/${repository}.git`,'refs/heads/main'],{windowsHide:true,timeout:30000});
  const commit=stdout.split(/\s/)[0];if(!/^[a-f0-9]{40,64}$/.test(commit))throw new Error('INVALID_SOURCE_COMMIT');return commit;
}
async function main() {
  if(process.argv.slice(2).join(' ')!=='--allow-network')throw new Error('ALLOW_NETWORK_REQUIRED');
  const report=await temporaryDatabase(process.env.CVE_TEST_DATABASE_URL,async pool=>{
    const pins=await Promise.all([head('CVEProject/cvelistV5'),head('github/advisory-database')]);
    const inputs=[
      ['cvelist',`https://raw.githubusercontent.com/CVEProject/cvelistV5/${pins[0]}/cves/2021/44xxx/CVE-2021-44228.json`],
      ['ghsa',`https://raw.githubusercontent.com/github/advisory-database/${pins[1]}/advisories/github-reviewed/2021/12/GHSA-jfh8-c2jp-5v3q/GHSA-jfh8-c2jp-5v3q.json`],
      ['nvd','https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-44228'],
      ['kev','https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'],
      ['circl','https://vulnerability.circl.lu/api/vulnerability/CVE-2021-44228']
    ];
    const results=await Promise.allSettled(inputs.map(async ([source,url])=>{
      const raw=await createDownloader()(url);
      // KEV download is a complete catalog, but import only the selected smoke-test CVE.
      const selected=source==='kev'?{...raw,vulnerabilities:raw.vulnerabilities.filter(v=>v.cveID==='CVE-2021-44228')}:raw;
      if(source==='kev'&&!selected.vulnerabilities.length)throw new Error('LIVE_KEV_ID_MISSING');
      const counts=await importDocument(pool,source,selected,{sourceURL:url});
      return {source,url,download_sha256:digest(raw),status:'passed',counts};
    }));
    const sources=results.map((r,i)=>r.status==='fulfilled'?r.value:{source:inputs[i][0],url:inputs[i][1],status:'failed',error:/^[A-Z][A-Z_0-9]{0,63}$/.test(r.reason.message)?r.reason.message:'LIVE_SOURCE_FAILED'});
    const result=await search(pool,{id:'CVE-2021-44228'}),context=evidenceContext(result);
    return {kind:'live_public_source_smoke',generated_at:new Date().toISOString(),sources,
      cve_ids:result.items.map(i=>i.cve_id),context_bytes:Buffer.byteLength(JSON.stringify(context)),citations:context.citations.length,
      context_within_64k:Buffer.byteLength(JSON.stringify(context))<=65536,
      limitations:'Single known CVE only. No bulk ingestion, live incremental-history completeness, model/embedding quality or pentest-tools integration claim.'};
  });
  const directory=path.resolve(__dirname,'..','artifacts','cve');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'live-smoke.json'),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(report.sources.some(s=>s.status!=='passed')||!report.context_within_64k||!report.cve_ids.length)process.exitCode=1;
}
if(require.main===module)main().catch(error=>{process.stderr.write((/^[A-Z][A-Z_0-9]{0,63}$/.test(error.message)?error.message:'CVE_LIVE_SMOKE_FAILED')+'\n');process.exitCode=1;});
