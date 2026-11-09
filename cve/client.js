'use strict';
const {parseQuery} = require('./query');
const {parseTreeQuery} = require('./tree');
function baseURL(value = 'http://127.0.0.1:3100') {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_CVE_BASE_URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('INVALID_CVE_BASE_URL');
  return url;
}
async function request(path, query, {url = process.env.CVE_BASE_URL, fetchImpl = fetch} = {}, budget = 65536, validate) {
  const target = new URL(path, baseURL(url));
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  let response;
  try { response = await fetchImpl(target, {redirect: 'error', signal: AbortSignal.timeout(20000)}); }
  catch { throw new Error('CVE_SERVICE_UNAVAILABLE'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(({413: 'OUTPUT_BUDGET_EXCEEDED', 400: 'INVALID_QUERY', 404: 'NOT_FOUND', 501: 'RETRIEVAL_MODE_NOT_IMPLEMENTED'})[response.status] || 'CVE_SERVICE_UNAVAILABLE');
  }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > budget) throw new Error('OUTPUT_BUDGET_EXCEEDED');
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!validate(value)) throw new Error('INVALID_CVE_RESPONSE');
    return value;
  } catch (error) {
    if (error.message === 'OUTPUT_BUDGET_EXCEEDED') throw error;
    throw new Error('INVALID_CVE_RESPONSE');
  }
}
function wireInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_QUERY');
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
    (key === 'limit' && Number.isInteger(value)) || (['kev','include_rejected'].includes(key) && typeof value === 'boolean') ? String(value) : value]));
}
async function readContext(input, options) {
  return request('/api/cve/context', parseQuery(wireInput(input)), options, 65536,
    value => value?.schema === 'memz.cve.context.v1' && value.untrusted_data === true && Array.isArray(value.items) && Array.isArray(value.citations));
}
async function readCapabilities(input = {}, options) {
  if (Object.keys(wireInput(input)).length) throw new Error('INVALID_QUERY');
  return request('/api/cve/capabilities', {}, options, 65536,
    value => value?.schema === 'memz.cve.capabilities.v1' && value.domain === 'vulnerability_knowledge_and_cve_details' && Array.isArray(value.workflow));
}
async function readTree(input = {}, options) {
  const {cursor_key, ...query} = parseTreeQuery(wireInput(input));
  return request('/api/cve/tree', query, options, 65536,
    value => value?.schema === 'memz.cve.tree.v1' && value.untrusted_data === true && Array.isArray(value.nodes));
}
async function readObservation(input, options) {
  const query = wireInput(input);
  if (Object.keys(query).length !== 1 || typeof query.id !== 'string' || !/^[1-9]\d{0,17}$/.test(query.id)) throw new Error('INVALID_QUERY');
  return request(`/api/cve/observations/${query.id}`, {}, options, 16 * 1024 * 1024,
    value => value?.untrusted_data === true && String(value.observation?.id) === query.id &&
      value.observation?.raw && typeof value.observation.raw === 'object' && value.observation?.normalized);
}
module.exports = {baseURL, readContext, readCapabilities, readTree, readObservation};
