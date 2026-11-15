// githttp.ts — git smart HTTP: ref advertisements (protocol v0 and v2),
// ls-refs, fetch (v0 and v2), and receive-pack. All framing, pack handling,
// and object selection live in gitcore.ts / gitops.ts; this file is the wire
// mapping. Malformed bodies are 400s, never crashes.

import {
  buildPack,
  GitFormatError,
  isOid,
  PKT_DELIM,
  PKT_FLUSH,
  parsePack,
  parseTag,
  pktLine,
  PktReader,
  sidebandPackets,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';
import {
  branchFromRef,
  isAncestor,
  peelToCommit,
  selectFetchObjects,
  type FetchParams,
} from './gitops.ts';
import { repoFor, sendBytes, sendError, type Ctx } from './http.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const UPLOAD_V0_CAPS = `side-band-64k shallow thin-pack ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export function handleGit(ctx: Ctx, store: Store): void {
  // Segments: [<owner>, <repo>.git, ...rest]
  const owner = ctx.segments[0] as string;
  const dotGit = ctx.segments[1] as string;
  const repoName = dotGit.slice(0, -'.git'.length);
  const rest = ctx.segments.slice(2);
  const repo = repoFor(ctx, store, owner, repoName);
  if (repo === null) return;

  if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs' && ctx.method === 'GET') {
    handleInfoRefs(ctx, repo);
    return;
  }
  if (rest.length === 1 && rest[0] === 'git-upload-pack' && ctx.method === 'POST') {
    handleUploadPack(ctx, repo);
    return;
  }
  if (rest.length === 1 && rest[0] === 'git-receive-pack' && ctx.method === 'POST') {
    handleReceivePack(ctx, repo);
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// advertisements

function peeledCommit(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  try {
    const target = parseTag(object.data).object;
    const commit = peelToCommit(repo, target);
    return commit;
  } catch {
    return null;
  }
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = [...repo.refs.keys()].sort();
  const mainTip = repo.refs.get('refs/heads/main');
  const lines: string[] = [];
  if (mainTip !== undefined) lines.push(`${mainTip} HEAD`);
  for (const ref of refs) {
    const oid = repo.refs.get(ref) as string;
    lines.push(`${oid} ${ref}`);
    const peeled = peeledCommit(repo, oid);
    if (peeled !== null) lines.push(`${peeled} ${ref}^{}`);
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('object-format=sha1\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    PKT_FLUSH,
  ]);
}

function handleInfoRefs(ctx: Ctx, repo: Repo): void {
  const service = ctx.query.get('service');
  if (service === 'git-upload-pack') {
    const protocol = ctx.req.headers['git-protocol'];
    if (protocol === 'version=2') {
      sendBytes(ctx, 200, UPLOAD_ADVERTISEMENT, v2Advertisement());
    } else {
      sendBytes(ctx, 200, UPLOAD_ADVERTISEMENT, v0Advertisement('git-upload-pack', repo));
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendBytes(ctx, 200, RECEIVE_ADVERTISEMENT, v0Advertisement('git-receive-pack', repo));
    return;
  }
  sendError(ctx, 400, 'service parameter must name git-upload-pack or git-receive-pack');
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

function handleLsRefs(ctx: Ctx, repo: Repo, argLines: readonly string[]): void {
  let peelArg = false;
  let symrefsArg = false;
  let unbornArg = false;
  const prefixes: string[] = [];
  for (const raw of argLines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peelArg = true;
    else if (line === 'symrefs') symrefsArg = true;
    else if (line === 'unborn') unbornArg = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('ref-prefix\t')) prefixes.push(line.slice('ref-prefix\t'.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const out: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (matches('HEAD')) {
    if (mainTip !== undefined) {
      out.push(pktLine(`${mainTip} HEAD${symrefsArg ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (unbornArg) {
      out.push(pktLine(`unborn HEAD${symrefsArg ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  for (const ref of [...repo.refs.keys()].sort()) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref) as string;
    let line = `${oid} ${ref}`;
    if (peelArg) {
      const peeled = peeledCommit(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  sendBytes(ctx, 200, UPLOAD_RESULT, Buffer.concat(out));
}

// ---------------------------------------------------------------------------
// fetch (shared selection; v0 and v2 framings)

function buildFetchPack(repo: Repo, params: FetchParams): { pack: Buffer; shallow: string[]; unshallow: string[]; acks: string[] } {
  const selection = selectFetchObjects(repo, params);
  const objects: GitObject[] = [];
  for (const oid of selection.objects) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { pack: buildPack(objects), shallow: selection.shallow, unshallow: selection.unshallow, acks: selection.acks };
}

function handleFetchV2(ctx: Ctx, repo: Repo, argLines: readonly string[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | undefined;
  let deepenSince: number | undefined;
  let filter: string | undefined;
  let doneSeen = false;
  for (const raw of argLines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line === 'done') doneSeen = true;
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value >= 1) depth = Math.floor(value);
    } else if (line.startsWith('deepen-since ')) {
      const value = Number(line.slice(13).trim());
      if (Number.isFinite(value)) deepenSince = Math.floor(value);
    } else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('filter ')) filter = line.slice(7).trim();
    // thin-pack, no-progress, ofs-delta, done, and anything else: no action.
  }
  const { pack, shallow, unshallow, acks } = buildFetchPack(repo, {
    wants,
    haves,
    shallowBoundaries,
    depth,
    deepenSince,
    deepenNot,
    filter,
  });
  // Protocol v2 sections are separated by delim packets (0001); only the
  // last section ends with a flush (0000). A flush after the acknowledgment
  // section makes real git treat the response as over ("expected packfile
  // to be sent after 'ready'"). When the client already sent `done`, no
  // acknowledgment section is sent at all: the response starts with
  // shallow-info/packfile.
  const parts: Buffer[] = [];
  if (!doneSeen) {
    parts.push(pktLine('acknowledgments\n'));
    if (acks.length > 0) {
      for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

function handleFetchV0(ctx: Ctx, repo: Repo, body: Buffer): void {
  const reader = new PktReader(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | undefined;
  let deepenSince: number | undefined;
  let section = 0;
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).trim();
        const oid = rest.split(/\s+/)[0] as string;
        if (isOid(oid)) wants.push(oid);
      } else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const value = Number(line.slice(7).trim());
        if (Number.isFinite(value) && value >= 1) depth = Math.floor(value);
      } else if (line.startsWith('deepen-since ')) {
        const value = Number(line.slice(13).trim());
        if (Number.isFinite(value)) deepenSince = Math.floor(value);
      } else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      // "done" ends the negotiation; nothing more is needed.
    }
  }
  const { pack, shallow, unshallow, acks } = buildFetchPack(repo, {
    wants,
    haves,
    shallowBoundaries,
    depth,
    deepenSince,
    deepenNot,
  });
  const parts: Buffer[] = [];
  if (acks.length > 0) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

function handleUploadPack(ctx: Ctx, repo: Repo): void {
  try {
    const protocol = ctx.req.headers['git-protocol'];
    if (protocol === 'version=2') {
      const reader = new PktReader(ctx.body);
      const header = reader.readLinesUntilControl();
      if (header.terminator !== 'delim' && header.terminator !== 'flush') {
        sendError(ctx, 400, 'v2 request has no command section terminator');
        return;
      }
      const commandLine = header.lines.find((line) => line.startsWith('command='));
      if (commandLine === undefined) {
        sendError(ctx, 400, 'v2 request names no command');
        return;
      }
      const command = commandLine.slice('command='.length).replace(/\n$/, '');
      const args = reader.readLinesUntilControl();
      if (command === 'ls-refs') {
        handleLsRefs(ctx, repo, args.lines);
        return;
      }
      if (command === 'fetch') {
        handleFetchV2(ctx, repo, args.lines);
        return;
      }
      sendError(ctx, 400, `unknown v2 command ${command}`);
      return;
    }
    handleFetchV0(ctx, repo, ctx.body);
  } catch (err) {
    if (err instanceof GitFormatError) {
      sendError(ctx, 400, `malformed git request: ${err.message}`);
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function validRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length > 200 || ref.length <= 5) return false;
  if (/[\s\u0000-\u001f]/.test(ref)) return false;
  if (ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) return false;
  return true;
}

function handleReceivePack(ctx: Ctx, repo: Repo): void {
  let commands: PushCommand[];
  let capabilities = '';
  let packBytes: Buffer;
  try {
    const reader = new PktReader(ctx.body);
    const parsed: PushCommand[] = [];
    let first = true;
    for (;;) {
      const packet = reader.next();
      if (packet === null) {
        // The command list ended without a flush: treat the body as malformed.
        sendError(ctx, 400, 'receive-pack command list has no flush packet');
        return;
      }
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8');
      if (first) {
        first = false;
        const nul = line.indexOf('\0');
        if (nul !== -1) {
          capabilities = line.slice(nul + 1).replace(/\n$/, '');
          line = line.slice(0, nul);
        }
      }
      const text = line.replace(/\n$/, '');
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
      if (match === null) {
        sendError(ctx, 400, `malformed receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
        return;
      }
      parsed.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
    commands = parsed;
    packBytes = reader.remaining;
  } catch (err) {
    if (err instanceof GitFormatError) {
      sendError(ctx, 400, `malformed git request: ${err.message}`);
      return;
    }
    throw err;
  }

  if (commands.length === 0) {
    sendError(ctx, 400, 'receive-pack needs at least one command');
    return;
  }

  const sideband = capabilities.split(/\s+/).includes('side-band-64k');

  // Unpack first: every object lands in the store even when a ref is refused.
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) repo.objects.set(oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message.replace(/\n/g, ' ') : String(err);
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error`);
  } else {
    reportLines.push('unpack ok');
    for (const command of commands) {
      const result = applyCommand(repo, command);
      reportLines.push(result === null ? `ok ${command.ref}` : `ng ${command.ref} ${result}`);
    }
  }

  const parts: Buffer[] = [];
  if (sideband) {
    // Band 1 carries the report as its own pkt-line stream, terminated by a
    // flush packet inside the band: real git's report reader loops packet
    // reads until that flush, and "hung up unexpectedly" without it. The kit
    // client pkt-decodes the concatenated band-1 bytes the same way.
    const report = Buffer.concat([
      ...reportLines.map((line) => pktLine(`${line}\n`)),
      PKT_FLUSH,
    ]);
    for (let offset = 0; offset < report.length; offset += 32768) {
      const slice = report.subarray(offset, Math.min(report.length, offset + 32768));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  } else {
    for (const line of reportLines) parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, RECEIVE_RESULT, Buffer.concat(parts));
}

/** Apply one push command. Returns null on success, else the ng reason. */
function applyCommand(repo: Repo, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  if (!validRefName(ref)) return 'invalid ref name';
  const current = repo.refs.get(ref);
  const isBranch = branchFromRef(ref) !== null;

  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return 'remote ref does not exist';
    if (oldOid !== ZERO_OID && oldOid !== current) return 'non-fast-forward';
    repo.refs.delete(ref);
    return null;
  }

  const target = repo.objects.get(newOid);
  if (target === undefined) return 'missing object';
  if (isBranch && peelToCommit(repo, newOid) === null) return 'not a commit';

  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return 'already exists';
    repo.refs.set(ref, newOid);
    return null;
  }

  // Update.
  if (current === undefined) return 'remote ref does not exist';
  if (current !== oldOid) return 'non-fast-forward';
  if (newOid === oldOid) return null; // A no-op update is already up to date.
  const oldCommit = peelToCommit(repo, oldOid);
  const newCommit = peelToCommit(repo, newOid);
  if (oldCommit !== null && newCommit !== null && !isAncestor(repo, oldCommit, newCommit)) {
    return 'non-fast-forward';
  }
  repo.refs.set(ref, newOid);
  return null;
}
