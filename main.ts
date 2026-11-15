// main.ts — the entrypoint: the entry <-> env lifecycle the kit settles, plus
// a standalone mode for local development.
//
// Grading lifecycle (MAKEFUN_ENV_URL set): bind an ephemeral port (never 8080),
// POST $MAKEFUN_ENV_URL/register {"port": N}, poll GET $MAKEFUN_ENV_URL/done
// until {"done": true}, close, exit 0.
//
// Standalone mode (MAKEFUN_ENV_URL unset): listen on $PORT (default 3000) and
// serve until stopped, so the forge can be exercised with curl, real git, and
// the kit's local runner. Bearer auth still applies: MAKEFUN_SHOP_TOKEN when
// set, any non-empty bearer token otherwise.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** How long one register or done request may take before it is retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is normal; 409 means a
 * first register already won. 400/405 are contract errors; anything else is
 * retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();

  if (ENV_URL === '') {
    // Standalone mode: serve on $PORT (default 3000) until stopped.
    const port = Number(process.env.PORT ?? '3000');
    const listenPort = Number.isFinite(port) && port > 0 ? Math.floor(port) : 3000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, () => resolve());
    });
    process.stdout.write(`[entry] standalone: listening on port ${listenPort}\n`);
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        server.close(() => resolve());
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

// A stray handler fault must never kill the trial: log and carry on.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[entry] uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[entry] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
});

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
