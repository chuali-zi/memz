const http=require('node:http');

// CLI receive limits, separate from database work and the shutdown deadline.
// Set the checking interval at construction, before Node starts its timer.
const HTTP_RECEIVE_OPTIONS=Object.freeze({
  headersTimeout:10000,
  requestTimeout:15000,
  connectionsCheckingInterval:1000,
  keepAliveTimeout:5000
});
const MAX_HTTP_CONNECTIONS=128;

function createCliHttpServer(app){
  const server=http.createServer(HTTP_RECEIVE_OPTIONS,app);
  server.maxConnections=MAX_HTTP_CONNECTIONS;
  // No socket inactivity timeout: a fully received request may be doing work.
  server.timeout=0;
  return server;
}

module.exports={HTTP_RECEIVE_OPTIONS,MAX_HTTP_CONNECTIONS,createCliHttpServer};
