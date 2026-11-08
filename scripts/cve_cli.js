'use strict';
// Kept independent of package.json/server.js to avoid coupling to project memory.
require('../cve/cli').main().catch(error => {
  const code = /^[A-Z][A-Z_0-9]{0,63}$/.test(error.message) ? error.message : 'CVE_COMMAND_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
