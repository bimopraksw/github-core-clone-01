// rest.ts — the REST v3 surface: repositories, git refs, branches, commits,
// contents, labels, issues, and pull requests. All state lives in the shared
// store; every reply is JSON with a request id.

import { isOid, parseCommit, parseTree } from './gitcore.ts';
import {
  branchFromRef,
  buildTreeFromFiles,
  createRestCommit,
  diffTrees,
  flattenTree,
  getCommit,
  listCommits,
  mergeBase,
  peelToCommit,
  putObject,
  refForBranch,
  resolveRef,
  threeWayMerge,
  type FlatEntry,
} from './gitops.ts';
import {
  linkHeaders,
  paginate,
  pageParams,
  repoFor,
  requireObjectBody,
  sendEmpty,
  sendError,
  sendJson,
  type Ctx,
} from './http.ts';
import {
  isoForSeq,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

const SCOPES = 'repo, read:org';

function restJson(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(ctx, status, body, { 'x-oauth-scopes': SCOPES, ...extra });
}

function restError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message }, { 'x-oauth-scopes': SCOPES });
}

// ---------------------------------------------------------------------------
// serializers

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbid,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: { login: repo.ownerLogin, id: repo.ownerId, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    created_at: isoForSeq(repo.createdSeq),
    updated_at: isoForSeq(repo.updatedSeq),
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin, id: comment.userId, type: 'User' },
    created_at: isoForSeq(comment.createdSeq),
    updated_at: isoForSeq(comment.updatedSeq),
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { id: 0, name, color: 'ededed', description: '', default: false };
    }),
    user: { login: issue.authorLogin, id: issue.authorId, type: 'User' },
    comments: issue.comments.length,
    closed_at: issue.state === 'closed' ? isoForSeq(issue.updatedSeq) : null,
    created_at: isoForSeq(issue.createdSeq),
    updated_at: isoForSeq(issue.updatedSeq),
  };
}

function pullHeadBase(repo: Repo, pull: Pull): { head: Record<string, unknown>; base: Record<string, unknown> } {
  const headLive = repo.refs.get(refForBranch(pull.headRef));
  const baseLive = repo.refs.get(refForBranch(pull.baseRef));
  return {
    head: { ref: pull.headRef, sha: headLive ?? pull.headShaSnapshot, label: `${repo.ownerLogin}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseLive ?? pull.baseShaSnapshot, label: `${repo.ownerLogin}:${pull.baseRef}` },
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const { head, base } = pullHeadBase(repo, pull);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head,
    base,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? !prHasConflict(repo, pull) : null,
    draft: false,
    user: { login: pull.authorLogin, id: pull.authorId, type: 'User' },
    comments: pull.comments.length,
    closed_at: pull.state === 'closed' ? isoForSeq(pull.updatedSeq) : null,
    created_at: isoForSeq(pull.createdSeq),
    updated_at: isoForSeq(pull.updatedSeq),
  };
}

export function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const commit = getCommit(repo, sha);
  if (commit === null) return null;
  const identJson = (raw: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(raw);
    if (match === null) return { name: raw, email: '', date: isoForSeq(0) };
    return {
      name: match[1],
      email: match[2],
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  };
  return {
    sha,
    commit: {
      message: commit.message,
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

/** True when the pull request's three-way merge currently conflicts. */
export function prHasConflict(repo: Repo, pull: Pull): boolean {
  const headTip = repo.refs.get(refForBranch(pull.headRef)) ?? pull.headShaSnapshot;
  const baseTip = repo.refs.get(refForBranch(pull.baseRef)) ?? pull.baseShaSnapshot;
  const headCommit = getCommit(repo, peelToCommit(repo, headTip) ?? '');
  const baseCommit = getCommit(repo, peelToCommit(repo, baseTip) ?? '');
  if (headCommit === null || baseCommit === null) return false;
  const base = mergeBase(repo, peelToCommit(repo, headTip) as string, peelToCommit(repo, baseTip) as string);
  const baseTree = base === null ? null : (getCommit(repo, base)?.tree ?? null);
  return threeWayMerge(repo, baseTree, baseCommit.tree, headCommit.tree).conflict;
}

// ---------------------------------------------------------------------------
// shared helpers

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function stateFilter(ctx: Ctx): 'open' | 'closed' | 'all' | null {
  const raw = ctx.query.get('state') ?? 'open';
  if (raw === 'open' || raw === 'closed' || raw === 'all') return raw;
  return null;
}

/** Validate a labels value from a request body, resolving names. Null = invalid. */
function resolveLabelNames(repo: Repo, value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry : (entry as Record<string, unknown>)?.name;
    if (typeof name !== 'string' || !repo.labels.has(name)) return null;
    names.push(name);
  }
  return names;
}

export function createIssueInRepo(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labels: string[],
): Issue {
  const createdSeq = store.tick();
  const issue: Issue = {
    number: repo.nextNumber,
    id: store.nextId(),
    title,
    body,
    state: 'open',
    labels,
    authorLogin: store.viewer.login,
    authorId: store.viewer.id,
    createdSeq,
    updatedSeq: createdSeq,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPullInRepo(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull {
  const createdSeq = store.tick();
  const pull: Pull = {
    number: repo.nextNumber,
    id: store.nextId(),
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headShaSnapshot: repo.refs.get(refForBranch(headRef)) ?? '',
    baseShaSnapshot: repo.refs.get(refForBranch(baseRef)) ?? '',
    authorLogin: store.viewer.login,
    authorId: store.viewer.id,
    createdSeq,
    updatedSeq: createdSeq,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/**
 * Perform the squash merge of a pull request. Returns the merge commit id, or
 * null when the merge cannot proceed (the caller sends the 405).
 */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open') return null;
  const headTip = repo.refs.get(refForBranch(pull.headRef));
  const baseTip = repo.refs.get(refForBranch(pull.baseRef));
  if (headTip === undefined || baseTip === undefined) return null;
  const headCommitId = peelToCommit(repo, headTip);
  const baseCommitId = peelToCommit(repo, baseTip);
  if (headCommitId === null || baseCommitId === null) return null;
  const headCommit = getCommit(repo, headCommitId);
  const baseCommit = getCommit(repo, baseCommitId);
  if (headCommit === null || baseCommit === null) return null;
  const base = mergeBase(repo, headCommitId, baseCommitId);
  const baseTree = base === null ? null : (getCommit(repo, base)?.tree ?? null);
  const merged = threeWayMerge(repo, baseTree, baseCommit.tree, headCommit.tree);
  if (merged.conflict) return null;
  const tree = buildTreeFromFiles(repo, merged.files);
  const message = pull.title;
  const sha = createRestCommit(store, repo, tree, [baseCommitId], message);
  repo.refs.set(refForBranch(pull.baseRef), sha);
  const seq = store.tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = isoForSeq(seq);
  pull.updatedSeq = seq;
  return sha;
}

export function addComment(store: Store, target: Issue | Pull, body: string): Comment {
  const seq = store.tick();
  const comment: Comment = {
    id: store.nextId(),
    body,
    userLogin: store.viewer.login,
    userId: store.viewer.id,
    createdSeq: seq,
    updatedSeq: seq,
  };
  target.comments.push(comment);
  return comment;
}

// ---------------------------------------------------------------------------
// contents helpers

function cleanContentPath(segments: readonly string[]): string | null {
  const parts: string[] = [];
  for (const segment of segments) {
    for (const part of segment.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') return null;
      parts.push(part);
    }
  }
  return parts.join('/');
}

interface ContentTarget {
  readonly kind: 'file' | 'dir';
  readonly oid: string;
  readonly mode: string;
  readonly entries: Array<{ mode: string; name: string; oid: string }> | null;
}

/** Walk a tree to a path, returning the file or directory found there. */
function walkToPath(repo: Repo, treeOid: string, parts: readonly string[]): ContentTarget | null {
  let currentOid = treeOid;
  for (let index = 0; index < parts.length; index += 1) {
    const object = repo.objects.get(currentOid);
    if (object === undefined || object.type !== 'tree') return null;
    let entries;
    try {
      entries = parseTree(object.data);
    } catch {
      return null;
    }
    const part = parts[index] as string;
    const entry = entries.find((candidate) => candidate.name === part);
    if (entry === undefined) return null;
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    if (index === parts.length - 1) {
      if (isDir) {
        const dirObject = repo.objects.get(entry.oid);
        if (dirObject === undefined || dirObject.type !== 'tree') return null;
        try {
          return { kind: 'dir', oid: entry.oid, mode: entry.mode, entries: parseTree(dirObject.data) };
        } catch {
          return null;
        }
      }
      return { kind: 'file', oid: entry.oid, mode: entry.mode, entries: null };
    }
    if (!isDir) return null;
    currentOid = entry.oid;
  }
  const rootObject = repo.objects.get(currentOid);
  if (rootObject === undefined || rootObject.type !== 'tree') return null;
  try {
    return { kind: 'dir', oid: currentOid, mode: '40000', entries: parseTree(rootObject.data) };
  } catch {
    return null;
  }
}

function dirListingJson(
  repo: Repo,
  entries: Array<{ mode: string; name: string; oid: string }>,
  dirPath: string,
): Array<Record<string, unknown>> {
  return entries.map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const blob = isDir ? undefined : repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      sha: entry.oid,
      size: blob?.data.length ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// the router

export function handleRest(ctx: Ctx, store: Store): void {
  // ctx.segments starts with ['api', 'v3', ...]; strip the prefix.
  const rest = ctx.segments.slice(2);
  const { method } = ctx;

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method === 'GET') {
      restJson(ctx, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_repositories_url: '/api/v3/user/repos',
      });
    } else {
      restError(ctx, 404, 'Not Found');
    }
    return;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method === 'GET') restJson(ctx, 200, { installed_version: '1.0.0' });
    else restError(ctx, 404, 'Not Found');
    return;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method === 'GET') {
      restJson(ctx, 200, {
        login: store.viewer.login,
        id: store.viewer.id,
        name: store.viewer.name,
        email: store.viewer.email,
        type: 'User',
        created_at: isoForSeq(0),
        updated_at: isoForSeq(0),
      });
    } else {
      restError(ctx, 404, 'Not Found');
    }
    return;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const params = pageParams(ctx.query);
      const { pageItems, link } = paginate(ctx, store.listRepos(), params);
      restJson(ctx, 200, pageItems.map((repo) => repoJson(store, repo)), linkHeaders(link));
      return;
    }
    if (method === 'POST') {
      const body = requireObjectBody(ctx);
      if (body === null) return;
      const name = body.name;
      if (
        typeof name !== 'string' ||
        name === '' ||
        name.length > 100 ||
        /[\s/\\]/.test(name) ||
        /[\u0000-\u001f]/.test(name)
      ) {
        restError(ctx, 422, 'Repository name is invalid');
        return;
      }
      if (store.hasRepo(name)) {
        restError(ctx, 422, `Repository ${name} already exists`);
        return;
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = store.createRepo(name, description, isPrivate);
      restJson(ctx, 201, repoJson(store, repo));
      return;
    }
    restError(ctx, 404, 'Not Found');
    return;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const repo = repoFor(ctx, store, owner, name);
    if (repo === null) return;
    handleRepoRoute(ctx, store, repo, rest.slice(3));
    return;
  }

  restError(ctx, 404, 'Not Found');
}

function handleRepoRoute(ctx: Ctx, store: Store, repo: Repo, tail: readonly string[]): void {
  const { method } = ctx;

  // The repository itself.
  if (tail.length === 0) {
    if (method === 'GET') {
      restJson(ctx, 200, repoJson(store, repo));
    } else if (method === 'PATCH') {
      const body = requireObjectBody(ctx);
      if (body === null) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedSeq = store.tick();
      restJson(ctx, 200, repoJson(store, repo));
    } else if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      sendEmpty(ctx, 204);
    } else {
      restError(ctx, 404, 'Not Found');
    }
    return;
  }

  const head = tail[0] as string;

  // ---- git refs ----
  if (head === 'git' && tail[1] === 'refs') {
    handleGitRefs(ctx, store, repo, tail.slice(2));
    return;
  }

  // ---- branches ----
  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, oid] of repo.refs) {
        const branch = branchFromRef(ref);
        if (branch !== null) branches.push({ name: branch, commit: { sha: oid }, protected: false });
      }
      const params = pageParams(ctx.query);
      const { pageItems, link } = paginate(ctx, branches, params);
      restJson(ctx, 200, pageItems, linkHeaders(link));
      return;
    }
    if (tail.length > 1 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const oid = repo.refs.get(refForBranch(branch));
      if (oid === undefined) {
        restError(ctx, 404, 'Not Found');
        return;
      }
      const commit = commitJson(repo, peelToCommit(repo, oid) ?? oid);
      restJson(ctx, 200, {
        name: branch,
        commit: { sha: oid, commit: commit?.commit ?? { message: '' } },
        protected: false,
      });
      return;
    }
    restError(ctx, 404, 'Not Found');
    return;
  }

  // ---- commits ----
  if (head === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const refish = ctx.query.get('sha') ?? repo.defaultBranch;
      const resolved = resolveRef(repo, refish);
      if (resolved === null) {
        restError(ctx, 404, 'Not Found');
        return;
      }
      const commitId = peelToCommit(repo, resolved);
      if (commitId === null) {
        restJson(ctx, 200, []);
        return;
      }
      const shas = listCommits(repo, commitId, 100000);
      const params = pageParams(ctx.query);
      const { pageItems, link } = paginate(ctx, shas, params);
      const items = pageItems
        .map((sha) => commitJson(repo, sha))
        .filter((item): item is Record<string, unknown> => item !== null);
      restJson(ctx, 200, items, linkHeaders(link));
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const resolved = resolveRef(repo, tail[1] as string);
      const commitId = resolved === null ? null : peelToCommit(repo, resolved);
      if (commitId === null) {
        restError(ctx, 404, 'Not Found');
        return;
      }
      const json = commitJson(repo, commitId);
      if (json === null) restError(ctx, 404, 'Not Found');
      else restJson(ctx, 200, json);
      return;
    }
    restError(ctx, 404, 'Not Found');
    return;
  }

  // ---- contents ----
  if (head === 'contents') {
    handleContents(ctx, store, repo, tail.slice(1));
    return;
  }

  // ---- labels ----
  if (head === 'labels') {
    if (tail.length === 1 && method === 'GET') {
      const params = pageParams(ctx.query);
      const { pageItems, link } = paginate(ctx, [...repo.labels.values()], params);
      restJson(ctx, 200, pageItems.map(labelJson), linkHeaders(link));
      return;
    }
    if (tail.length === 1 && method === 'POST') {
      const body = requireObjectBody(ctx);
      if (body === null) return;
      const name = body.name;
      if (typeof name !== 'string' || name === '') {
        restError(ctx, 422, 'Label name is required');
        return;
      }
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        restJson(ctx, 201, labelJson(existing));
        return;
      }
      const label: Label = {
        id: store.nextId(),
        name,
        color: typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
      };
      repo.labels.set(name, label);
      restJson(ctx, 201, labelJson(label));
      return;
    }
    restError(ctx, 404, 'Not Found');
    return;
  }

  // ---- issues ----
  if (head === 'issues') {
    handleIssues(ctx, store, repo, tail.slice(1));
    return;
  }

  // ---- pulls ----
  if (head === 'pulls') {
    handlePulls(ctx, store, repo, tail.slice(1));
    return;
  }

  restError(ctx, 404, 'Not Found');
}

function handleGitRefs(ctx: Ctx, store: Store, repo: Repo, tail: readonly string[]): void {
  const { method } = ctx;
  if (method === 'POST' && tail.length === 0) {
    const body = requireObjectBody(ctx);
    if (body === null) return;
    const ref = body.ref;
    const sha = body.sha;
    if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.length < 6) {
      restError(ctx, 422, 'ref must start with refs/');
      return;
    }
    if (typeof sha !== 'string' || !isOid(sha) || !repo.objects.has(sha)) {
      restError(ctx, 422, 'sha does not name a known object');
      return;
    }
    if (repo.refs.has(ref)) {
      restError(ctx, 422, 'Reference already exists');
      return;
    }
    repo.refs.set(ref, sha);
    restJson(ctx, 201, { ref, object: { sha } });
    return;
  }
  if (method === 'GET') {
    if (tail.length === 0) {
      const all = [...repo.refs.keys()].sort().map((ref) => ({ ref, object: { sha: repo.refs.get(ref) as string } }));
      restJson(ctx, 200, all);
      return;
    }
    const candidate = `refs/${tail.join('/')}`;
    const exact = repo.refs.get(candidate);
    if (exact !== undefined) {
      restJson(ctx, 200, { ref: candidate, object: { sha: exact } });
      return;
    }
    const matches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith(candidate))
      .sort()
      .map((ref) => ({ ref, object: { sha: repo.refs.get(ref) as string } }));
    if (matches.length > 0) {
      restJson(ctx, 200, matches);
      return;
    }
    restError(ctx, 404, 'Not Found');
    return;
  }
  restError(ctx, 404, 'Not Found');
}

function handleContents(ctx: Ctx, store: Store, repo: Repo, tail: readonly string[]): void {
  const { method } = ctx;
  const path = cleanContentPath(tail);
  if (path === null) {
    restError(ctx, 422, 'Invalid content path');
    return;
  }

  if (method === 'GET') {
    const refish = ctx.query.get('ref') ?? repo.defaultBranch;
    const resolved = resolveRef(repo, refish);
    const commitId = resolved === null ? null : peelToCommit(repo, resolved);
    if (commitId === null) {
      restError(ctx, 404, 'Not Found');
      return;
    }
    const commit = getCommit(repo, commitId);
    if (commit === null) {
      restError(ctx, 404, 'Not Found');
      return;
    }
    const parts = path === '' ? [] : path.split('/');
    const target = walkToPath(repo, commit.tree, parts);
    if (target === null) {
      restError(ctx, 404, 'Not Found');
      return;
    }
    if (target.kind === 'dir') {
      restJson(ctx, 200, dirListingJson(repo, target.entries ?? [], path));
      return;
    }
    const blob = repo.objects.get(target.oid);
    if (blob === undefined || blob.type !== 'blob') {
      restError(ctx, 404, 'Not Found');
      return;
    }
    const name = parts[parts.length - 1] as string;
    restJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name,
      path,
      sha: target.oid,
      content: blob.data.toString('base64'),
    });
    return;
  }

  if (method === 'PUT') {
    const body = requireObjectBody(ctx);
    if (body === null) return;
    if (path === '') {
      restError(ctx, 422, 'A file path is required');
      return;
    }
    const content = body.content;
    if (typeof content !== 'string') {
      restError(ctx, 422, 'content is required');
      return;
    }
    const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const branchRef = refForBranch(branch);
    let tip = repo.refs.get(branchRef);
    let baseCommitId: string | null = null;
    if (tip !== undefined) {
      baseCommitId = peelToCommit(repo, tip);
    } else {
      // An unknown branch is created from the default branch tip (or the root).
      const defaultTip = repo.refs.get(refForBranch(repo.defaultBranch));
      if (defaultTip !== undefined) {
        baseCommitId = peelToCommit(repo, defaultTip);
        tip = defaultTip;
      }
    }
    const baseTree = baseCommitId === null ? null : (getCommit(repo, baseCommitId)?.tree ?? null);
    const files = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, baseTree);
    const existing = files.get(path);
    const givenSha = body.sha;
    if (existing !== undefined) {
      if (typeof givenSha !== 'string') {
        restError(ctx, 422, 'sha is required to update an existing file');
        return;
      }
      if (givenSha !== existing.oid) {
        restError(ctx, 409, 'sha does not match the current file');
        return;
      }
    }
    const blobData = Buffer.from(content, 'base64');
    const blobOid = putObject(repo, 'blob', blobData);
    files.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
    const tree = buildTreeFromFiles(repo, files);
    const parents = baseCommitId === null ? [] : [baseCommitId];
    const commitSha = createRestCommit(store, repo, tree, parents, message);
    repo.refs.set(branchRef, commitSha);
    restJson(ctx, existing === undefined ? 201 : 200, {
      content: {
        name: path.split('/').pop() as string,
        path,
        sha: blobOid,
        size: blobData.length,
        encoding: 'base64',
        content: blobData.toString('base64'),
      },
      commit: { sha: commitSha, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = requireObjectBody(ctx);
    if (body === null) return;
    if (path === '') {
      restError(ctx, 422, 'A file path is required');
      return;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(refForBranch(branch));
    const baseCommitId = tip === undefined ? null : peelToCommit(repo, tip);
    if (baseCommitId === null) {
      restError(ctx, 404, 'Not Found');
      return;
    }
    const commit = getCommit(repo, baseCommitId);
    if (commit === null) {
      restError(ctx, 404, 'Not Found');
      return;
    }
    const files = flattenTree(repo, commit.tree);
    const existing = files.get(path);
    if (existing === undefined) {
      restError(ctx, 404, 'Not Found');
      return;
    }
    const givenSha = body.sha;
    if (typeof givenSha !== 'string') {
      restError(ctx, 422, 'sha is required to delete a file');
      return;
    }
    if (givenSha !== existing.oid) {
      restError(ctx, 409, 'sha does not match the current file');
      return;
    }
    const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
    files.delete(path);
    const tree = buildTreeFromFiles(repo, files);
    const commitSha = createRestCommit(store, repo, tree, [baseCommitId], message);
    repo.refs.set(refForBranch(branch), commitSha);
    restJson(ctx, 200, { commit: { sha: commitSha, message }, content: null });
    return;
  }

  restError(ctx, 404, 'Not Found');
}

function handleIssues(ctx: Ctx, store: Store, repo: Repo, tail: readonly string[]): void {
  const { method } = ctx;

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = stateFilter(ctx);
      if (state === null) {
        restError(ctx, 422, 'state must be open, closed, or all');
        return;
      }
      const direction = ctx.query.get('direction') ?? 'desc';
      const ascending = direction === 'asc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) =>
        ascending ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number,
      );
      const params = pageParams(ctx.query);
      const { pageItems, link } = paginate(ctx, issues, params);
      restJson(ctx, 200, pageItems.map((issue) => issueJson(repo, issue)), linkHeaders(link));
      return;
    }
    if (method === 'POST') {
      const body = requireObjectBody(ctx);
      if (body === null) return;
      const title = body.title;
      if (typeof title !== 'string' || title === '') {
        restError(ctx, 422, 'title is required');
        return;
      }
      const labels = resolveLabelNames(repo, body.labels);
      if (labels === null) {
        restError(ctx, 422, 'One or more labels do not exist');
        return;
      }
      const issueBody = typeof body.body === 'string' ? body.body : '';
      const issue = createIssueInRepo(store, repo, title, issueBody, labels);
      restJson(ctx, 201, issueJson(repo, issue));
      return;
    }
    restError(ctx, 404, 'Not Found');
    return;
  }

  const number = parseNumber(tail[0] as string);
  if (number === null) {
    restError(ctx, 404, 'Not Found');
    return;
  }
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    restError(ctx, 404, 'Not Found');
    return;
  }

  if (tail.length === 1) {
    if (method === 'GET') {
      restJson(ctx, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = requireObjectBody(ctx);
      if (body === null) return;
      if (body.state !== undefined) {
        if (body.state !== 'open' && body.state !== 'closed') {
          restError(ctx, 422, 'state must be open or closed');
          return;
        }
        issue.state = body.state;
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.labels !== undefined) {
        const labels = resolveLabelNames(repo, body.labels);
        if (labels === null) {
          restError(ctx, 422, 'One or more labels do not exist');
          return;
        }
        issue.labels = labels;
      }
      issue.updatedSeq = store.tick();
      restJson(ctx, 200, issueJson(repo, issue));
      return;
    }
    restError(ctx, 404, 'Not Found');
    return;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      const params = pageParams(ctx.query);
      const { pageItems, link } = paginate(ctx, issue.comments, params);
      restJson(ctx, 200, pageItems.map(commentJson), linkHeaders(link));
      return;
    }
    if (method === 'POST') {
      const body = requireObjectBody(ctx);
      if (body === null) return;
      if (typeof body.body !== 'string' || body.body === '') {
        restError(ctx, 422, 'body is required');
        return;
      }
      const comment = addComment(store, issue, body.body);
      restJson(ctx, 201, commentJson(comment));
      return;
    }
  }

  restError(ctx, 404, 'Not Found');
}

function handlePulls(ctx: Ctx, store: Store, repo: Repo, tail: readonly string[]): void {
  const { method } = ctx;

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = stateFilter(ctx);
      if (state === null) {
        restError(ctx, 422, 'state must be open, closed, or all');
        return;
      }
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      const params = pageParams(ctx.query);
      const { pageItems, link } = paginate(ctx, pulls, params);
      restJson(ctx, 200, pageItems.map((pull) => pullJson(repo, pull)), linkHeaders(link));
      return;
    }
    if (method === 'POST') {
      const body = requireObjectBody(ctx);
      if (body === null) return;
      const title = body.title;
      if (typeof title !== 'string' || title === '') {
        restError(ctx, 422, 'title is required');
        return;
      }
      const head = typeof body.head === 'string' ? body.head.replace(/^refs\/heads\//, '') : '';
      const base = typeof body.base === 'string' ? body.base.replace(/^refs\/heads\//, '') : '';
      if (head === '' || base === '') {
        restError(ctx, 422, 'head and base branches are required');
        return;
      }
      if (!repo.refs.has(refForBranch(head)) || !repo.refs.has(refForBranch(base))) {
        restError(ctx, 422, 'head or base branch does not exist');
        return;
      }
      const pullBody = typeof body.body === 'string' ? body.body : '';
      const pull = createPullInRepo(store, repo, title, pullBody, head, base);
      restJson(ctx, 201, pullJson(repo, pull));
      return;
    }
    restError(ctx, 404, 'Not Found');
    return;
  }

  const number = parseNumber(tail[0] as string);
  if (number === null) {
    restError(ctx, 404, 'Not Found');
    return;
  }
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    restError(ctx, 404, 'Not Found');
    return;
  }

  if (tail.length === 1) {
    if (method === 'GET') {
      restJson(ctx, 200, pullJson(repo, pull));
      return;
    }
    if (method === 'PATCH') {
      const body = requireObjectBody(ctx);
      if (body === null) return;
      if (body.state !== undefined) {
        if (body.state !== 'open' && body.state !== 'closed') {
          restError(ctx, 422, 'state must be open or closed');
          return;
        }
        pull.state = body.state;
      }
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      pull.updatedSeq = store.tick();
      restJson(ctx, 200, pullJson(repo, pull));
      return;
    }
    restError(ctx, 404, 'Not Found');
    return;
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const headTip = repo.refs.get(refForBranch(pull.headRef));
    const baseTip = repo.refs.get(refForBranch(pull.baseRef));
    const headId = headTip === undefined ? null : peelToCommit(repo, headTip);
    const baseId = baseTip === undefined ? null : peelToCommit(repo, baseTip);
    if (headId === null || baseId === null) {
      restJson(ctx, 200, []);
      return;
    }
    const headCommit = getCommit(repo, headId);
    const base = mergeBase(repo, headId, baseId);
    const baseTree = base === null ? null : (getCommit(repo, base)?.tree ?? null);
    const files = headCommit === null ? [] : diffTrees(repo, baseTree, headCommit.tree);
    restJson(ctx, 200, files);
    return;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const body = requireObjectBody(ctx);
    if (body === null) return;
    if (pull.state !== 'open') {
      restError(ctx, 405, 'Pull request is already merged or closed');
      return;
    }
    const sha = squashMerge(store, repo, pull);
    if (sha === null) {
      restError(ctx, 405, 'Merge conflict: the pull request cannot be merged');
      return;
    }
    restJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      const params = pageParams(ctx.query);
      const { pageItems, link } = paginate(ctx, pull.comments, params);
      restJson(ctx, 200, pageItems.map(commentJson), linkHeaders(link));
      return;
    }
    if (method === 'POST') {
      const body = requireObjectBody(ctx);
      if (body === null) return;
      if (typeof body.body !== 'string' || body.body === '') {
        restError(ctx, 422, 'body is required');
        return;
      }
      const comment = addComment(store, pull, body.body);
      restJson(ctx, 201, commentJson(comment));
      return;
    }
  }

  restError(ctx, 404, 'Not Found');
}

// Re-exported for the GraphQL and MCP surfaces.
export { parseCommit };
