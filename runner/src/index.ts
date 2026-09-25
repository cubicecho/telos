import { readConfig } from './config.ts';
import { runLoop } from './loop.ts';
import { createTelos } from './telos.ts';

// The runner process: works the board's stations for every user who has AI on.
// It needs TELOS_URL and RUNNER_KEY (the same key the server has). Whether any
// work comes is the instance's switch, which an admin flips in Settings: with
// it off the queue is empty and the runner idles. See the README's AI section.

// `npm run dev` starts the runner beside the server every time; on a server
// with AI removed, or with no key to sign in with, it bows out instead of failing.
if (['0', 'false', 'no'].includes((process.env.AI_ENABLED ?? '').trim().toLowerCase())) {
  console.log('[runner] AI_ENABLED is false; nothing to do.');
  process.exit(0);
}

const config = readConfig();
if (!config) {
  console.log('[runner] RUNNER_KEY is not set, so there is no way to sign in to telos; nothing to do.');
  process.exit(0);
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
