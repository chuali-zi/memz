'use strict';
const express = require('express');
const http = require('node:http');
const {search, evidenceContext} = require('./query');
const {CVE_ID} = require('./normalize');
const {transaction} = require('./store');
const {capabilities} = require('./taxonomy');
const {browseTree} = require('./tree');
const {readSyncStatus} = require('./managed-sync');
function createApp(pool) {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(req.headers.host || '')) return res.status(403).json({error: 'LOOPBACK_ONLY'});
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).json({error: 'INVALID_ORIGIN'});
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).set('Allow', 'GET, HEAD').json({error: 'READ_ONLY'});
    next();
  });
  function send(res, value, budget = 262144) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > budget) return res.status(413).json({error: 'OUTPUT_BUDGET_EXCEEDED', hint: 'Reduce limit or request one observation.'});
    return res.type('json').send(body);
  }
  app.get('/health/ready', async (req, res) => {
    await transaction(pool, c => c.query('SELECT 1 FROM cve.records r LEFT JOIN cve.facets f USING(source,source_id,cve_id) LIMIT 1'), {readOnly: true});
    res.json({ready: true});
  });
  app.get('/api/cve/capabilities', (req, res) => Object.keys(req.query).length
    ? res.status(400).json({error: 'INVALID_QUERY'}) : send(res, capabilities(), 65536));
  app.get('/api/cve/tree', async (req, res) => send(res, await browseTree(pool, req.query), 65536));
  app.get('/api/cve/sync-status', async (req, res) => Object.keys(req.query).length
    ? res.status(400).json({error: 'INVALID_QUERY'}) : send(res, await readSyncStatus(pool), 65536));
  app.get('/api/cve/search', async (req, res) => send(res, evidenceContext(await search(pool, req.query))));
  app.get('/api/cve/context', async (req, res) => send(res, evidenceContext(await search(pool, req.query)), 65536));
  app.get('/api/cve/observations/:id', async (req, res) => {
    if (!/^[1-9]\d{0,17}$/.test(req.params.id) || Object.keys(req.query).length) return res.status(400).json({error: 'INVALID_QUERY'});
    const row = await transaction(pool, async c => (await c.query('SELECT * FROM cve.observations WHERE id=$1', [req.params.id])).rows[0], {readOnly: true});
    return row ? send(res, {untrusted_data: true, observation: row}, 16 * 1024 * 1024) : res.status(404).json({error: 'NOT_FOUND'});
  });
  app.get('/api/cve/:id', async (req, res) => {
    const id = req.params.id.toUpperCase();
    if (!CVE_ID.test(id) || Object.keys(req.query).length) return res.status(400).json({error: 'INVALID_QUERY'});
    const result = await search(pool, {id, include_rejected: 'true', limit: '1'});
    return result.items.length ? send(res, evidenceContext(result)) : res.status(404).json({error: 'NOT_FOUND'});
  });
  app.use((req, res) => res.status(404).json({error: 'NOT_FOUND'}));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status === 400 ? 400 : error.status === 501 ? 501 : 503;
    res.status(status).json({error: status === 400 ? 'INVALID_QUERY' : status === 501 ? 'RETRIEVAL_MODE_NOT_IMPLEMENTED' : 'CVE_DATABASE_UNAVAILABLE'});
  });
  return app;
}
function serve(pool, port = 3100) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  const server = http.createServer({requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192}, createApp(pool));
  server.listen(port, '127.0.0.1', () => process.stderr.write(`CVE read API: http://127.0.0.1:${port}\n`));
  const stop = () => { server.close(() => pool.end()); server.closeIdleConnections(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  server.on('error', () => { process.stderr.write('CVE_LISTEN_FAILED\n'); pool.end(); process.exitCode = 1; });
  return server;
}
module.exports = {createApp, serve};
