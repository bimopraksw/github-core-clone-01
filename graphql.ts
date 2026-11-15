// graphql.ts — a small GraphQL executor for the query/mutation shapes gh and
// github-mcp-server send: a lexer, a recursive-descent parser, a field
// validator (unknown fields are 200 responses carrying errors), and resolvers
// over the shared store. Supports aliases, variables, input objects, inline
// and named fragments, @skip/@include, and batched operation arrays.

import {
  diffTrees,
  getCommit,
  mergeBase,
  peelToCommit,
  refForBranch,
} from './gitops.ts';
import { sendError, sendJson, type Ctx } from './http.ts';
import {
  addComment,
  createIssueInRepo,
  createPullInRepo,
  prHasConflict,
  squashMerge,
} from './rest.ts';
import {
  commentGlobalId,
  decodeGlobalId,
  findRepoByDbid,
  issueGlobalId,
  isoForSeq,
  pullGlobalId,
  repoGlobalId,
  userGlobalId,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// lexer

interface Token {
  readonly kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  readonly value: string;
}

class GraphQLSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLSyntaxError';
  }
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (pos < src.length) {
    const ch = src[pos] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      pos += 1;
      continue;
    }
    if (ch === '#') {
      while (pos < src.length && src[pos] !== '\n') pos += 1;
      continue;
    }
    if (ch === '.' && src.slice(pos, pos + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      pos += 3;
      continue;
    }
    if ('{}():$!@[]=|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      pos += 1;
      continue;
    }
    if (ch === '"') {
      if (src.slice(pos, pos + 3) === '"""') {
        const end = src.indexOf('"""', pos + 3);
        if (end === -1) throw new GraphQLSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: src.slice(pos + 3, end).replace(/\\"""/g, '"""') });
        pos = end + 3;
        continue;
      }
      let out = '';
      pos += 1;
      let closed = false;
      while (pos < src.length) {
        const c = src[pos] as string;
        pos += 1;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\n') throw new GraphQLSyntaxError('unterminated string');
        if (c === '\\') {
          const esc = src[pos] as string;
          pos += 1;
          switch (esc) {
            case '"': out += '"'; break;
            case '\\': out += '\\'; break;
            case '/': out += '/'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'u': {
              const hex = src.slice(pos, pos + 4);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError('bad unicode escape');
              out += String.fromCharCode(parseInt(hex, 16));
              pos += 4;
              break;
            }
            default: throw new GraphQLSyntaxError(`bad escape \\${esc}`);
          }
        } else {
          out += c;
        }
      }
      if (!closed) throw new GraphQLSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(src.slice(pos));
      if (match === null) throw new GraphQLSyntaxError(`bad number at ${pos}`);
      const text = match[0];
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      pos += text.length;
      continue;
    }
    if (isNameStart(ch)) {
      let end = pos + 1;
      while (end < src.length && isNameChar(src[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: src.slice(pos, end) });
      pos = end;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyMap<string, ValueNode> };

interface DirectiveNode {
  readonly name: string;
  readonly args: ReadonlyMap<string, ValueNode>;
}

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyMap<string, ValueNode>;
  readonly directives: readonly DirectiveNode[];
  readonly selections: readonly SelectionNode[] | null;
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly spreadName: string | null;
  readonly directives: readonly DirectiveNode[];
  readonly selections: readonly SelectionNode[] | null;
}

type SelectionNode = FieldNode | FragmentNode;

interface VarDef {
  readonly defaultValue: ValueNode | null;
}

interface OperationNode {
  readonly opType: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly varDefs: ReadonlyMap<string, VarDef>;
  readonly directives: readonly DirectiveNode[];
  readonly selections: readonly SelectionNode[];
}

interface FragmentDef {
  readonly name: string;
  readonly typeCondition: string;
  readonly directives: readonly DirectiveNode[];
  readonly selections: readonly SelectionNode[];
}

interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: ReadonlyMap<string, FragmentDef>;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.index] as Token;
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`expected ${value}, got ${token.value || token.kind}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLSyntaxError(`expected ${what}, got ${token.value || token.kind}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          opType: 'query',
          name: null,
          varDefs: new Map(),
          directives: [],
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        if (name === 'on') throw new GraphQLSyntaxError('fragment name may not be "on"');
        const on = this.expectName('the "on" keyword');
        if (on !== 'on') throw new GraphQLSyntaxError(`expected "on", got ${on}`);
        const typeCondition = this.expectName('a type condition');
        const directives = this.parseDirectives();
        fragments.set(name, { name, typeCondition, directives, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const opType = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        const directives = this.parseDirectives();
        operations.push({ opType, name, varDefs, directives, selections: this.parseSelectionSet() });
        continue;
      }
      throw new GraphQLSyntaxError(`unexpected token ${token.value || token.kind} at document level`);
    }
    return { operations, fragments };
  }

  private parseVarDefs(): Map<string, VarDef> {
    const defs = new Map<string, VarDef>();
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue(true);
      this.parseDirectives();
      defs.set(name, { defaultValue });
    }
    return defs;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    this.acceptPunct('!');
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName('a directive name');
      const args = this.parseArgs();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArgs(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.set(name, this.parseValue(false));
    }
    return args;
  }

  private parseValue(constValue: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$' && !constValue) {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue(constValue));
      }
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.set(name, this.parseValue(constValue));
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLSyntaxError(`unexpected value token ${token.value || token.kind}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition');
        const directives = this.parseDirectives();
        return { kind: 'fragment', typeCondition, spreadName: null, directives, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const spreadName = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'fragment', typeCondition: null, spreadName, directives, selections: null };
      }
      const directives = this.parseDirectives();
      return { kind: 'fragment', typeCondition: null, spreadName: null, directives, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.parseArgs();
    const directives = this.parseDirectives();
    const selections =
      this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selections };
  }
}

function parseDocument(src: string): DocumentNode {
  return new Parser(tokenize(src)).parseDocument();
}

// ---------------------------------------------------------------------------
// schema: field names and return types ("[T]" = a list of T). One source of
// truth for validation and for __type introspection.

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime']);

const SCHEMA: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: {
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    __type: '__Type',
    __schema: '__Schema',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Node: { id: 'ID' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
    description: 'String',
    url: 'URI',
    createdAt: 'DateTime',
    updatedAt: 'DateTime',
    isPrivate: 'Boolean',
    isFork: 'Boolean',
  },
  Issue: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    author: 'User',
    createdAt: 'DateTime',
    updatedAt: 'DateTime',
    closedAt: 'DateTime',
    url: 'URI',
    comments: 'IssueCommentConnection',
    labels: 'LabelConnection',
    repository: 'Repository',
  },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    merged: 'Boolean',
    mergeable: 'String',
    headRefName: 'String',
    baseRefName: 'String',
    headRef: 'Ref',
    baseRef: 'Ref',
    files: 'PullRequestChangedFileConnection',
    author: 'User',
    createdAt: 'DateTime',
    updatedAt: 'DateTime',
    closedAt: 'DateTime',
    mergedAt: 'DateTime',
    mergeCommit: 'Commit',
    url: 'URI',
    comments: 'IssueCommentConnection',
    labels: 'LabelConnection',
    repository: 'Repository',
  },
  User: {
    id: 'ID',
    login: 'String',
    name: 'String',
    email: 'String',
    url: 'URI',
  },
  Ref: { name: 'String', prefix: 'String', target: 'Commit' },
  Commit: { oid: 'String', message: 'String', abbreviatedOid: 'String' },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileConnection: {
    nodes: '[PullRequestChangedFile]',
    edges: '[PullRequestChangedFileEdge]',
    pageInfo: 'PageInfo',
    totalCount: 'Int',
  },
  IssueCommentConnection: { nodes: '[IssueComment]', edges: '[IssueCommentEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  LabelConnection: { nodes: '[Label]', edges: '[LabelEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile', cursor: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  LabelEdge: { node: 'Label', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'DateTime', updatedAt: 'DateTime', url: 'URI' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Node', clientMutationId: 'String' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', types: '[__Type]', directives: '[__Directive]' },
  __Directive: { name: 'String', description: 'String' },
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ', 'NONE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function baseType(returnType: string): string {
  return returnType.replace(/^\[/, '').replace(/\]$/, '').replace(/!$/, '');
}

// ---------------------------------------------------------------------------
// validation

function validateDocument(doc: DocumentNode): string[] {
  const errors: string[] = [];
  const validateSelections = (
    selections: readonly SelectionNode[],
    parentType: string,
    visitedFragments: ReadonlySet<string>,
  ): void => {
    const fields = SCHEMA[parentType];
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        if (selection.spreadName !== null) {
          const def = doc.fragments.get(selection.spreadName);
          if (def === undefined) {
            errors.push(`Unknown fragment "${selection.spreadName}".`);
            continue;
          }
          if (visitedFragments.has(selection.spreadName)) continue;
          const visited = new Set(visitedFragments);
          visited.add(selection.spreadName);
          validateSelections(def.selections, def.typeCondition, visited);
        } else {
          const condition = selection.typeCondition ?? parentType;
          if (SCHEMA[condition] === undefined && !ENUM_VALUES[condition]) {
            errors.push(`Unknown type "${condition}".`);
            continue;
          }
          if (selection.selections !== null) validateSelections(selection.selections, condition, visitedFragments);
        }
        continue;
      }
      const field = selection.name;
      if (field === '__typename') continue;
      if (fields === undefined || fields[field] === undefined) {
        errors.push(`Cannot query field "${field}" on type "${parentType}".`);
        continue;
      }
      if (selection.selections !== null) {
        const childType = baseType(fields[field] as string);
        if (!SCALARS.has(childType)) validateSelections(selection.selections, childType, visitedFragments);
      }
    }
  };
  for (const operation of doc.operations) {
    const root = operation.opType === 'mutation' ? 'Mutation' : 'Query';
    validateSelections(operation.selections, root, new Set());
  }
  for (const fragment of doc.fragments.values()) {
    if (SCHEMA[fragment.typeCondition] === undefined && !ENUM_VALUES[fragment.typeCondition]) {
      errors.push(`Unknown type "${fragment.typeCondition}".`);
      continue;
    }
    validateSelections(fragment.selections, fragment.typeCondition, new Set([fragment.name]));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// execution

class FieldError extends Error {}

interface Env {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
  readonly fragments: ReadonlyMap<string, FragmentDef>;
  readonly errors: Array<{ message: string; path: Array<string | number> }>;
}

type Wrapper = Record<string, unknown> & { __typename: string };

function valueOf(node: ValueNode, env: Env, operation: OperationNode): unknown {
  switch (node.kind) {
    case 'variable': {
      const provided = env.variables[node.name];
      if (provided !== undefined) return provided;
      const def = operation.varDefs.get(node.name);
      if (def !== undefined && def.defaultValue !== null) return valueOf(def.defaultValue, env, operation);
      return undefined;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, env, operation));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of node.fields) out[key] = valueOf(child, env, operation);
      return out;
    }
  }
}

function argsOf(field: FieldNode, env: Env, operation: OperationNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of field.args) {
    const value = valueOf(node, env, operation);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function directiveApplies(
  directives: readonly DirectiveNode[],
  env: Env,
  operation: OperationNode,
): boolean {
  for (const directive of directives) {
    const ifNode = directive.args.get('if');
    if (ifNode === undefined) continue;
    const flag = valueOf(ifNode, env, operation);
    if (directive.name === 'skip' && flag === true) return false;
    if (directive.name === 'include' && flag !== true) return false;
  }
  return true;
}

function encodeCursor(key: string): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): string | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    return text.startsWith('cursor:') ? text.slice('cursor:'.length) : null;
  } catch {
    return null;
  }
}

interface PageArgs {
  readonly first: number | null;
  readonly afterKey: string | null;
}

function pageArgsOf(args: Record<string, unknown>): PageArgs {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : null;
  return { first, afterKey: decodeCursor(args.after) };
}

/** Slice an ordered list into a connection wrapper. `keyOf` yields each item's cursor key. */
function paginateConnection<T extends Wrapper>(
  typeName: string,
  items: readonly T[],
  keyOf: (item: T) => string,
  args: Record<string, unknown>,
): Wrapper {
  const { first, afterKey } = pageArgsOf(args);
  let start = 0;
  if (afterKey !== null) {
    const index = items.findIndex((item) => keyOf(item) === afterKey);
    start = index === -1 ? 0 : index + 1;
  }
  const end = first === null ? items.length : Math.min(items.length, start + first);
  const nodes = items.slice(start, end);
  const hasNextPage = end < items.length;
  const pageInfo: Wrapper = {
    __typename: 'PageInfo',
    hasNextPage,
    hasPreviousPage: start > 0,
    startCursor: nodes.length > 0 ? encodeCursor(keyOf(nodes[0] as T)) : null,
    endCursor: nodes.length > 0 ? encodeCursor(keyOf(nodes[nodes.length - 1] as T)) : null,
  };
  const edgeType = `${typeName.replace(/Connection$/, '')}Edge`;
  return {
    __typename: typeName,
    nodes,
    edges: nodes.map((node) => ({ __typename: edgeType, node, cursor: encodeCursor(keyOf(node)) })),
    pageInfo,
    totalCount: items.length,
  };
}

// --- wrapper factories ---

function userWrapper(store: Store): Wrapper {
  return {
    __typename: 'User',
    id: userGlobalId(store.viewer),
    login: store.viewer.login,
    name: store.viewer.name,
    email: store.viewer.email,
    url: '',
  };
}

function repoWrapper(repo: Repo): Wrapper {
  return { __typename: 'Repository', repo };
}

function issueWrapper(repo: Repo, issue: Issue): Wrapper {
  return { __typename: 'Issue', repo, issue };
}

function pullWrapper(repo: Repo, pull: Pull): Wrapper {
  return { __typename: 'PullRequest', repo, pull };
}

function commentWrapper(store: Store, comment: Comment): Wrapper {
  return {
    __typename: 'IssueComment',
    id: commentGlobalId(comment),
    body: comment.body,
    author: userWrapper(store),
    createdAt: isoForSeq(comment.createdSeq),
    updatedAt: isoForSeq(comment.updatedSeq),
    url: '',
  };
}

function refWrapper(name: string, targetOid: string | null, repo: Repo | null): Wrapper {
  return { __typename: 'Ref', name, prefix: 'refs/heads/', targetOid, repo };
}

function commitWrapper(repo: Repo, oid: string): Wrapper {
  const commit = getCommit(repo, oid);
  return {
    __typename: 'Commit',
    oid,
    message: commit?.message ?? '',
    abbreviatedOid: oid.slice(0, 7),
  };
}

// --- resolvers ---

function resolveNodeId(store: Store, id: unknown): Wrapper | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = findRepoByDbid(store, Number(decoded.parts[0]));
    return repo === undefined ? null : repoWrapper(repo);
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const repo = findRepoByDbid(store, Number(decoded.parts[0]));
    if (repo === undefined) return null;
    const number = Number(decoded.parts[1]);
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueWrapper(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullWrapper(repo, pull);
  }
  return null;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function resolveField(
  parentType: string,
  parent: Wrapper,
  field: string,
  args: Record<string, unknown>,
  env: Env,
): unknown {
  const store = env.store;

  if (field === '__typename') return parentType;

  switch (parentType) {
    case 'Query': {
      if (field === 'viewer') return userWrapper(store);
      if (field === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (!store.isViewerOwner(owner)) return null;
        const repo = store.getRepo(name);
        return repo === undefined ? null : repoWrapper(repo);
      }
      if (field === 'node') return resolveNodeId(store, args.id);
      if (field === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        const fields = SCHEMA[name];
        const enums = ENUM_VALUES[name];
        if (fields === undefined && enums === undefined) return null;
        const isEnum = fields === undefined;
        return {
          __typename: '__Type',
          name,
          kind: isEnum ? 'ENUM' : 'OBJECT',
          description: null,
          fields: isEnum
            ? null
            : Object.keys(fields as Record<string, string>).map((fieldName) => ({
                __typename: '__Field',
                name: fieldName,
                description: null,
              })),
          enumValues: isEnum
            ? (enums as readonly string[]).map((value) => ({ __typename: '__EnumValue', name: value, description: null }))
            : null,
        };
      }
      if (field === '__schema') {
        return {
          __typename: '__Schema',
          queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT', description: null, fields: null, enumValues: null },
          mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT', description: null, fields: null, enumValues: null },
          subscriptionType: null,
          types: [],
          directives: [],
        };
      }
      break;
    }

    case 'Mutation': {
      if (field === 'createIssue') {
        const input = args.input as Record<string, unknown> | undefined;
        const decoded = decodeGlobalId(input?.repositoryId);
        const repo = decoded?.kind === 'Repository' ? findRepoByDbid(store, Number(decoded.parts[0])) : undefined;
        if (repo === undefined) throw new FieldError('repositoryId does not name a repository');
        const title = input?.title;
        if (typeof title !== 'string' || title === '') throw new FieldError('title is required');
        const body = typeof input?.body === 'string' ? (input.body as string) : '';
        const issue = createIssueInRepo(store, repo, title, body, []);
        return {
          __typename: 'CreateIssuePayload',
          issue: issueWrapper(repo, issue),
          clientMutationId: (input?.clientMutationId as string | undefined) ?? null,
        };
      }
      if (field === 'closeIssue') {
        const input = args.input as Record<string, unknown> | undefined;
        const decoded = decodeGlobalId(input?.issueId);
        const repo = decoded?.kind === 'Issue' ? findRepoByDbid(store, Number(decoded.parts[0])) : undefined;
        const issue = repo?.issues.get(Number(decoded?.parts[1]));
        if (repo === undefined || issue === undefined) throw new FieldError('issueId does not name an issue');
        issue.state = 'closed';
        issue.updatedSeq = store.tick();
        return {
          __typename: 'CloseIssuePayload',
          issue: issueWrapper(repo, issue),
          clientMutationId: (input?.clientMutationId as string | undefined) ?? null,
        };
      }
      if (field === 'createPullRequest') {
        const input = args.input as Record<string, unknown> | undefined;
        const decoded = decodeGlobalId(input?.repositoryId);
        const repo = decoded?.kind === 'Repository' ? findRepoByDbid(store, Number(decoded.parts[0])) : undefined;
        if (repo === undefined) throw new FieldError('repositoryId does not name a repository');
        const head = typeof input?.headRefName === 'string' ? (input.headRefName as string) : '';
        const base = typeof input?.baseRefName === 'string' ? (input.baseRefName as string) : '';
        const title = input?.title;
        if (typeof title !== 'string' || title === '') throw new FieldError('title is required');
        if (head === '' || base === '' || !repo.refs.has(refForBranch(head)) || !repo.refs.has(refForBranch(base))) {
          throw new FieldError('head or base branch does not exist');
        }
        const body = typeof input?.body === 'string' ? (input.body as string) : '';
        const pull = createPullInRepo(store, repo, title, body, head, base);
        return {
          __typename: 'CreatePullRequestPayload',
          pullRequest: pullWrapper(repo, pull),
          clientMutationId: (input?.clientMutationId as string | undefined) ?? null,
        };
      }
      if (field === 'mergePullRequest') {
        const input = args.input as Record<string, unknown> | undefined;
        const decoded = decodeGlobalId(input?.pullRequestId);
        const repo = decoded?.kind === 'PullRequest' ? findRepoByDbid(store, Number(decoded.parts[0])) : undefined;
        const pull = repo?.pulls.get(Number(decoded?.parts[1]));
        if (repo === undefined || pull === undefined) throw new FieldError('pullRequestId does not name a pull request');
        if (pull.state !== 'open') throw new FieldError('pull request is already merged or closed');
        const sha = squashMerge(store, repo, pull);
        if (sha === null) throw new FieldError('merge conflict: the pull request cannot be merged');
        return {
          __typename: 'MergePullRequestPayload',
          pullRequest: pullWrapper(repo, pull),
          clientMutationId: (input?.clientMutationId as string | undefined) ?? null,
        };
      }
      if (field === 'addComment') {
        const input = args.input as Record<string, unknown> | undefined;
        const decoded = decodeGlobalId(input?.subjectId);
        const body = input?.body;
        if (typeof body !== 'string' || body === '') throw new FieldError('body is required');
        let subject: Wrapper | null = null;
        let comment: Comment | null = null;
        if (decoded?.kind === 'Issue' || decoded?.kind === 'PullRequest') {
          const repo = findRepoByDbid(store, Number(decoded.parts[0]));
          const number = Number(decoded.parts[1]);
          const target = decoded.kind === 'Issue' ? repo?.issues.get(number) : repo?.pulls.get(number);
          if (repo !== undefined && target !== undefined) {
            comment = addComment(store, target, body);
            subject = decoded.kind === 'Issue' ? issueWrapper(repo, target as Issue) : pullWrapper(repo, target as Pull);
          }
        }
        if (subject === null || comment === null) throw new FieldError('subjectId does not name an issue or pull request');
        const node = commentWrapper(store, comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(String(comment.id)) },
          subject,
          clientMutationId: (input?.clientMutationId as string | undefined) ?? null,
        };
      }
      break;
    }

    case 'Repository': {
      const repo = parent.repo as Repo;
      switch (field) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.dbid;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.ownerLogin}/${repo.name}`;
        case 'owner': return userWrapper(store);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(refForBranch(repo.defaultBranch));
          return tip === undefined ? null : refWrapper(repo.defaultBranch, tip, repo);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'url': return `https://github.invalid/${repo.ownerLogin}/${repo.name}`;
        case 'createdAt': return isoForSeq(repo.createdSeq);
        case 'updatedAt': return isoForSeq(repo.updatedSeq);
        case 'isPrivate': return repo.isPrivate;
        case 'isFork': return false;
        case 'issue': {
          const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
          return issue === undefined ? null : issueWrapper(repo, issue);
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = args.states;
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = args.orderBy as Record<string, unknown> | undefined;
          if (orderBy !== undefined && typeof orderBy === 'object') {
            const direction = String(orderBy.direction ?? 'DESC');
            const ascending = direction === 'ASC';
            issues.sort((a, b) =>
              ascending ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number,
            );
          } else {
            issues.sort((a, b) => a.number - b.number);
          }
          return paginateConnection(
            'IssueConnection',
            issues.map((issue) => issueWrapper(repo, issue)),
            (wrapper) => String((wrapper.issue as Issue).number),
            args,
          );
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = args.states;
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((state) => String(state)));
            pulls = pulls.filter((pull) => wanted.has(pullState(pull)));
          } else {
            pulls = pulls.filter((pull) => pull.state === 'open');
          }
          pulls.sort((a, b) => a.number - b.number);
          return paginateConnection(
            'PullRequestConnection',
            pulls.map((pull) => pullWrapper(repo, pull)),
            (wrapper) => String((wrapper.pull as Pull).number),
            args,
          );
        }
        case 'pullRequest': {
          const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
          return pull === undefined ? null : pullWrapper(repo, pull);
        }
      }
      break;
    }

    case 'Issue': {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      switch (field) {
        case 'id': return issueGlobalId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueState(issue);
        case 'author': return userWrapper(store);
        case 'createdAt': return isoForSeq(issue.createdSeq);
        case 'updatedAt': return isoForSeq(issue.updatedSeq);
        case 'closedAt': return issue.state === 'closed' ? isoForSeq(issue.updatedSeq) : null;
        case 'url': return '';
        case 'repository': return repoWrapper(repo);
        case 'comments':
          return paginateConnection(
            'IssueCommentConnection',
            issue.comments.map((comment) => commentWrapper(store, comment)),
            (wrapper) => String(wrapper.id),
            args,
          );
        case 'labels':
          return paginateConnection(
            'LabelConnection',
            issue.labels.map((name) => {
              const label = repo.labels.get(name);
              return {
                __typename: 'Label',
                id: label !== undefined ? `label:${label.id}` : `label:${name}`,
                name,
                color: label?.color ?? 'ededed',
                description: label?.description ?? '',
              };
            }),
            (wrapper) => String(wrapper.name),
            args,
          );
      }
      break;
    }

    case 'PullRequest': {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      switch (field) {
        case 'id': return pullGlobalId(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          const headTip = repo.refs.get(refForBranch(pull.headRef));
          const baseTip = repo.refs.get(refForBranch(pull.baseRef));
          if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
          return prHasConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': {
          const tip = repo.refs.get(refForBranch(pull.headRef));
          return tip === undefined ? null : refWrapper(pull.headRef, tip, repo);
        }
        case 'baseRef': {
          const tip = repo.refs.get(refForBranch(pull.baseRef));
          return tip === undefined ? null : refWrapper(pull.baseRef, tip, repo);
        }
        case 'files': {
          const headTip = repo.refs.get(refForBranch(pull.headRef));
          const baseTip = repo.refs.get(refForBranch(pull.baseRef));
          const headId = headTip === undefined ? null : peelToCommit(repo, headTip);
          const baseId = baseTip === undefined ? null : peelToCommit(repo, baseTip);
          if (headId === null || baseId === null) {
            return paginateConnection('PullRequestChangedFileConnection', [], () => '', args);
          }
          const headCommit = getCommit(repo, headId);
          const base = mergeBase(repo, headId, baseId);
          const baseTree = base === null ? null : (getCommit(repo, base)?.tree ?? null);
          const files = headCommit === null ? [] : diffTrees(repo, baseTree, headCommit.tree);
          const nodes = files.map((file) => ({
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          return paginateConnection('PullRequestChangedFileConnection', nodes, (node) => String(node.path), args);
        }
        case 'author': return userWrapper(store);
        case 'createdAt': return isoForSeq(pull.createdSeq);
        case 'updatedAt': return isoForSeq(pull.updatedSeq);
        case 'closedAt': return pull.state === 'closed' ? isoForSeq(pull.updatedSeq) : null;
        case 'mergedAt': return pull.mergedAt;
        case 'mergeCommit': {
          return pull.mergeCommitSha === null ? null : commitWrapper(repo, pull.mergeCommitSha);
        }
        case 'url': return '';
        case 'repository': return repoWrapper(repo);
        case 'comments':
          return paginateConnection(
            'IssueCommentConnection',
            pull.comments.map((comment) => commentWrapper(store, comment)),
            (wrapper) => String(wrapper.id),
            args,
          );
        case 'labels':
          return paginateConnection('LabelConnection', [], () => '', args);
      }
      break;
    }

    case 'Ref': {
      if (field === 'name') return parent.name;
      if (field === 'prefix') return parent.prefix;
      if (field === 'target') {
        const repo = parent.repo as Repo | null;
        const oid = parent.targetOid as string | null;
        if (repo === null || oid === null) return null;
        const commitId = peelToCommit(repo, oid);
        return commitId === null ? null : commitWrapper(repo, commitId);
      }
      break;
    }

    case 'User': {
      if (field === 'id') return parent.id;
      if (field === 'login') return parent.login;
      if (field === 'name') return parent.name;
      if (field === 'email') return parent.email;
      if (field === 'url') return parent.url;
      break;
    }

    default: {
      // Pure-data wrappers (connections, page info, edges, payloads, __Type
      // family, Commit): fields are the wrapper's own properties.
      if (field in parent && field !== '__typename') return parent[field];
      if (field === 'id' && parentType === 'Node') return parent.id;
      break;
    }
  }

  // Fallback for data wrappers whose type has an explicit case above but
  // carries extra plain fields.
  if (field in parent && field !== '__typename' && field !== 'repo' && field !== 'issue' && field !== 'pull') {
    return parent[field];
  }
  throw new FieldError(`no resolver for field "${field}" on type "${parentType}"`);
}

function completeValue(
  value: unknown,
  returnType: string,
  selections: readonly SelectionNode[] | null,
  env: Env,
  operation: OperationNode,
  path: Array<string | number>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(item, returnType, selections, env, operation, [...path, index]));
  }
  if (selections === null || selections.length === 0) return value;
  if (typeof value !== 'object') return value;
  const wrapper = value as Wrapper;
  const typeName = wrapper.__typename ?? baseType(returnType);
  return executeSelections(selections, typeName, wrapper, env, operation, path);
}

function executeSelections(
  selections: readonly SelectionNode[],
  parentType: string,
  parent: Wrapper,
  env: Env,
  operation: OperationNode,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (!directiveApplies(selection.directives, env, operation)) continue;
    if (selection.kind === 'fragment') {
      let fragmentSelections: readonly SelectionNode[] | null = selection.selections;
      let condition = selection.typeCondition;
      if (selection.spreadName !== null) {
        const def = env.fragments.get(selection.spreadName);
        if (def === undefined) continue;
        fragmentSelections = def.selections;
        condition = def.typeCondition;
      }
      if (condition !== null && condition !== parentType && condition !== 'Node') continue;
      if (fragmentSelections === null) continue;
      const nested = executeSelections(fragmentSelections, condition ?? parentType, parent, env, operation, path);
      Object.assign(out, nested);
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    let value: unknown;
    try {
      const args = argsOf(selection, env, operation);
      value = resolveField(parentType, parent, selection.name, args, env);
    } catch (err) {
      env.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    const returnType = SCHEMA[parentType]?.[selection.name] ?? 'String';
    out[responseKey] = completeValue(value, returnType, selection.selections, env, operation, fieldPath);
  }
  return out;
}

function executeOperation(
  doc: DocumentNode,
  operation: OperationNode,
  variables: Record<string, unknown>,
  store: Store,
): { data: Record<string, unknown> | null; errors: Array<{ message: string; path?: Array<string | number> }> } {
  const env: Env = { store, variables, fragments: doc.fragments, errors: [] };
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  const root: Wrapper = { __typename: rootType };
  const data = executeSelections(operation.selections, rootType, root, env, operation, []);
  if (env.errors.length > 0) {
    return { data, errors: env.errors };
  }
  return { data, errors: [] };
}

// ---------------------------------------------------------------------------
// HTTP entry point

interface GraphQLRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function runOne(body: unknown, store: Store): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object' }] };
  }
  const request = body as GraphQLRequestBody;
  if (typeof request.query !== 'string' || request.query.trim() === '') {
    return { data: null, errors: [{ message: 'No query provided' }] };
  }
  let variables: Record<string, unknown> = {};
  if (request.variables !== undefined && request.variables !== null) {
    if (typeof request.variables === 'string') {
      try {
        const parsed = JSON.parse(request.variables) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          variables = parsed as Record<string, unknown>;
        }
      } catch {
        return { data: null, errors: [{ message: 'variables must be a JSON object' }] };
      }
    } else if (typeof request.variables === 'object' && !Array.isArray(request.variables)) {
      variables = request.variables as Record<string, unknown>;
    } else {
      return { data: null, errors: [{ message: 'variables must be a JSON object' }] };
    }
  }
  let doc: DocumentNode;
  try {
    doc = parseDocument(request.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const validationErrors = validateDocument(doc);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  let operation: OperationNode | undefined;
  if (typeof request.operationName === 'string' && request.operationName !== '') {
    operation = doc.operations.find((candidate) => candidate.name === request.operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${request.operationName}"` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'Document contains no operations' }] };
  } else {
    return { data: null, errors: [{ message: 'Document contains multiple operations; operationName is required' }] };
  }
  const result = executeOperation(doc, operation as OperationNode, variables, store);
  if (result.errors.length > 0) {
    return { data: result.data, errors: result.errors };
  }
  return { data: result.data };
}

export function handleGraphql(ctx: Ctx, store: Store): void {
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const text = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : (JSON.parse(text) as unknown);
  } catch {
    sendJson(ctx, 400, { errors: [{ message: 'Malformed JSON body' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(ctx, 200, parsed.map((entry) => runOne(entry, store)));
    return;
  }
  sendJson(ctx, 200, runOne(parsed, store));
}
