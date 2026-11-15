// http.ts — small HTTP helpers shared by every surface: request context,
// JSON replies (always application/json with a request id), bearer auth, and
// GitHub-style pagination.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export const JSON_TYPE = 'application/json';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  /** The pathname with a trailing slash removed (except for the root). */
  readonly path: string;
  /** Percent-decoded path segments. */
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: Buffer;
  readonly requestId: string;
  /** "http://<host>" from the Host header, for absolute pagination links. */
  readonly origin: string;
}

export function buildCtx(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  requestId: string,
): Ctx {
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const url = new URL(req.url ?? '/', 'http://entry.invalid');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    // Keep the defaults: an unparsable URL routes to the 404 handler.
  }
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  const segments = pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const host = (req.headers.host ?? 'localhost').toString();
  return {
    req,
    res,
    method: req.method ?? 'GET',
    path: pathname,
    segments,
    query,
    body,
    requestId,
    origin: `http://${host}`,
  };
}

/** Read the whole request body (capped: packs and JSON bodies here are small). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(
  ctx: Ctx,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = JSON.stringify(body);
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  });
  ctx.res.end(text);
}

/** An empty body that still carries the JSON content type and request id (DELETE 204). */
export function sendEmpty(ctx: Ctx, status: number): void {
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': 0,
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end();
}

export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

export function sendBytes(
  ctx: Ctx,
  status: number,
  contentType: string,
  body: Buffer,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  });
  ctx.res.end(body);
}

// ---------------------------------------------------------------------------
// auth

/**
 * Bearer auth. When MAKEFUN_SHOP_TOKEN is set the token must match exactly;
 * in standalone mode (unset) any non-empty bearer token is accepted. The
 * health probe never reaches this check. Returns true when authorized.
 */
export function authorize(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization ?? '';
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') {
    return header === `Bearer ${expected}`;
  }
  return header.startsWith('Bearer ') && header.slice('Bearer '.length).trim() !== '';
}

export function requireAuth(ctx: Ctx): boolean {
  if (authorize(ctx)) return true;
  sendError(ctx, 401, 'Requires authentication');
  return false;
}

// ---------------------------------------------------------------------------
// JSON bodies

export type ParsedBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly empty: boolean };

/** Parse a JSON request body. Empty bodies are `{}` (lenient); garbage is an error. */
export function parseJsonBody(ctx: Ctx): ParsedBody {
  const text = ctx.body.toString('utf8');
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, empty: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a JSON object body for an endpoint that takes an object. Sends the
 * 400 reply and returns null on malformed JSON or a non-object value.
 */
export function requireObjectBody(ctx: Ctx): Record<string, unknown> | null {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Malformed JSON body');
    return null;
  }
  if (!isRecord(parsed.value)) {
    sendError(ctx, 400, 'Request body must be a JSON object');
    return null;
  }
  return parsed.value;
}

// ---------------------------------------------------------------------------
// pagination

export interface PageParams {
  readonly page: number;
  readonly perPage: number;
}

export function pageParams(query: URLSearchParams): PageParams {
  const rawPerPage = Number(query.get('per_page'));
  const rawPage = Number(query.get('page'));
  const perPage =
    Number.isFinite(rawPerPage) && rawPerPage >= 1 ? Math.min(100, Math.floor(rawPerPage)) : 30;
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  return { page, perPage };
}

/**
 * Slice a list for the requested page and build the Link header (absolute
 * URLs on the request's origin). Returns the page items and the header value
 * ("" when the list fits on one page).
 */
export function paginate<T>(
  ctx: Ctx,
  items: readonly T[],
  params: PageParams,
): { readonly pageItems: T[]; readonly link: string } {
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  const page = Math.min(params.page, totalPages);
  const start = (page - 1) * params.perPage;
  const pageItems = items.slice(start, start + params.perPage);
  if (totalPages <= 1) return { pageItems, link: '' };
  const urlFor = (target: number): string => {
    const query = new URLSearchParams(ctx.query);
    query.set('page', String(target));
    query.set('per_page', String(params.perPage));
    return `${ctx.origin}${ctx.path}?${query.toString()}`;
  };
  const links: string[] = [];
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  return { pageItems, link: links.join(', ') };
}

export function linkHeaders(link: string): Record<string, string> {
  return link === '' ? {} : { link };
}

/** Look up a repository for an owner-bearing route; sends the 404 and returns null on a miss. */
export function repoFor(
  ctx: Ctx,
  store: Store,
  owner: string,
  name: string,
): import('./store.ts').Repo | null {
  if (!store.isViewerOwner(owner)) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  const repo = store.getRepo(name);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}
