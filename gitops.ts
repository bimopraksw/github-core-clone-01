// gitops.ts — repository-level git operations over the store: ref resolution,
// history traversal, tree flattening/rebuilding, diffs, three-way merges, and
// the fetch object-selection algorithm shared by the v0 and v2 protocols.

import {
  buildCommit,
  buildTree,
  ident,
  isOid,
  oidOf,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './gitcore.ts';
import { isoForSeq, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// refs

export function refForBranch(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

export function branchFromRef(ref: string): string | null {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

/**
 * Resolve a ref-ish to an object id: a full object id, HEAD, a full ref name,
 * or a short branch/tag name. Returns null when nothing resolves.
 */
export function resolveRef(repo: Repo, refish: string): string | null {
  if (isOid(refish) && repo.objects.has(refish)) return refish;
  if (refish === 'HEAD') {
    return repo.refs.get(refForBranch(repo.defaultBranch)) ?? null;
  }
  if (refish.startsWith('refs/')) return repo.refs.get(refish) ?? null;
  const head = repo.refs.get(`refs/heads/${refish}`);
  if (head !== undefined) return head;
  const tag = repo.refs.get(`refs/tags/${refish}`);
  if (tag !== undefined) return tag;
  return null;
}

/** Peel tags to the object they ultimately name (following tag chains). */
export function peel(repo: Repo, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag' || seen.has(current)) return current;
    seen.add(current);
    try {
      current = parseTag(object.data).object;
    } catch {
      return current;
    }
  }
}

/** Peel to a commit id, or null when the object is not (a tag to) a commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  const peeled = peel(repo, oid);
  return repo.objects.get(peeled)?.type === 'commit' ? peeled : null;
}

export function getCommit(repo: Repo, oid: string): ReturnType<typeof parseCommit> | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  try {
    return parseCommit(object.data);
  } catch {
    return null;
  }
}

/** True when `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = getCommit(repo, current);
    if (commit !== null) stack.push(...commit.parents);
  }
  return false;
}

/** The merge base of two commits: the nearest common ancestor by BFS distance. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [current, dist] = queueA.shift() as [string, number];
    if (distA.has(current)) continue;
    distA.set(current, dist);
    const commit = getCommit(repo, current);
    if (commit !== null) {
      for (const parent of commit.parents) queueA.push([parent, dist + 1]);
    }
  }
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  const seenB = new Set<string>();
  const queueB: Array<[string, number]> = [[b, 0]];
  while (queueB.length > 0) {
    const [current, dist] = queueB.shift() as [string, number];
    if (seenB.has(current)) continue;
    seenB.add(current);
    const da = distA.get(current);
    if (da !== undefined && da + dist < bestDist) {
      best = current;
      bestDist = da + dist;
    }
    if (dist + 1 > bestDist) continue;
    const commit = getCommit(repo, current);
    if (commit !== null) {
      for (const parent of commit.parents) queueB.push([parent, dist + 1]);
    }
  }
  return best;
}

/** Commits reachable from a tip, newest-first (DFS pre-order), deduplicated. */
export function listCommits(repo: Repo, tip: string, limit: number): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (oid: string): void => {
    if (seen.has(oid) || order.length >= limit) return;
    const commit = getCommit(repo, oid);
    if (commit === null) return;
    seen.add(oid);
    order.push(oid);
    for (const parent of commit.parents) visit(parent);
  };
  visit(tip);
  return order;
}

// ---------------------------------------------------------------------------
// trees

export interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

/** Flatten a tree (recursively) into path -> blob entries. Gitlinks are kept as entries. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    let entries: TreeEntry[];
    try {
      entries = parseTree(object.data);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Full object closure of a tree: the tree, its subtrees, and its blobs. */
export function treeClosure(repo: Repo, treeOid: string, out: Set<string>): void {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree' || out.has(treeOid)) return;
  out.add(treeOid);
  let entries: TreeEntry[];
  try {
    entries = parseTree(object.data);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.mode === '40000' || entry.mode === '040000') treeClosure(repo, entry.oid, out);
    else if (entry.mode !== '160000') out.add(entry.oid);
  }
}

/**
 * Build (and store) the tree objects for a flat path map, returning the root
 * tree id. Intermediate directories are created as needed.
 */
export function buildTreeFromFiles(repo: Repo, files: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    entries: Map<string, TreeEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { entries: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/').filter((part) => part !== '');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { entries: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    const leaf = parts[parts.length - 1] as string;
    node.entries.set(leaf, { mode: file.mode, name: leaf, oid: file.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.entries.values()];
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    const oid = oidOf('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Store an object, returning its id. */
export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = oidOf(type, data);
  repo.objects.set(oid, { type, data });
  return oid;
}

/**
 * Create a commit object (stored) for a REST-driven change: deterministic
 * author/committer identity and timestamp from the store's sequence clock.
 */
export function createRestCommit(
  store: Store,
  repo: Repo,
  tree: string,
  parents: readonly string[],
  message: string,
): string {
  const seq = store.tick();
  const author = ident(store.viewer.name, store.viewer.email, 1700000000 + seq);
  const data = buildCommit(tree, parents, author, author, message);
  return putObject(repo, 'commit', data);
}

/** The deterministic timestamp string for a commit made at sequence `seq`. */
export function commitTimeIso(seq: number): string {
  return isoForSeq(seq);
}

// ---------------------------------------------------------------------------
// diffs and merges

export interface DiffEntry {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha: string;
}

function countLines(data: Buffer): Map<string, number> {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldCounts = countLines(oldData);
  const newCounts = countLines(newData);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    const diff = count - (oldCounts.get(line) ?? 0);
    if (diff > 0) additions += diff;
  }
  for (const [line, count] of oldCounts) {
    const diff = count - (newCounts.get(line) ?? 0);
    if (diff > 0) deletions += diff;
  }
  return { additions, deletions };
}

const EMPTY = Buffer.alloc(0);

/** Diff two trees (by id; null means the empty tree). Sorted by filename. */
export function diffTrees(repo: Repo, oldTree: string | null, newTree: string | null): DiffEntry[] {
  const oldFiles = oldTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, oldTree);
  const newFiles = newTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, newTree);
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const entries: DiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      const data = repo.objects.get(newEntry.oid)?.data ?? EMPTY;
      const { additions } = lineDiff(EMPTY, data);
      entries.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const data = repo.objects.get(oldEntry.oid)?.data ?? EMPTY;
      const { deletions } = lineDiff(data, EMPTY);
      entries.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: oldEntry.oid });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? EMPTY;
      const newData = repo.objects.get(newEntry.oid)?.data ?? EMPTY;
      const { additions, deletions } = lineDiff(oldData, newData);
      entries.push({
        filename: path,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        sha: newEntry.oid,
      });
    }
  }
  return entries;
}

export interface MergeResult {
  readonly conflict: boolean;
  readonly files: Map<string, FlatEntry>;
}

/**
 * Three-way merge: base -> ours, base -> theirs. A path conflicts only when
 * both sides changed it differently from the base; identical results on both
 * sides never conflict.
 */
export function threeWayMerge(
  repo: Repo,
  baseTree: string | null,
  oursTree: string | null,
  theirsTree: string | null,
): MergeResult {
  const base = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, baseTree);
  const ours = oursTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, oursTree);
  const theirs = theirsTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, theirsTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const files = new Map<string, FlatEntry>();
  let conflict = false;
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const bOid = b?.oid ?? null;
    const oOid = o?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (oOid === tOid) {
      if (o !== undefined) files.set(path, o);
    } else if (oOid === bOid) {
      if (t !== undefined) files.set(path, t);
    } else if (tOid === bOid) {
      if (o !== undefined) files.set(path, o);
    } else {
      conflict = true;
    }
  }
  return { conflict, files };
}

// ---------------------------------------------------------------------------
// fetch object selection (shared by protocol v0 and v2)

export interface FetchParams {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  readonly shallowBoundaries: readonly string[];
  readonly depth?: number;
  readonly deepenSince?: number;
  readonly deepenNot: readonly string[];
  readonly filter?: string;
}

export interface FetchSelection {
  /** Object ids to send, in deterministic (sorted) order. */
  readonly objects: string[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
}

/**
 * Select the objects a fetch must send:
 * - allowed commits: within `depth` generations of the wants (or the full
 *   closure), stopping at `deepen-since` timestamps;
 * - excluded: the closure of the haves, stopping traversal at the client's
 *   shallow boundaries (the boundary itself is excluded, its parents are not
 *   traversed), plus the `deepen-not` histories;
 * - sent: the full tree/blob closure of the allowed-minus-excluded commits,
 *   minus the closure of the excluded commits, minus anything the filter
 *   drops.
 */
export function selectFetchObjects(repo: Repo, params: FetchParams): FetchSelection {
  const depth = params.depth;
  const boundaries = new Set(params.shallowBoundaries);

  // Peel wants: tags are sent themselves and traversed through to commits.
  const wantTags: string[] = [];
  const wantCommits: string[] = [];
  const directObjects = new Set<string>();
  for (const want of params.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wantTags.push(want);
      const commit = peelToCommit(repo, want);
      if (commit !== null) wantCommits.push(commit);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    } else {
      directObjects.add(want);
    }
  }

  // Allowed commits with distances from the wants.
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = wantCommits.map((oid) => [oid, 0]);
  while (queue.length > 0) {
    const [current, d] = queue.shift() as [string, number];
    if (dist.has(current)) continue;
    const commit = getCommit(repo, current);
    if (commit === null) continue;
    if (params.deepenSince !== undefined && commit.committerTime < params.deepenSince) continue;
    dist.set(current, d);
    if (depth !== undefined && d >= depth - 1) continue;
    for (const parent of commit.parents) queue.push([parent, d + 1]);
  }
  const allowed = new Set(dist.keys());

  // Excluded commits: closure of the haves (and deepen-not roots), stopping
  // traversal at shallow boundaries.
  const excluded = new Set<string>();
  const exclusionRoots: string[] = [];
  for (const have of params.haves) {
    const commit = peelToCommit(repo, have);
    if (commit !== null) exclusionRoots.push(commit);
  }
  for (const refName of params.deepenNot) {
    const resolved = resolveRef(repo, refName);
    if (resolved !== null) {
      const commit = peelToCommit(repo, resolved);
      if (commit !== null) exclusionRoots.push(commit);
    }
  }
  const exQueue = [...exclusionRoots];
  while (exQueue.length > 0) {
    const current = exQueue.pop() as string;
    if (excluded.has(current)) continue;
    excluded.add(current);
    if (boundaries.has(current)) continue;
    const commit = getCommit(repo, current);
    if (commit !== null) exQueue.push(...commit.parents);
  }

  const sendCommits = [...allowed].filter((oid) => !excluded.has(oid));

  // Closure of the sent commits, minus the closure of the excluded commits.
  const closure = new Set<string>();
  for (const oid of sendCommits) {
    closure.add(oid);
    const commit = getCommit(repo, oid);
    if (commit !== null) treeClosure(repo, commit.tree, closure);
  }
  for (const tag of wantTags) closure.add(tag);
  for (const oid of directObjects) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tree') treeClosure(repo, oid, closure);
    else closure.add(oid);
  }
  const excludedClosure = new Set<string>();
  for (const oid of excluded) {
    excludedClosure.add(oid);
    const commit = getCommit(repo, oid);
    if (commit !== null) treeClosure(repo, commit.tree, excludedClosure);
  }
  for (const oid of excludedClosure) closure.delete(oid);

  // Filters: blob:none, blob:limit=N, tree:0.
  const filter = params.filter;
  if (filter !== undefined && filter !== '') {
    if (filter === 'blob:none') {
      for (const oid of [...closure]) {
        if (repo.objects.get(oid)?.type === 'blob') closure.delete(oid);
      }
    } else if (filter.startsWith('blob:limit=')) {
      const limit = Number(filter.slice('blob:limit='.length));
      if (Number.isFinite(limit)) {
        for (const oid of [...closure]) {
          const object = repo.objects.get(oid);
          if (object?.type === 'blob' && object.data.length > limit) closure.delete(oid);
        }
      }
    } else if (filter === 'tree:0') {
      for (const oid of [...closure]) {
        const type = repo.objects.get(oid)?.type;
        if (type === 'tree' || type === 'blob') closure.delete(oid);
      }
    }
    // Unknown filters are ignored: sending the full set is the safe fallback.
  }

  // Shallow lines: allowed commits at the cut whose parents were excluded.
  const shallow: string[] = [];
  for (const oid of allowed) {
    const commit = getCommit(repo, oid);
    if (commit === null || commit.parents.length === 0) continue;
    const atDepthCut = depth !== undefined && dist.get(oid) === depth - 1;
    const atTimeCut =
      params.deepenSince !== undefined &&
      commit.parents.some((parent) => {
        const parentCommit = getCommit(repo, parent);
        return parentCommit === null || parentCommit.committerTime < (params.deepenSince as number);
      });
    if (atDepthCut || atTimeCut) shallow.push(oid);
  }
  shallow.sort();

  // Unshallow lines: old boundaries whose parent is now included and unsent-before.
  const unshallow: string[] = [];
  for (const boundary of boundaries) {
    if (!allowed.has(boundary)) continue;
    const commit = getCommit(repo, boundary);
    if (commit === null) continue;
    if (commit.parents.some((parent) => allowed.has(parent) && !excluded.has(parent))) {
      unshallow.push(boundary);
    }
  }
  unshallow.sort();

  // ACKs: haves reachable from the wants (full closure, ignoring depth).
  const ancestors = new Set<string>();
  const ancQueue = [...wantCommits];
  while (ancQueue.length > 0) {
    const current = ancQueue.pop() as string;
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    const commit = getCommit(repo, current);
    if (commit !== null) ancQueue.push(...commit.parents);
  }
  const acks: string[] = [];
  for (const have of params.haves) {
    const commit = peelToCommit(repo, have);
    if (commit !== null && ancestors.has(commit)) acks.push(have);
  }

  return { objects: [...closure].sort(), shallow, unshallow, acks };
}
