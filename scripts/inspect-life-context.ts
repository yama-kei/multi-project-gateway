import { getAgentContext, getLifeContextRunArgs } from '../src/ayumi/index.js';

async function main(): Promise<void> {
  const agent = process.argv[2] ?? 'life-hobbies';
  const ctx = await getAgentContext(agent);
  console.log(`=== AGENT: ${agent}`);
  console.log(`=== INDEX LENGTH (bytes): ${ctx?.length ?? 'null'}`);
  console.log('=== RUN ARGS:', JSON.stringify(getLifeContextRunArgs(agent), null, 2));
  console.log('=== FULL INDEX ===');
  console.log(ctx);
}

main().catch((err) => { console.error(err); process.exit(1); });
