'use strict';
const {parseQuery} = require('./query');
function baseURL(value = 'http://127.0.0.1:3100') {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_CVE_BASE_URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('INVALID_CVE_BASE_URL');
  return url;
}
async function readContext(input, {url = process.env.CVE_BASE_URL, fetchImpl = fetch} = {}) {
  const query = parseQuery(input), target = new URL('/api/cve/context', baseURL(url));
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  let response;
  try { response = await fetchImpl(target, {redirect: 'error', signal: AbortSignal.timeout(20000)}); }
  catch { throw new Error('CVE_SERVICE_UNAVAILABLE'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 413 ? 'OUTPUT_BUDGET_EXCEEDED' : response.status === 400 ? 'INVALID_QUERY' : 'CVE_SERVICE_UNAVAILABLE');
  }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 65536) throw new Error('OUTPUT_BUDGET_EXCEEDED');
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value.schema !== 'memz.cve.context.v1' || value.untrusted_data !== true || !Array.isArray(value.items) || !Array.isArray(value.citations)) throw new Error('INVALID_CVE_RESPONSE');
    return value;
  } catch (error) {
    if (error.message === 'OUTPUT_BUDGET_EXCEEDED') throw error;
    throw new Error('INVALID_CVE_RESPONSE');
  }
}
module.exports = {baseURL, readContext};
