// gitcore.ts — the git object model: object ids, commit/tree/tag codecs, packfile
// parsing (including OFS/REF deltas) and building, and pkt-line framing. No git
// binary, no dependencies: node:crypto and node:zlib only.
//
// This file is original code written for the make.fun github-core-clone-01
// bounty. It implements the formats as the git documentation describes them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

const TYPE_CODES: Readonly<Record<ObjType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

const CODE_TYPES: Readonly<Record<number, ObjType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

/** The SHA-1 object id of an object: sha1("<type> <size>\\0" + data). */
export function oidOf(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export class GitFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitFormatError';
  }
}

// ---------------------------------------------------------------------------
// commits

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  /** Committer timestamp, seconds since the epoch (0 when unparsable). */
  readonly committerTime: number;
  /** The message: everything after the header blank line, one trailing LF removed. */
  readonly message: string;
}

function parseIdentLine(line: string): { text: string; time: number } {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return { text: line, time: match === null ? 0 : Number(match[1]) };
}

/** Parse a commit object's headers. Unknown headers (gpgsig continuations included) are skipped. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerPart = blank === -1 ? text : text.slice(0, blank);
  let message = blank === -1 ? '' : text.slice(blank + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let committerTime = 0;
  for (const line of headerPart.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of a multi-line header
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdentLine(line.slice(7)).text;
    else if (line.startsWith('committer ')) {
      const parsed = parseIdentLine(line.slice(10));
      committer = parsed.text;
      committerTime = parsed.time;
    }
  }
  if (!isOid(tree)) throw new GitFormatError('commit has no valid tree line');
  return { tree, parents, author, committer, committerTime, message };
}

/** Build a commit object. The message is stored with exactly one trailing LF. */
export function buildCommit(
  tree: string,
  parents: readonly string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8');
}

/** Format an ident line: "Name <email> timestamp +0000". */
export function ident(name: string, email: string, timestamp: number): string {
  return `${name} <${email}> ${Math.floor(timestamp)} +0000`;
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object: "<mode> <name>\\0<20 raw bytes>" entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new GitFormatError('tree entry has no mode/name separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) throw new GitFormatError('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/**
 * Build a tree object. Entries sort by name bytes, directories compared as if
 * their name had a trailing slash — git's tree order.
 */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = Buffer.from(a.name + (isDirMode(a.mode) ? '/' : ''), 'utf8');
    const bKey = Buffer.from(b.name + (isDirMode(b.mode) ? '/' : ''), 'utf8');
    return Buffer.compare(aKey, bKey);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isOid(entry.oid)) throw new GitFormatError(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// tags

export interface TagInfo {
  readonly object: string;
  readonly type: ObjType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerPart = blank === -1 ? text : text.slice(0, blank);
  let message = blank === -1 ? '' : text.slice(blank + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerPart.split('\n')) {
    if (line.startsWith(' ')) continue;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) {
      const raw = line.slice(5).trim();
      if (raw === 'commit' || raw === 'tree' || raw === 'blob' || raw === 'tag') type = raw;
    } else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  if (!isOid(object)) throw new GitFormatError('tag has no valid object line');
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// deltas

function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= data.length) throw new GitFormatError('delta varint runs past the end');
    const byte = data[pos] as number;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/** Apply a git delta to a base object, verifying both sizes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readVarint(delta, 0);
  if (source.value !== base.length) {
    throw new GitFormatError(`delta source size ${source.value} does not match the base (${base.length})`);
  }
  const target = readVarint(delta, source.next);
  const chunks: Buffer[] = [];
  let total = 0;
  let pos = target.next;
  while (pos < delta.length) {
    const opcode = delta[pos] as number;
    pos += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          if (pos >= delta.length) throw new GitFormatError('delta copy runs past the end');
          copyOffset |= (delta[pos] as number) << (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) {
          if (pos >= delta.length) throw new GitFormatError('delta copy runs past the end');
          copySize |= (delta[pos] as number) << (8 * bit);
          pos += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new GitFormatError('delta copy reads past the base');
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (opcode !== 0) {
      if (pos + opcode > delta.length) throw new GitFormatError('delta insert runs past the end');
      chunks.push(delta.subarray(pos, pos + opcode));
      total += opcode;
      pos += opcode;
    } else {
      throw new GitFormatError('delta opcode 0 is reserved');
    }
  }
  if (total !== target.value) {
    throw new GitFormatError(`delta target size ${target.value} does not match the result (${total})`);
  }
  return Buffer.concat(chunks, total);
}

// ---------------------------------------------------------------------------
// packfiles

/**
 * Inflate one zlib stream starting at `offset` and report how many input bytes
 * it consumed. inflateSync ignores trailing bytes, so the end is found by
 * binary search: a truncated stream throws, a complete one succeeds.
 */
function inflateOne(data: Buffer, offset: number): { output: Buffer; consumed: number } {
  let lo = offset; // known too short (or offset itself when the stream is empty)
  let hi = data.length; // must succeed: the whole remainder holds the stream
  let probe: Buffer;
  try {
    probe = inflateSync(data.subarray(offset, hi));
  } catch {
    throw new GitFormatError('pack object has corrupt zlib data');
  }
  // Binary-search the smallest end that inflates.
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(data.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { output: probe, consumed: hi - offset };
}

interface RawPackEntry {
  readonly offset: number;
  readonly kind: 'full' | 'ofs' | 'ref';
  readonly type: ObjType | null;
  readonly size: number;
  readonly baseOffset: number;
  readonly baseOid: string;
  readonly deltaData: Buffer;
  readonly data: Buffer;
}

/**
 * Parse a packfile, resolving deltas against objects already in the pack and
 * (for REF deltas) objects the `lookup` finds in the store. Returns every
 * object keyed by its recomputed id. The trailer checksum is verified.
 */
export function parsePack(
  buf: Buffer,
  lookup: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new GitFormatError('pack does not start with PACK');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new GitFormatError(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // Verify the trailer checksum over everything before the last 20 bytes.
  if (buf.length < 32) throw new GitFormatError('pack is too short for a trailer');
  const body = buf.subarray(0, buf.length - 20);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (createHash('sha1').update(body).digest('hex') !== trailer) {
    throw new GitFormatError('pack trailer checksum mismatch');
  }

  const raw: RawPackEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    if (offset >= body.length) throw new GitFormatError('pack ends before its object count');
    let byte = body[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= body.length) throw new GitFormatError('pack object header is truncated');
      byte = body[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let kind: 'full' | 'ofs' | 'ref' = 'full';
    let baseOffset = 0;
    let baseOid = '';
    if (typeCode === 6) {
      kind = 'ofs';
      if (offset >= body.length) throw new GitFormatError('OFS delta has no offset');
      byte = body[offset] as number;
      offset += 1;
      let decoded = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= body.length) throw new GitFormatError('OFS delta offset is truncated');
        byte = body[offset] as number;
        offset += 1;
        decoded = ((decoded + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - decoded;
      if (baseOffset < 12) throw new GitFormatError('OFS delta points before the pack body');
    } else if (typeCode === 7) {
      kind = 'ref';
      if (offset + 20 > body.length) throw new GitFormatError('REF delta has no base id');
      baseOid = body.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPES[typeCode] === undefined) {
      throw new GitFormatError(`pack object has unknown type code ${typeCode}`);
    }
    const inflated = inflateOne(body, offset);
    offset += inflated.consumed;
    if (inflated.output.length !== size) {
      throw new GitFormatError(`pack object size ${size} does not match the inflated ${inflated.output.length}`);
    }
    raw.push({
      offset: start,
      kind,
      type: kind === 'full' ? (CODE_TYPES[typeCode] as ObjType) : null,
      size,
      baseOffset,
      baseOid,
      deltaData: kind === 'full' ? Buffer.alloc(0) : inflated.output,
      data: kind === 'full' ? inflated.output : Buffer.alloc(0),
    });
  }

  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const storeResolved = (entry: RawPackEntry, object: GitObject): void => {
    byOffset.set(entry.offset, object);
    byOid.set(oidOf(object.type, object.data), object);
  };
  // Resolve in passes: a delta's base may be a delta result, or (REF) a later
  // entry in the pack. Each pass resolves at least one entry or fails.
  const pending = new Set<number>(raw.map((entry, index) => index));
  while (pending.size > 0) {
    let progressed = false;
    for (const index of [...pending]) {
      const entry = raw[index] as RawPackEntry;
      if (entry.kind === 'full') {
        storeResolved(entry, { type: entry.type as ObjType, data: entry.data });
        pending.delete(index);
        progressed = true;
        continue;
      }
      let base: GitObject | undefined;
      if (entry.kind === 'ofs') base = byOffset.get(entry.baseOffset);
      else {
        base = byOid.get(entry.baseOid) ?? lookup(entry.baseOid);
      }
      if (base === undefined) continue;
      const data = applyDelta(base.data, entry.deltaData);
      storeResolved(entry, { type: base.type, data });
      pending.delete(index);
      progressed = true;
    }
    if (!progressed) throw new GitFormatError('pack delta base is missing');
  }
  return byOid;
}

/** Build a packfile holding the given objects with no deltas, in a fixed order. */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const aOid = oidOf(a.type, a.data);
    const bOid = oidOf(b.type, b.data);
    return aOid < bOid ? -1 : aOid > bOid ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const object of sorted) {
    const typeCode = TYPE_CODES[object.type];
    const size = object.data.length;
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// pkt-line framing

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Frame one payload as a pkt-line (4 lowercase hex length digits + payload). */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new GitFormatError('pkt-line payload exceeds the 65520-byte limit');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

/**
 * A cursor over a pkt-line framed buffer. `next()` returns the next packet or
 * null at the end of the buffer. Malformed framing throws GitFormatError.
 */
export class PktReader {
  private offset = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** Bytes not yet consumed. */
  get remaining(): Buffer {
    return this.buf.subarray(this.offset);
  }

  get position(): number {
    return this.offset;
  }

  get atEnd(): boolean {
    return this.offset >= this.buf.length;
  }

  next(): PktPacket | null {
    if (this.offset >= this.buf.length) return null;
    if (this.offset + 4 > this.buf.length) {
      throw new GitFormatError('pkt-line length prefix is truncated');
    }
    const prefix = this.buf.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(prefix)) {
      throw new GitFormatError(`bad pkt-line length prefix ${JSON.stringify(prefix)}`);
    }
    const length = parseInt(prefix, 16);
    this.offset += 4;
    if (length === 0) return { kind: 'flush', payload: Buffer.alloc(0) };
    if (length === 1) return { kind: 'delim', payload: Buffer.alloc(0) };
    if (length === 2) return { kind: 'response-end', payload: Buffer.alloc(0) };
    if (length < 4) throw new GitFormatError(`pkt-line length ${length} is below the minimum`);
    const end = this.offset + length - 4;
    if (end > this.buf.length) throw new GitFormatError('pkt-line payload is truncated');
    const payload = this.buf.subarray(this.offset, end);
    this.offset = end;
    return { kind: 'data', payload };
  }

  /** Read data packets until a flush/delim/end; returns the payloads as text lines. */
  readLinesUntilControl(): { lines: string[]; terminator: PktKind | null } {
    const lines: string[] = [];
    for (;;) {
      const packet = this.next();
      if (packet === null) return { lines, terminator: null };
      if (packet.kind !== 'data') return { lines, terminator: packet.kind };
      lines.push(packet.payload.toString('utf8'));
    }
  }
}

/** Split a sideband payload buffer into band-1 packets of at most `chunk` data bytes. */
export function sidebandPackets(data: Buffer, chunk = 32768): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunk) {
    const slice = data.subarray(offset, Math.min(data.length, offset + chunk));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return packets;
}
