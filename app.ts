// app.ts — the HTTP server: one router over the four surfaces (git smart
// HTTP, REST v3, GraphQL v4, MCP), plus the health probe. Every handler runs
// behind a catch-all so a bad request can never take the process down.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { buildCtx, nextRequestId, readBody, requireAuth, sendError, sendJson } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json', 'x-github-request-id': requestId });
        res.end(JSON.stringify({ message: 'Could not read request body' }));
        return;
      }
      const ctx = buildCtx(req, res, body, requestId);
      try {
        dispatch(ctx, store);
      } catch (err) {
        if (!res.writableEnded) {
          process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
          sendError(ctx, 500, 'Internal Server Error');
        }
      }
    })();
  });
}

function dispatch(ctx: ReturnType<typeof buildCtx>, store: Store): void {
  const { method, path, segments } = ctx;

  // The env's boot probe: 200 {"ok":true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(ctx, 200, { ok: true });
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (!requireAuth(ctx)) return;
    handleGraphql(ctx, store);
    return;
  }

  // MCP: method routing first (GET/DELETE are 405 with or without a token).
  if (path === '/mcp') {
    if (ctx.method === 'GET' || ctx.method === 'DELETE') {
      handleMcp(ctx, store);
      return;
    }
    if (!requireAuth(ctx)) return;
    handleMcp(ctx, store);
    return;
  }

  // REST v3.
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (!requireAuth(ctx)) return;
    handleRest(ctx, store);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (
    segments.length >= 2 &&
    (segments[1] as string).endsWith('.git') &&
    (segments[1] as string).length > 4
  ) {
    if (!requireAuth(ctx)) return;
    handleGit(ctx, store);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}
