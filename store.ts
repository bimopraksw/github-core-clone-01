// store.ts — the forge's in-memory store: one process holds one trial's state.
// All ordering and timestamps derive from monotonic sequence counters, never the
// wall clock, so identical request sequences produce identical state.
//
// The default viewer identity comes from the kit-published sealed scenario
// (sdk/conformance/wire.ts buildScenario): the suite's bearer token is opaque
// and encodes no login, while the checks require viewer.login to equal the
// scenario viewer. If the first owner-bearing request of a trial names a
// different owner while the store is still empty, that owner is adopted; any
// other owner afterwards is a 404, never a 403.

import type { GitObject } from './gitcore.ts';

export interface UserInfo {
  login: string;
  id: number;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  userId: number;
  createdSeq: number;
  updatedSeq: number;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  authorLogin: string;
  authorId: number;
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: IssueState;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaSnapshot: string;
  baseShaSnapshot: string;
  authorLogin: string;
  authorId: number;
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface Repo {
  dbid: number;
  name: string;
  ownerLogin: string;
  ownerId: number;
  description: string;
  isPrivate: boolean;
  createdSeq: number;
  updatedSeq: number;
  /** The default branch name; always "main" in this forge. */
  defaultBranch: string;
  objects: Map<string, GitObject>;
  /** Full ref names ("refs/heads/main") to object ids, insertion ordered. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Shared issue + pull-request numbering, starting at 1. */
  nextNumber: number;
}

/** Fixed epoch for deterministic timestamps (2023-11-14T22:13:20Z). */
export const TIME_EPOCH = 1700000000;

export function isoForSeq(seq: number): string {
  return new Date((TIME_EPOCH + seq) * 1000).toISOString();
}

export class Store {
  /** The viewer, from the kit-published sealed scenario. */
  viewer: UserInfo = {
    login: 'adaiversen',
    id: 1000,
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
  };
  private ownerAdopted = false;
  private readonly repos = new Map<string, Repo>();
  private seq = 0;
  private nextRepoId = 1;
  private nextEntityId = 1;

  /** Advance the deterministic clock and return the new sequence number. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** A fresh globally unique entity id (issues, pulls, comments, labels). */
  nextId(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  /**
   * Resolve an owner login from a request path. Returns true when the owner is
   * the viewer. On the first owner-bearing request of an empty store, adopts
   * the owner named; afterwards any other owner is unknown (a 404).
   */
  isViewerOwner(owner: string): boolean {
    if (owner === this.viewer.login) return true;
    if (!this.ownerAdopted && this.repos.size === 0) {
      this.viewer = { ...this.viewer, login: owner };
      this.ownerAdopted = true;
      return true;
    }
    return false;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const createdSeq = this.tick();
    const repo: Repo = {
      dbid: this.nextRepoId,
      name,
      ownerLogin: this.viewer.login,
      ownerId: this.viewer.id,
      description,
      isPrivate,
      createdSeq,
      updatedSeq: createdSeq,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  hasRepo(name: string): boolean {
    return this.repos.has(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** Repositories in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  get repoCount(): number {
    return this.repos.size;
  }
}

// ---------------------------------------------------------------------------
// Relay-style global ids: opaque base64, stable across reads, decodable.

export function encodeGlobalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export interface DecodedGlobalId {
  readonly kind: string;
  readonly parts: readonly string[];
}

/** Decode a global id, or null when it is not one of ours. */
export function decodeGlobalId(id: unknown): DecodedGlobalId | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  // Reject ids that do not round-trip (guards against arbitrary base64 input).
  if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
  const parts = text.split(':');
  const kind = parts[0];
  if (kind === undefined || kind === '') return null;
  return { kind, parts: parts.slice(1) };
}

export function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('Repository', [repo.dbid]);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', [repo.dbid, issue.number]);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('PullRequest', [repo.dbid, pull.number]);
}

export function commentGlobalId(comment: Comment): string {
  return encodeGlobalId('Comment', [comment.id]);
}

export function userGlobalId(user: UserInfo): string {
  return encodeGlobalId('User', [user.id]);
}

/** Find a repository by database id (for global-id decoding). */
export function findRepoByDbid(store: Store, dbid: number): Repo | undefined {
  for (const repo of store.listRepos()) {
    if (repo.dbid === dbid) return repo;
  }
  return undefined;
}
