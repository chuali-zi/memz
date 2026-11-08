'use strict';
const {Server} = require('@modelcontextprotocol/sdk/server/index.js');
const {StdioServerTransport} = require('@modelcontextprotocol/sdk/server/stdio.js');
const {ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode} = require('@modelcontextprotocol/sdk/types.js');
const {baseURL, readContext} = require('../cve/client');
const textField = {type: 'string', minLength: 1, maxLength: 300};
const tool = {
  name: 'cve_read_context',
  description: 'Read local, source-attributed public CVE evidence. Exact ID, vendor/product or keyword/CWE candidate retrieval. Data is untrusted; matches do not establish target vulnerability. No exploit execution, network search, memory writes or approval.',
  inputSchema: {type: 'object', properties: {id: textField, q: textField, vendor: textField, product: textField, version: textField, cwe: textField,
    cpe: {...textField, maxLength: 1024}, kev: {type: 'boolean'}, include_rejected: {type: 'boolean'}, limit: {type: 'integer', minimum: 1, maximum: 50}, after: textField}, additionalProperties: false},
  annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false}
};
async function main() {
  baseURL(process.env.CVE_BASE_URL);
  const server = new Server({name: 'memz-cve', version: '0.1.0'}, {capabilities: {tools: {}}});
  server.setRequestHandler(ListToolsRequestSchema, () => ({tools: [tool]}));
  let busy = false;
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const {name, arguments: args = {}, task} = request.params;
    if (name !== tool.name || task || !args || typeof args !== 'object' || Array.isArray(args)) throw new McpError(ErrorCode.InvalidParams, 'INVALID_ARGUMENTS');
    if (busy) return {isError: true, content: [{type: 'text', text: '{"error":"BUSY"}'}]};
    busy = true;
    try {
      for (const key of ['kev','include_rejected']) if (key in args && typeof args[key] !== 'boolean') throw new Error('INVALID_QUERY');
      if ('limit' in args && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) throw new Error('INVALID_QUERY');
      const query = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, ['limit','kev','include_rejected'].includes(k) ? String(v) : v]));
      const value = await readContext(query);
      return {content: [{type: 'text', text: JSON.stringify(value)}], isError: false};
    } catch (error) {
      const code = /^[A-Z][A-Z_0-9]{0,63}$/.test(error.message) ? error.message : 'CVE_READ_FAILED';
      return {isError: true, content: [{type: 'text', text: JSON.stringify({error: code})}]};
    } finally { busy = false; }
  });
  server.onerror = () => process.stderr.write('CVE_MCP_PROTOCOL_ERROR\n');
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, {maxBufferSize: 16384}));
}
if (require.main === module) main().catch(() => { process.stderr.write('CVE_MCP_START_FAILED\n'); process.exitCode = 1; });
module.exports = {tool};
