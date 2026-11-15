// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over POST /mcp,
// stateless (no session ids), six tools over the shared store. Implements the
// modern `server/discover` handshake and the legacy `initialize` handshake,
// notifications, ping, tools/list, and tools/call.

import { refForBranch } from './gitops.ts';
import { sendError, sendJson, type Ctx } from './http.ts';
import {
  createIssueInRepo,
  createPullInRepo,
  issueJson,
  pullJson,
  repoJson,
  squashMerge,
} from './rest.ts';
import type { Store } from './store.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// The one tool list: built from this constant every time, so tools/list
// answers are byte-identical across calls.
const TOOLS: readonly Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'The repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const REQUIRED_ARGS: Readonly<Record<string, readonly string[]>> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

type JsonRpcId = string | number | null;

interface RpcError {
  readonly code: number;
  readonly message: string;
}

function resultResponse(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: JsonRpcId, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message } };
}

function textResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function missingArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  return value === undefined || value === null || value === '';
}

function pullNumberOf(args: Record<string, unknown>): number | null {
  const raw = args.pull_number ?? args.number ?? args.pull_request_number;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 1) return value;
  }
  return null;
}

function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { readonly ok: true; readonly result: Record<string, unknown> } | { readonly ok: false; readonly error: RpcError } {
  const required = REQUIRED_ARGS[name];
  if (required === undefined) {
    return { ok: false, error: { code: -32602, message: `Unknown tool "${name}"` } };
  }
  for (const arg of required) {
    if (arg === 'pull_number') {
      if (pullNumberOf(args) === null) {
        return { ok: false, error: { code: -32602, message: `Missing required argument "pull_number"` } };
      }
      continue;
    }
    if (missingArg(args, arg)) {
      return { ok: false, error: { code: -32602, message: `Missing required argument "${arg}"` } };
    }
  }

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (store.hasRepo(repoName)) {
      const existing = store.getRepo(repoName) as NonNullable<ReturnType<Store['getRepo']>>;
      return { ok: true, result: textResult(repoJson(store, existing)) };
    }
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const repo = store.createRepo(repoName, description, isPrivate);
    return { ok: true, result: textResult(repoJson(store, repo)) };
  }

  // Every other tool names a repository.
  const owner = String(args.owner);
  const repoName = String(args.repo);
  if (!store.isViewerOwner(owner)) {
    return { ok: true, result: toolError(`Repository ${owner}/${repoName} was not found`) };
  }
  const repo = store.getRepo(repoName);
  if (repo === undefined) {
    return { ok: true, result: toolError(`Repository ${owner}/${repoName} was not found`) };
  }

  if (name === 'get_repo') {
    return { ok: true, result: textResult(repoJson(store, repo)) };
  }

  if (name === 'create_issue') {
    const title = String(args.title);
    const body = typeof args.body === 'string' ? args.body : '';
    const issue = createIssueInRepo(store, repo, title, body, []);
    return { ok: true, result: textResult(issueJson(repo, issue)) };
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => a.number - b.number);
    const list = issues.map((issue) => issueJson(repo, issue));
    return { ok: true, result: textResult(list) };
  }

  if (name === 'create_pull_request') {
    const head = String(args.head).replace(/^refs\/heads\//, '');
    const base = String(args.base).replace(/^refs\/heads\//, '');
    if (!repo.refs.has(refForBranch(head)) || !repo.refs.has(refForBranch(base))) {
      return { ok: true, result: toolError('head or base branch does not exist') };
    }
    const title = String(args.title);
    const body = typeof args.body === 'string' ? args.body : '';
    const pull = createPullInRepo(store, repo, title, body, head, base);
    return { ok: true, result: textResult(pullJson(repo, pull)) };
  }

  if (name === 'merge_pull_request') {
    const number = pullNumberOf(args) as number;
    const pull = repo.pulls.get(number);
    if (pull === undefined) {
      return { ok: true, result: toolError(`Pull request #${number} was not found`) };
    }
    if (pull.state !== 'open') {
      return { ok: true, result: toolError(`Pull request #${number} is already merged or closed`) };
    }
    const sha = squashMerge(store, repo, pull);
    if (sha === null) {
      return { ok: true, result: toolError(`Pull request #${number} has a merge conflict`) };
    }
    return { ok: true, result: textResult({ sha, merged: true, message: 'Pull Request successfully merged', pull_request: pullJson(repo, pull) }) };
  }

  return { ok: false, error: { code: -32602, message: `Unknown tool "${name}"` } };
}

function dispatchOne(request: unknown, store: Store): Record<string, unknown> | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return errorResponse(null, { code: -32600, message: 'Invalid Request' });
  }
  const message = request as Record<string, unknown>;
  const id = (message.id as JsonRpcId | undefined) ?? null;
  const hasId = 'id' in message && message.id !== undefined;
  const method = message.method;
  if (typeof method !== 'string') {
    return hasId ? errorResponse(id, { code: -32600, message: 'Invalid Request: method is required' }) : null;
  }
  const params = (message.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are acknowledged with no response body.
  if (!hasId) return null;

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return resultResponse(id, {
      supportedVersions: [...PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': { ...serverInfo } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = PROTOCOL_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return resultResponse(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return resultResponse(id, {});
  }

  if (method === 'tools/list') {
    return resultResponse(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') {
      return errorResponse(id, { code: -32602, message: 'tools/call requires a tool name' });
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return errorResponse(id, { code: -32602, message: 'tools/call arguments must be an object' });
    }
    const called = callTool(store, toolName, args);
    if (!called.ok) return errorResponse(id, called.error);
    return resultResponse(id, called.result);
  }

  return errorResponse(id, { code: -32601, message: `Method not found: ${method}` });
}

export function handleMcp(ctx: Ctx, store: Store): void {
  if (ctx.method === 'GET' || ctx.method === 'DELETE') {
    sendError(ctx, 405, 'Method Not Allowed');
    return;
  }
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const text = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : (JSON.parse(text) as unknown);
  } catch {
    sendJson(ctx, 400, errorResponse(null, { code: -32700, message: 'Parse error' }));
    return;
  }
  if (Array.isArray(parsed)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      const response = dispatchOne(entry, store);
      if (response !== null) responses.push(response);
    }
    sendJson(ctx, 200, responses);
    return;
  }
  const response = dispatchOne(parsed, store);
  if (response === null) {
    // A notification: acknowledge with an empty 202.
    ctx.res.writeHead(202, { 'content-length': 0, 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  sendJson(ctx, 200, response);
}
