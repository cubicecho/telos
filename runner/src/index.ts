import { readConfig } from './config.ts';
import { runLoop } from './loop.ts';
import { createTelos } from './telos.ts';

// The runner process: works the board's stations for every user who has AI on.
// It needs TELOS_URL and RUNNER_KEY (the same key the server has); the server
// needs AI_ENABLED, or it will not know the key, and so does the runner, so
// one setting turns both off. See the README's AI section.

// `npm run dev` starts the runner beside the server every time; with AI off it
// has no work and no one to ask for it, so it bows out instead of failing.
if (process.env.AI_ENABLED !== 'true') {
  console.log('[runner] AI_ENABLED is off; nothing to do.');
  process.exit(0);
}

const config = readConfig();
if (!config) {
  console.error('✖ RUNNER_KEY is not set. The runner signs in to telos with it; set the same key on both.');
  process.exit(1);
}

const telos = createTelos(config);
const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log('[runner] stopping; runs in flight are reported as stopped');
    stop.abort();
  });
}

console.log(`🤖 Telos runner working ${config.telosUrl}, ${config.concurrency} at a time`);
if (config.allowStdio) console.warn('⚠️  RUNNER_ALLOW_STDIO is on: agents may spawn commands on this host.');
await runLoop({ ...config, telos }, stop.signal);
process.exit(0);
