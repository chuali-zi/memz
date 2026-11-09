'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseTreeQuery, buildTreeQuery} = require('../tree');
const {parseQuery, buildQuery, evidenceContext} = require('../query');
const {capabilities} = require('../taxonomy');
const {readCapabilities, readTree, readObservation, readContext} = require('../client');
const service = 'a'.repeat(64);
const cursor = (scope, key, v = 1) => Buffer.from(JSON.stringify({v, scope, key})).toString('base64url');

test('discovery describes the whole read-only evidence workflow and disabled strategy honestly', () => {
  const value = capabilities();
  assert.equal(value.domain, 'vulnerability_knowledge_and_cve_details');
  assert.deepEqual(value.workflow.map(s => s.tool), ['cve_capabilities','cve_browse_tree','cve_read_context','cve_read_observation']);
  assert.equal(value.modes.natural_language.enabled, false);
  assert.equal(value.modes.lexical.semantics, 'simple_all_terms');
  assert.equal(value.limits.version_verdict, false);
  assert.notEqual(value.stacks.sql, 'SQL 注入');
  assert.deepEqual(value.product_aliases, {ngix: 'nginx'});
});

test('tree query requires parent scope, explicit aliases and bounded well-formed input', () => {
  assert.deepEqual(parseTreeQuery(), {limit: 10});
  assert.equal(parseTreeQuery({stack: 'web', product: ' NGIX '}).product, 'nginx');
  assert.equal(parseTreeQuery({stack: 'web', product: 'constructor'}).product, 'constructor');
  assert.equal(parseQuery({product: 'ngix'}).product, 'ngix');
  for (const input of [null, [], {service}, {product:'nginx'}, {stack:'unknown'}, {stack:'sql',cwe:'CWE-89'},
    {stack:'web',service,product:'nginx'}, {stack:'web',service:'bad'}, {limit:'0'}, {limit:'51'}, {limit:1},
    {product:['nginx']}, {stack:'web',product:'\ud800'}, {after:'!'}, {unknown:'x'}]) {
    assert.throws(() => parseTreeQuery(input), /INVALID_QUERY/, JSON.stringify(input));
  }
});

test('tree cursors are validated by level and query scope rather than reusable across branches', () => {
  assert.equal(parseTreeQuery({after:cursor([null,null,null], 'java')}).cursor_key, 'java');
  assert.equal(parseTreeQuery({stack:'web',after:cursor(['web',null,null], service)}).cursor_key, service);
  assert.equal(parseTreeQuery({stack:'web',service,after:cursor(['web',service,null], 'unclassified')}).cursor_key, 'unclassified');
  for (const input of [
    {stack:'sql',after:cursor(['web',null,null], service)},
    {stack:'web',product:'nginx',after:cursor(['web',null,null], service)},
    {after:cursor([null,null,null], service)},
    {stack:'web',after:cursor(['web',null,null], 'CWE-89')},
    {stack:'web',service,after:cursor(['web',service,null], 'unknown')},
    {after:cursor([null,null,null], 'web', 2)},
    {after:Buffer.from('not JSON').toString('base64url')}
  ]) assert.throws(() => parseTreeQuery(input), /INVALID_QUERY/);
});

test('tree/structured SQL binds input and joins product/CWE to one current source', () => {
  const attack = "x');DROP SCHEMA cve CASCADE;--";
  const tree = buildTreeQuery(parseTreeQuery({stack:'other',product:attack,limit:'1'}));
  assert.ok(!tree.text.includes(attack)); assert.ok(tree.values.includes(attack.toLowerCase()));
  assert.equal(tree.values.at(-1), 2);
  assert.match(tree.text, /count\(DISTINCT f.cve_id\)/);
  const context = buildQuery(parseQuery({stack:'web',service,cwe:'CWE-89'}));
  assert.match(context.text, /f.source=r.source AND f.source_id=r.source_id AND f.cve_id=r.cve_id/);
  assert.ok(context.values.includes(service));
});

test('strategy and missing evidence contracts distinguish rules, source facts and target verdicts', () => {
  assert.throws(() => parseQuery({mode:'natural_language',q:'what affects my server'}), e => e.status === 501 && e.message === 'RETRIEVAL_MODE_NOT_IMPLEMENTED');
  for (const input of [{mode:'unknown',q:'x'}, {mode:'tree',product:'x'}, {mode:'lexical',id:'CVE-2099-10001'}, {mode:'structured',q:'x'}]) assert.throws(() => parseQuery(input), /INVALID_QUERY/);
  const evidence = evidenceContext({query:{cwe:'CWE-89'},items:[{cve_id:'CVE-2099-70001',sources:[
    {observation_id:'1',matched:true,record:{cwes:['CWE-89'],affected:[],references:[],metrics:[],descriptions:[]}},
    {observation_id:'2',matched:false,record:{cwes:['CWE-22'],affected:[],references:[],metrics:[],descriptions:[]}}
  ]}]});
  const item = evidence.items[0];
  assert.equal(item.match.kind, 'candidate_not_target_verdict');
  assert.deepEqual(item.match.observation_ids, ['1']);
  assert.equal(item.investigation.status, 'requires_verification');
  assert.deepEqual(item.investigation.weakness_checks.map(c => c.cwe), ['CWE-89']);
  assert.equal(item.investigation.weakness_checks[0].basis, 'generic_cwe_review_rule');
  assert.deepEqual(item.investigation.missing_by_source[0].fields, ['description','affected_products','version_or_configuration_evidence','severity','tagged_fix_or_vendor_advisory']);
  assert.equal(item.investigation.weakness_checks[0].rule_reference,'https://cwe.mitre.org/data/definitions/89.html');
  assert.equal(item.sources[0].record.version_evidence, 'read_full_observation');
  assert.equal(item.sources[0].record.affected, undefined);
  assert.match(evidenceContext({items:[]}).empty_guidance, /do not conclude/);
  const unrecognized = evidenceContext({items:[{sources:[{observation_id:'3',matched:true,record:{cwes:['constructor','toString','__proto__']}}]}]});
  assert.deepEqual(unrecognized.items[0].investigation.weakness_checks,[]);
  const kevLike = evidenceContext({items:[{sources:[{observation_id:'4',matched:true,record:{affected:[{product:'nginx'}],references:[{tags:['Vendor Advisory']}]}}]}]});
  const gaps = kevLike.items[0].investigation.missing_by_source[0].fields;
  assert.ok(gaps.includes('version_or_configuration_evidence'));
  assert.ok(!gaps.includes('affected_products'));
  assert.ok(!gaps.includes('tagged_fix_or_vendor_advisory'));
});

test('discovery/tree/observation clients reject wrong contracts, invalid input and unsupported service status', async () => {
  const discovery = await readCapabilities({}, {fetchImpl:async () => Response.json(capabilities())});
  assert.equal(discovery.schema, 'memz.cve.capabilities.v1');
  await assert.rejects(() => readCapabilities({q:'x'}), /INVALID_QUERY/);
  await assert.rejects(() => readTree({}, {fetchImpl:async () => Response.json({nodes:[]})}), /INVALID_CVE_RESPONSE/);
  await assert.rejects(() => readObservation({id:'0'}), /INVALID_QUERY/);
  await assert.rejects(() => readObservation({id:'1',extra:'x'}), /INVALID_QUERY/);
  await assert.rejects(() => readObservation({id:'1'}, {fetchImpl:async () => Response.json({untrusted_data:true,observation:{id:'2',raw:{},normalized:{}}})}), /INVALID_CVE_RESPONSE/);
  await assert.rejects(() => readContext({q:'x'}, {fetchImpl:async () => new Response('',{status:501})}), /RETRIEVAL_MODE_NOT_IMPLEMENTED/);
  await assert.rejects(() => readObservation({id:'1'}, {fetchImpl:async () => new Response('',{status:404})}), /NOT_FOUND/);
});
