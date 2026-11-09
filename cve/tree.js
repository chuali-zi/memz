'use strict';
const {transaction} = require('./store');
const {stacks, weaknesses, aliases, servicePattern, publishedCondition} = require('./taxonomy');
function invalid() { throw Object.assign(new Error('INVALID_QUERY'), {status: 400}); }
function parseTreeQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const query = {};
  for (const [key, value] of Object.entries(input)) {
    if (!['stack','service','product','limit','after'].includes(key) || typeof value !== 'string' ||
        !value.trim() || value.length > (key === 'after' ? 2048 : 300) || value.includes('\0') || !value.isWellFormed()) invalid();
    query[key] = value.trim();
  }
  if (query.stack && !Object.hasOwn(stacks, query.stack)) invalid();
  if (query.service && (!query.stack || !servicePattern.test(query.service))) invalid();
  if (query.product && (!query.stack || query.service)) invalid();
  if (query.product) {
    query.product = query.product.toLowerCase();
    if (Object.hasOwn(aliases, query.product)) query.product = aliases[query.product];
  }
  if (query.limit && (!/^\d+$/.test(query.limit) || +query.limit < 1 || +query.limit > 50)) invalid();
  query.limit = +(query.limit || 10);
  const scope = [query.stack || null, query.service || null, query.product || null];
  if (query.after) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(query.after)) invalid();
      const cursor = JSON.parse(Buffer.from(query.after, 'base64url').toString('utf8'));
      if (cursor.v !== 1 || JSON.stringify(cursor.scope) !== JSON.stringify(scope) || typeof cursor.key !== 'string' ||
          !(query.service ? /^(?:CWE-\d{1,10}|unclassified)$/.test(cursor.key) : query.stack ? servicePattern.test(cursor.key) : Object.hasOwn(stacks, cursor.key))) invalid();
      query.cursor_key = cursor.key;
    } catch { invalid(); }
  }
  return query;
}
function buildTreeQuery(query) {
  const values = [], param = value => {values.push(value); return `$${values.length}`;};
  const key = query.service ? 'cwe' : query.stack ? 'service' : 'stack';
  const where = [publishedCondition('f', 'f.state')];
  if (query.stack) where.push(`f.stack=${param(query.stack)}`);
  if (query.service) where.push(`f.service=${param(query.service)}`);
  if (query.product) where.push(`f.product=${param(query.product)}`);
  if (query.cursor_key) where.push(`f.${key} COLLATE "C">${param(query.cursor_key)} COLLATE "C"`);
  return {values, text: `SELECT f.${key} key,count(DISTINCT f.cve_id)::int cve_count,
    min(f.vendor) vendor,min(f.product) product,min(f.ecosystem) ecosystem
    FROM cve.facets f
    WHERE ${where.join(' AND ')} GROUP BY f.${key} ORDER BY f.${key} COLLATE "C" LIMIT ${param(query.limit + 1)}`};
}
async function browseTree(pool, input = {}) {
  const query = parseTreeQuery(input), {cursor_key, after, ...scopeQuery} = query;
  return transaction(pool, async client => {
    const result = await client.query(buildTreeQuery(query));
    const rows = result.rows.slice(0, query.limit), more = result.rows.length > query.limit;
    const level = query.service ? 'weakness' : query.stack ? 'service' : 'stack';
    const nodes = rows.map(row => {
      const node = {key: row.key, kind: level, cve_count: row.cve_count};
      if (level === 'stack') return {...node, label: stacks[row.key], next_query: {stack: row.key}};
      if (level === 'service') return {...node, label: row.product || '产品名缺失 / 超出检索长度',
        vendor: row.vendor, product: row.product, ecosystem: row.ecosystem,
        next_query: {stack: query.stack, service: row.key}, context_query: {stack: query.stack, service: row.key}};
      return {...node, label: weaknesses[row.key] || row.key,
        context_query: {stack: query.stack, service: query.service, cwe: row.key}};
    });
    const nextAfter = more ? Buffer.from(JSON.stringify({v: 1,
      scope: [query.stack || null, query.service || null, query.product || null], key: rows.at(-1).key})).toString('base64url') : null;
    return {schema: 'memz.cve.tree.v1', untrusted_data: true, taxonomy_version: 1, level, query: scopeQuery, nodes,
      next_after: nextAfter, next_query: nextAfter ? {...scopeQuery, after: nextAfter} : null,
      count_semantics: 'distinct_published_cves_per_node_in_this_local_snapshot; sibling_counts_may_overlap',
      empty_guidance: nodes.length ? null : 'No matching imported records on this page. Broaden the branch, check Other/unclassified, or use structured/lexical search. This is not proof of absence.'};
  }, {readOnly: true});
}
module.exports = {parseTreeQuery, buildTreeQuery, browseTree};
