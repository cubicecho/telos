import { readConfig } from './config.ts';
import { runLoop } from './loop.ts';
import { createTelos } from './telos.ts';

// A runner as its own process. The server already runs one of these inside
// itself (embed.ts), so this is only for a second runner on another host: it
// needs TELOS_URL and RUNNER_KEY, the same key set on the server. Whether any
// work comes is the instance's switch, which an admin flips in Settings: with
// it off the queue is empty and the runner idles.

// Without AI on the server, or a key to sign in with, it bows out instead of failing.
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
