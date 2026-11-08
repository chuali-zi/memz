'use strict';
const crypto = require('node:crypto');
const CVE_ID = /^CVE-\d{4}-\d{4,}$/;
const SOURCES = ['cvelist', 'nvd', 'ghsa', 'kev', 'circl'];
const array = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(v => typeof v === 'string' && v))];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function digest(raw) { return crypto.createHash('sha256').update(JSON.stringify(canonical(raw))).digest('hex'); }
function date(value) {
  if (!value) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d(?:T.*)?$/.test(value)) throw new Error('INVALID_SOURCE_DATE');
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error('INVALID_SOURCE_DATE');
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00Z` : /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`);
  if (!Number.isFinite(parsed.getTime())) throw new Error('INVALID_SOURCE_DATE');
  return parsed.toISOString();
}
function refs(values) {
  const map = new Map();
  for (const item of array(values)) {
    const url = item.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    const old = map.get(url);
    map.set(url, {url, tags: unique([...(old?.tags || []), ...array(item.tags), ...(item.type ? [item.type] : [])])});
  }
  return [...map.values()];
}
function cna(raw) {
  if (raw.dataType !== 'CVE_RECORD' || !/^5\./.test(raw.dataVersion || '') || !raw.cveMetadata) throw new Error('UNSUPPORTED_CVE_FORMAT');
  const meta = raw.cveMetadata, containers = [raw.containers?.cna, ...array(raw.containers?.adp)].filter(Boolean);
  const state = meta.state;
  if (!['PUBLISHED', 'REJECTED', 'RESERVED'].includes(state)) throw new Error('INVALID_CVE_STATE');
  return [{
    cve_id: meta.cveId, source_id: meta.cveId, state, title: containers.find(c => c.title)?.title || '',
    published: date(meta.datePublished), modified: date(meta.dateUpdated),
    descriptions: containers.flatMap(c => array(state === 'REJECTED' ? c.rejectedReasons : c.descriptions)),
    affected: containers.flatMap(c => array(c.affected)),
    cwes: unique(containers.flatMap(c => array(c.problemTypes).flatMap(p => array(p.descriptions).map(d => d.cweId || (/CWE-\d+/.exec(d.description || '') || [])[0])))),
    metrics: containers.flatMap(c => array(c.metrics).map(metric => ({provider: c.providerMetadata || {}, ...metric}))),
    references: refs(containers.flatMap(c => array(c.references))),
    aliases: [meta.cveId], cpe_matches: [], configurations: []
  }];
}
function nvd(raw) {
  const c = raw.cve || raw;
  if (!c.id || !Array.isArray(c.descriptions)) throw new Error('UNSUPPORTED_NVD_FORMAT');
  const matches = [];
  function visit(node) {
    for (const match of array(node.cpeMatch)) matches.push(match);
    for (const child of [...array(node.nodes), ...array(node.children)]) visit(child);
  }
  array(c.configurations).forEach(visit);
  return [{
    cve_id: c.id, source_id: c.id, state: c.vulnStatus === 'Rejected' ? 'REJECTED' : c.vulnStatus === 'Reserved' ? 'RESERVED' : 'PUBLISHED',
    source_status: c.vulnStatus, title: '', published: date(c.published), modified: date(c.lastModified),
    descriptions: c.descriptions, affected: matches.filter(m => m.vulnerable === true).map(m => {
      // Split CPE 2.3 fields without treating escaped colons as separators.
      const fields = []; let field = '', escaped = false;
      for (const char of m.criteria || '') {
        if (escaped) { field += char; escaped = false; }
        else if (char === '\\') escaped = true;
        else if (char === ':') { fields.push(field); field = ''; }
        else field += char;
      }
      fields.push(field);
      return fields[0] === 'cpe' && fields[1] === '2.3' ? {vendor: fields[3], product: fields[4], cpe_match: m} : {cpe_match: m};
    }), cpe_matches: matches, configurations: array(c.configurations),
    cwes: unique(array(c.weaknesses).flatMap(w => array(w.description).map(d => d.value)).filter(v => /^CWE-\d+$/.test(v))),
    metrics: Object.entries(c.metrics || {}).flatMap(([type, values]) => array(values).map(m => ({type, ...m}))),
    references: refs(c.references), aliases: [c.id]
  }];
}
function ghsa(raw) {
  if (!/^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/.test(raw.id || '')) throw new Error('UNSUPPORTED_GHSA_FORMAT');
  return unique(array(raw.aliases).filter(id => CVE_ID.test(id))).map(id => ({
    cve_id: id, source_id: raw.id, state: raw.withdrawn ? 'WITHDRAWN' : 'PUBLISHED', title: raw.summary || '',
    published: date(raw.published), modified: date(raw.modified), descriptions: [{lang: 'en', value: raw.details || raw.summary || ''}],
    affected: array(raw.affected).map(a => ({...a, vendor: a.package?.ecosystem || '', product: a.package?.name || ''})),
    cwes: unique(array(raw.database_specific?.cwe_ids).filter(id => /^CWE-\d+$/.test(id))),
    metrics: array(raw.severity), severity: raw.database_specific?.severity || null,
    references: refs(raw.references), aliases: unique([raw.id, ...array(raw.aliases)]), cpe_matches: [], configurations: []
  }));
}
function kev(raw, catalogDate) {
  if (!raw.cveID || !raw.dateAdded) throw new Error('UNSUPPORTED_KEV_FORMAT');
  return [{
    cve_id: raw.cveID, source_id: raw.cveID, state: 'PUBLISHED', title: raw.vulnerabilityName || '',
    published: null, modified: date(catalogDate), descriptions: [{lang: 'en', value: raw.shortDescription || ''}],
    affected: [{vendor: raw.vendorProject || '', product: raw.product || ''}], cwes: unique(array(raw.cwes)), metrics: [],
    references: refs([{url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog', tags: ['kev']}]),
    aliases: [raw.cveID], cpe_matches: [], configurations: [], kev: {...raw, dateAdded: date(raw.dateAdded)}
  }];
}
function sourceURL(source, record) {
  const id = record.cve_id;
  if (source === 'cvelist') return `https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/${id.split('-')[1]}/${id.split('-')[2].slice(0, -3)}xxx/${id}.json`;
  if (source === 'nvd') return `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${id}`;
  if (source === 'ghsa') return `https://github.com/advisories/${record.source_id}`;
  if (source === 'kev') return 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
  return `https://vulnerability.circl.lu/api/vulnerability/${id}`;
}
function normalize(source, raw, {catalogDate} = {}) {
  if (!SOURCES.includes(source) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_SOURCE');
  // CIRCL is a mirror: accept only explicit upstream CVE5 / NVD shapes, retaining mirror provenance.
  const records = source === 'cvelist' ? cna(raw) : source === 'nvd' ? nvd(raw) : source === 'ghsa' ? ghsa(raw) : source === 'kev' ? kev(raw, catalogDate) : raw.cveMetadata ? cna(raw) : nvd(raw);
  return records.map(record => {
    if (!CVE_ID.test(record.cve_id)) throw new Error('INVALID_CVE_ID');
    const vendors = unique(record.affected.map(a => a.vendor));
    const products = unique(record.affected.map(a => a.product || a.package?.name));
    // CPE expressions remain intact; no naive CPE split or version comparison.
    const search_text = [record.cve_id, record.title, ...record.descriptions.map(d => d.value || ''), ...vendors, ...products, ...record.cwes,
      ...record.cpe_matches.map(m => m.criteria || ''), ...record.aliases].join(' ');
    return {...record, vendors, products, search_text, source_url: sourceURL(source, record)};
  });
}
function unpack(source, raw) {
  if (source === 'nvd' && Array.isArray(raw.vulnerabilities)) return raw.vulnerabilities.map(v => ({raw: v.cve || v}));
  if (source === 'kev' && Array.isArray(raw.vulnerabilities)) return raw.vulnerabilities.map(v => ({raw: v, catalogDate: raw.dateReleased}));
  return [{raw}];
}
module.exports = {CVE_ID, SOURCES, normalize, unpack, digest, date};
