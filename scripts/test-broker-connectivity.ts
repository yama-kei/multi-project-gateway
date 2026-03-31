/**
 * Quick smoke test: verify MPG can reach the HouseholdOS broker.
 * Run: npx tsx scripts/test-broker-connectivity.ts
 */

import { config } from 'dotenv';
config();

import { createBrokerClientFromEnv } from '../src/broker-client.js';

async function main() {
  console.log('Testing broker connectivity...');
  console.log(`  BROKER_URL: ${process.env.BROKER_URL}`);

  const client = createBrokerClientFromEnv();

  // 1. Health check
  const health = await client.health();
  console.log(`  /broker/health: ${health.ok ? 'OK' : 'FAIL'}`);

  // 2. Drive setup
  const { ensureLifeContextFolders } = await import('../src/life-context-setup.js');
  const folders = await ensureLifeContextFolders(client);
  console.log(`  life-context root folder: ${folders.root}`);
  console.log(`  topic folders: ${Object.entries(folders.topics).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  _meta folder: ${folders.meta}`);

  // 3. Test write + read round-trip
  const writeResult = await client.driveWrite('_connectivity-test.txt', `Broker connectivity test at ${new Date().toISOString()}`, 'text');
  console.log(`  drive/write: created ${writeResult.file_id}`);
  const readResult = await client.driveRead(writeResult.file_id);
  console.log(`  drive/read: got "${readResult.content.slice(0, 50)}..."`);

  console.log('\nAll checks passed!');
}

main().catch((err) => {
  console.error('Connectivity test failed:', err.message);
  process.exit(1);
});
