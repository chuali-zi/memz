// Offline configuration regression. Native PostgreSQL users need no Docker.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');

test('the production Compose healthcheck targets TCP rather than the temporary Unix-only init server',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../compose.yml'),'utf8');
  // This repository deliberately uses a JSON-compatible YAML flow sequence.
  // Other YAML layouts require adapting this regression, not silently skipping it.
  const block=source.match(/^    healthcheck:\n((?:      .*(?:\n|$))+)/m);
  assert.ok(block,'production healthcheck must be present');
  const command=block[1].match(/^      test: (\[[^\r\n]+\])$/m);
  assert.ok(command,'healthcheck command must remain an explicit argv sequence');
  assert.deepEqual(JSON.parse(command[1]),['CMD','pg_isready','-h','127.0.0.1','-U','postgres','-d','memz']);
  for(const line of ['      interval: 2s','      timeout: 3s','      retries: 30'])assert.ok(block[1].split('\n').includes(line));
  assert.ok(!/^      disable: true$/m.test(block[1]));
});
