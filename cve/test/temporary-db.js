'use strict';
const {Client, Pool} = require('pg');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
async function temporaryDatabase(adminURL, fn) {
  if (!adminURL) throw new Error('CVE_TEST_DATABASE_URL_REQUIRED');
  const admin = new Client({connectionString: adminURL, connectionTimeoutMillis: 5000});
  await admin.connect();
  const name = `memz_cve_check_${crypto.randomBytes(8).toString('hex')}`;
  let pool, created = false;
  const connectionsClosed=[];
  try {
    await admin.query(`CREATE DATABASE ${name}`); created = true;
    const url = new URL(adminURL); url.pathname = `/${name}`;
    pool = new Pool({connectionString: url.href, max: 5, connectionTimeoutMillis: 5000});
    pool.on('connect',client=>connectionsClosed.push(new Promise(resolve=>client.once('end',resolve))));
    await pool.query(await fs.readFile(path.join(__dirname,'..','..','db','cve_schema.sql'),'utf8'));
    return await fn(pool);
  } finally {
    if (pool) {await pool.end();await Promise.all(connectionsClosed);}
    if (created && /^memz_cve_check_[a-f0-9]{16}$/.test(name)) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
}
module.exports = {temporaryDatabase};
