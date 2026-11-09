'use strict';
// These are general review prompts, deliberately separate from CVE/source facts.
const checks = Object.freeze({
  'CWE-89': 'Trace untrusted input to SQL query construction; inspect parameter binding and the affected query path described by the advisory.',
  'CWE-79': 'Identify the affected input/output context and inspect context-appropriate encoding and sanitization.',
  'CWE-22': 'Inspect path normalization and whether the resulting path remains inside the intended directory.',
  'CWE-78': 'Trace external input into process or shell invocation and inspect argument handling at the affected entry point.',
  'CWE-918': 'Inspect server-side URL handling, destination validation and redirect handling for the affected request path.',
  'CWE-502': 'Identify the deserialization entry point, trust boundary and permitted data types before selecting an isolated verification.'
});
function investigation(item) {
  const missing = [], hints = [], seen = new Set();
  for (const source of item.sources) {
    const record = source.record;
    const gaps = [];
    if (!record.descriptions?.some(d => d.value)) gaps.push('description');
    if (!record.affected?.some(a => a.product || a.package?.name)) gaps.push('affected_products');
    if (!record.configurations?.length && !record.affected?.some(a => a.versions?.length || a.ranges?.length || a.defaultStatus || a.cpe_match)) gaps.push('version_or_configuration_evidence');
    if (!record.cwes?.length) gaps.push('cwe');
    if (!record.metrics?.length) gaps.push('severity');
    if (!record.references?.some(r => r.tags?.some(t => typeof t === 'string' && /^(patch|fix|vendor[- ]advisory)$/i.test(t.trim())))) gaps.push('tagged_fix_or_vendor_advisory');
    if (gaps.length) missing.push({observation_id: source.observation_id, fields: gaps});
    if (source.matched) for (const cwe of record.cwes || []) {
      if (!Object.hasOwn(checks, cwe) || seen.has(cwe)) continue;
      seen.add(cwe);
      hints.push({cwe, basis: 'generic_cwe_review_rule', rule_reference: `https://cwe.mitre.org/data/definitions/${cwe.slice(4)}.html`,
        classification_observation_id: source.observation_id, suggestion: checks[cwe]});
    }
  }
  return {
    status: 'requires_verification', generated_by: 'deterministic_rules_v1',
    next_steps: [
      'Confirm the exact vendor, product/component and deployed version; a similar service name is insufficient.',
      'Read the cited full observations for complete affected ranges, defaultStatus and CPE AND/OR/environment conditions.',
      'Compare original advisories and fix references, retain source disagreements, and identify missing prerequisites before an isolated test.'
    ],
    weakness_checks: hints, missing_by_source: missing,
    caveat: 'Suggestions are investigation leads, not source-verified exploit steps or a finding that the target is vulnerable.'
  };
}
module.exports = {investigation};
