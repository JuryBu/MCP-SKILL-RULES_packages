import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { RequestInspectionError } from "./request-body-inspector.mjs";

const WINDOW = 32 * 1024;
const PREFIX_UNITS = 64;
const RUN_ITEMS = 256;

function abort(signal) {
  if (signal?.aborted) throw new RequestInspectionError("inspection_aborted", { cause: signal.reason });
}

function invalid() { throw new RequestInspectionError("invalid_json"); }

function normalizedEncoding(header) {
  const raw = header == null || header === "" ? "identity" : Array.isArray(header) ? header.join(",") : header;
  if (typeof raw !== "string" || raw.length > 256) throw new RequestInspectionError("unsupported_content_encoding");
  const result = raw.split(",").map(value => value.trim().toLowerCase());
  if (result.length > 16 || result.some(value => !["identity", "gzip", "deflate", "br", "zstd"].includes(value))) {
    throw new RequestInspectionError("unsupported_content_encoding");
  }
  return result;
}

function fileSource(filename) {
  const descriptor = fs.openSync(filename, "r");
  const bytes = fs.fstatSync(descriptor).size;
  return { bytes,
    open: ({ signal } = {}) => fs.createReadStream(filename, { highWaterMark: WINDOW, signal }),
    readRangeSync(start, end) {
      if (end < start || start < 0 || end > bytes || end - start > WINDOW) throw new RangeError("Unbounded JSON source read");
      const buffer = Buffer.allocUnsafe(end - start);
      let offset = 0;
      while (offset < buffer.length) {
        const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, start + offset);
        if (!count) throw new Error("JSON_SOURCE_TRUNCATED");
        offset += count;
      }
      return buffer;
    },
    release: () => fs.closeSync(descriptor) };
}

function pagedSource(source) {
  const pages = new Map();
  return {
    get bytes() { return source.bytes; },
    get sha256() { return source.sha256; },
    open: options => source.open(options),
    clearCache: () => pages.clear(),
    release() { pages.clear(); return source.release?.(); },
    readRangeSync(start, end) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.bytes || end - start > WINDOW) throw new RangeError("Unbounded JSON source read");
      source.readRangeSync(start, start);
      const output = Buffer.allocUnsafe(end - start);
      let position = start;
      while (position < end) {
        const pageStart = Math.floor(position / WINDOW) * WINDOW;
        let page = pages.get(pageStart);
        if (page) pages.delete(pageStart);
        else {
          if (pages.size === 4) pages.delete(pages.keys().next().value);
          page = Buffer.from(source.readRangeSync(pageStart, Math.min(source.bytes, pageStart + WINDOW)));
        }
        pages.set(pageStart, page);
        const count = Math.min(end - position, page.length - (position - pageStart));
        page.copy(output, position - start, position - pageStart, position - pageStart + count);
        position += count;
      }
      return output;
    }
  };
}

async function* rangeChunks(source, start, end, signal) {
  for (let offset = start; offset < end; offset += WINDOW) {
    abort(signal);
    yield source.readRangeSync(offset, Math.min(end, offset + WINDOW));
    await yieldTurn();
  }
}

class FrameValidator extends Transform {
  constructor(onFrame) {
    super();
    this.onFrame = onFrame;
    this.position = 0;
    this.start = 0;
    this.phase = "magic";
    this.need = 4;
    this.header = [];
    this.seen = false;
  }
  finishFrame(skip) {
    this.seen = true;
    this.onFrame(this.start, this.position, skip);
    this.start = this.position;
    this.phase = "magic";
    this.need = 4;
  }
  next() {
    const bytes = Buffer.from(this.header);
    this.header.length = 0;
    if (this.phase === "magic") {
      const magic = bytes.readUInt32LE();
      if ((magic & 0xfffffff0) === 0x184d2a50) { this.phase = "skipLength"; this.need = 4; }
      else if (magic === 0xfd2fb528) { this.phase = "descriptor"; this.need = 1; }
      else throw new Error("ZSTD_INVALID_FRAME");
    } else if (this.phase === "skipLength") {
      this.phase = "skipPayload";
      this.need = bytes.readUInt32LE();
      if (!this.need) this.finishFrame(true);
    } else if (this.phase === "descriptor") {
      const descriptor = bytes[0];
      const single = (descriptor & 0x20) !== 0;
      const sizeFlag = descriptor >>> 6;
      this.checksum = (descriptor & 4) !== 0;
      this.phase = "frameHeader";
      this.need = (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (sizeFlag === 0 && single ? 1 : [0, 2, 4, 8][sizeFlag]);
      if (!this.need) { this.phase = "blockHeader"; this.need = 3; }
    } else if (this.phase === "frameHeader") {
      this.phase = "blockHeader"; this.need = 3;
    } else if (this.phase === "blockHeader") {
      const header = bytes[0] | bytes[1] << 8 | bytes[2] << 16;
      const type = header >>> 1 & 3;
      if (type === 3) throw new Error("ZSTD_INVALID_FRAME");
      this.last = (header & 1) !== 0;
      this.phase = "blockPayload";
      this.need = type === 1 ? 1 : header >>> 3;
      if (!this.need) this.endBlock();
    } else if (this.phase === "checksum") this.finishFrame(false);
  }
  endBlock() {
    if (!this.last) { this.phase = "blockHeader"; this.need = 3; }
    else if (this.checksum) { this.phase = "checksum"; this.need = 4; }
    else this.finishFrame(false);
  }
  _transform(chunk, encoding, callback) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const count = Math.min(this.need, chunk.length - offset);
        if (!["skipPayload", "blockPayload"].includes(this.phase)) {
          for (let index = 0; index < count; index++) this.header.push(chunk[offset + index]);
        }
        offset += count; this.position += count; this.need -= count;
        if (this.need) continue;
        if (this.phase === "skipPayload") this.finishFrame(true);
        else if (this.phase === "blockPayload") this.endBlock();
        else this.next();
      }
      callback(null, chunk);
    } catch (error) { callback(error); }
  }
  _flush(callback) {
    callback(this.seen && this.phase === "magic" && !this.header.length ? null : new Error("ZSTD_INVALID_FRAME"));
  }
}

async function decodeSource(source, encodings, directory, database, signal) {
  let current = source;
  let currentOwned = false;
  let layer = 0;
  try {
    for (const encoding of [...encodings].reverse()) {
      abort(signal);
      if (encoding === "identity") continue;
      const filename = path.join(directory, `decoded-${layer++}.json`);
      if (encoding === "zstd") {
        database.exec("CREATE TABLE IF NOT EXISTS frames(start INTEGER, end INTEGER, skip INTEGER); DELETE FROM frames");
        const insert = database.prepare("INSERT INTO frames VALUES(?,?,?)");
        await pipeline(current.open({ signal }), new FrameValidator((start, end, skip) => insert.run(start, end, Number(skip))),
          new Transform({ transform(chunk, format, callback) { callback(); } }), { signal });
        fs.writeFileSync(filename, "", { mode: 0o600, flag: "wx" });
        for (const frame of database.prepare("SELECT * FROM frames ORDER BY start").iterate()) {
          abort(signal);
          if (frame.skip) continue;
          await pipeline(Readable.from(rangeChunks(current, frame.start, frame.end, signal)), zlib.createZstdDecompress(),
            fs.createWriteStream(filename, { flags: "a", highWaterMark: WINDOW }), { signal });
        }
      } else {
        const factory = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[encoding];
        await pipeline(current.open({ signal }), factory({ chunkSize: WINDOW }),
          fs.createWriteStream(filename, { flags: "wx", mode: 0o600, highWaterMark: WINDOW }), { signal });
      }
      if (currentOwned) {
        const oldFilename = current.filename;
        current.release();
        fs.unlinkSync(oldFilename);
      }
      current = Object.assign(fileSource(filename), { filename });
      currentOwned = true;
    }
    return { source: current, owned: currentOwned };
  } catch (cause) {
    if (currentOwned) current.release();
    abort(signal);
    throw new RequestInspectionError("invalid_compression", { cause });
  }
}

function* decodedStringChunks(source, node) {
  if (node.end - node.start <= 512) {
    const text = JSON.parse(source.readRangeSync(node.start, node.end).toString("utf8"));
    if (text) yield text;
    return;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let escape = false;
  let unicode = "";
  let output = "";
  let pendingHigh = "";
  function escaped(character) {
    if (unicode) {
      unicode += character;
      if (unicode.length === 5) { output += String.fromCharCode(Number.parseInt(unicode.slice(1), 16)); unicode = ""; escape = false; }
    } else if (escape && character === "u") unicode = "u";
    else if (escape) {
      output += ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[character];
      escape = false;
    } else if (character === "\\") escape = true;
    else output += character;
  }
  for (let offset = node.start + 1; offset < node.end - 1; offset += WINDOW) {
    const text = decoder.decode(source.readRangeSync(offset, Math.min(node.end - 1, offset + WINDOW)), { stream: true });
    for (let index = 0; index < text.length; index++) escaped(text[index]);
    if (output.length) {
      output = pendingHigh + output; pendingHigh = "";
      const last = output.charCodeAt(output.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) { pendingHigh = output.slice(-1); output = output.slice(0, -1); }
      if (output) yield output;
      output = "";
    }
  }
  const last = decoder.decode();
  for (let index = 0; index < last.length; index++) escaped(last[index]);
  if (pendingHigh || output) yield pendingHigh + output;
}

function prefixBytes(text) {
  const bytes = Buffer.allocUnsafe(text.length * 2);
  for (let index = 0; index < text.length; index++) bytes.writeUInt16BE(text.charCodeAt(index), index * 2);
  return bytes;
}

function keyInfo(source, node) {
  let prefix = "";
  let complete = true;
  for (const chunk of decodedStringChunks(source, node)) {
    const remaining = PREFIX_UNITS - prefix.length;
    prefix += chunk.slice(0, remaining);
    if (chunk.length > remaining) { complete = false; break; }
    if (prefix.length === PREFIX_UNITS && node.end - node.start > PREFIX_UNITS + 2) { complete = false; break; }
  }
  const integer = complete && /^(0|[1-9][0-9]{0,9})$/u.test(prefix) && Number(prefix) < 4294967295 ? Number(prefix) : null;
  return { prefix: prefixBytes(prefix), integer };
}

async function compareDecoded(source, left, right, signal) {
  const leftIterator = decodedStringChunks(source, left);
  const rightIterator = decodedStringChunks(source, right);
  let leftText = "", rightText = "", leftOffset = 0, rightOffset = 0;
  let leftDone = false, rightDone = false;
  while (true) {
    if (leftOffset === leftText.length && !leftDone) {
      abort(signal); await yieldTurn();
      const next = leftIterator.next(); leftDone = next.done === true; leftText = next.value ?? ""; leftOffset = 0;
    }
    if (rightOffset === rightText.length && !rightDone) {
      const next = rightIterator.next(); rightDone = next.done === true; rightText = next.value ?? ""; rightOffset = 0;
    }
    if (leftDone || rightDone) return leftDone === rightDone ? 0 : leftDone ? -1 : 1;
    const count = Math.min(leftText.length - leftOffset, rightText.length - rightOffset);
    const leftPart = leftText.slice(leftOffset, leftOffset + count);
    const rightPart = rightText.slice(rightOffset, rightOffset + count);
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
    leftOffset += count; rightOffset += count;
  }
}

async function numberValue(source, node, signal) {
  let negative = false, exponentNegative = false, exponent = 0, inExponent = false, inFraction = false;
  let integerDigits = 0, totalDigits = 0, firstSignificant = -1, leading = "", sticky = false;
  for (let offset = node.start; offset < node.end; offset += WINDOW) {
    abort(signal);
    const chunk = source.readRangeSync(offset, Math.min(node.end, offset + WINDOW));
    for (const byte of chunk) {
      if (byte === 45) { if (inExponent) exponentNegative = true; else negative = true; }
      else if (byte === 43) continue;
      else if (byte === 46) inFraction = true;
      else if (byte === 69 || byte === 101) inExponent = true;
      else if (inExponent) exponent = Math.min(Number.MAX_SAFE_INTEGER, exponent * 10 + byte - 48);
      else {
        if (!inFraction) integerDigits++;
        if (firstSignificant < 0 && byte !== 48) firstSignificant = totalDigits;
        if (firstSignificant >= 0) { if (leading.length < 800) leading += String.fromCharCode(byte); else if (byte !== 48) sticky = true; }
        totalDigits++;
      }
    }
    if (node.end - node.start >= WINDOW) await yieldTurn();
  }
  if (firstSignificant < 0) return negative ? -0 : 0;
  if (sticky) leading += "1";
  const power = (exponentNegative ? -exponent : exponent) + integerDigits - firstSignificant - leading.length;
  return Number(`${negative ? "-" : ""}${leading}e${power}`);
}

class JsonScanner {
  constructor(document) {
    this.document = document;
    this.database = document.database;
    this.insert = this.database.prepare("INSERT INTO nodes(type,start,end,parent,key_id,ordinal,count,stage,pending,prefix,integer_key,member_prefix) VALUES(?,?,?,?,?,?,0,?,NULL,?,?,?)");
    this.update = this.database.prepare("UPDATE nodes SET count=?,stage=?,pending=? WHERE id=?");
    this.updateEnd = this.database.prepare("UPDATE nodes SET end=? WHERE id=?");
    this.frame = null;
    this.position = 0;
    this.token = null;
    this.root = null;
  }
  save() { if (this.frame) this.update.run(this.frame.count, this.frame.stage, this.frame.pending, this.frame.id); }
  expectingKey() { return this.frame?.type === "object" && ["keyOrEnd", "key"].includes(this.frame.stage); }
  accept(type, start, end, container = false) {
    if (this.expectingKey()) {
      if (type !== "string") invalid();
      const info = keyInfo(this.document.source, { start, end });
      const id = Number(this.insert.run("key", start, end, null, null, null, null, info.prefix, info.integer, null).lastInsertRowid);
      this.frame.pending = id; this.frame.pendingPrefix = info.prefix; this.frame.stage = "colon"; return;
    }
    if (this.frame && !["valueOrEnd", "value"].includes(this.frame.stage) || !this.frame && this.root !== null) invalid();
    const parent = this.frame?.id ?? null;
    const keyId = this.frame?.type === "object" ? this.frame.pending : null;
    const memberPrefix = keyId === null ? null : this.frame.pendingPrefix;
    const ordinal = this.frame?.count ?? 0;
    const id = Number(this.insert.run(type, start, end, parent, keyId, ordinal,
      container ? type === "object" ? "keyOrEnd" : "valueOrEnd" : null, null, null, memberPrefix).lastInsertRowid);
    if (this.frame) { this.frame.count++; this.frame.stage = "commaOrEnd"; this.frame.pending = null; this.frame.pendingPrefix = null; this.save(); }
    else this.root = id;
    if (container) this.frame = { id, type, count: 0, stage: type === "object" ? "keyOrEnd" : "valueOrEnd", pending: null };
  }
  close(type, position) {
    const frame = this.frame;
    if (!frame || frame.type !== type || ![type === "object" ? "keyOrEnd" : "valueOrEnd", "commaOrEnd"].includes(frame.stage)) invalid();
    this.save();
    this.updateEnd.run(position + 1, frame.id);
    const node = this.document.node(frame.id);
    this.frame = node.parent === null ? null : this.document.node(node.parent);
  }
  numberByte(byte) {
    const digit = byte >= 48 && byte <= 57;
    const state = this.token.state;
    if (state === "sign") { if (!digit) invalid(); this.token.state = byte === 48 ? "zero" : "integer"; }
    else if (["zero", "integer"].includes(state)) {
      if (digit) { if (state === "zero") invalid(); }
      else if (byte === 46) this.token.state = "fractionStart";
      else if (byte === 69 || byte === 101) this.token.state = "exponentStart";
      else return false;
    } else if (state === "fractionStart") { if (!digit) invalid(); this.token.state = "fraction"; }
    else if (state === "fraction") { if (byte === 69 || byte === 101) this.token.state = "exponentStart"; else if (!digit) return false; }
    else if (state === "exponentStart") { if (byte === 43 || byte === 45) this.token.state = "exponentSign"; else if (digit) this.token.state = "exponent"; else invalid(); }
    else if (state === "exponentSign") { if (!digit) invalid(); this.token.state = "exponent"; }
    else if (state === "exponent" && !digit) return false;
    return true;
  }
  consume(chunk) {
    for (let offset = 0; offset < chunk.length; offset++, this.position++) {
      const byte = chunk[offset];
      const token = this.token;
      if (token?.type === "string") {
        if (token.unicode) {
          if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) invalid();
          token.unicode--; continue;
        }
        if (token.escape) {
          token.escape = false;
          if (byte === 117) token.unicode = 4;
          else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) invalid();
          continue;
        }
        if (byte === 92) token.escape = true;
        else if (byte === 34) { this.accept("string", token.start, this.position + 1); this.token = null; }
        else if (byte < 32) invalid();
        continue;
      }
      if (token?.type === "number") {
        if (this.numberByte(byte)) continue;
        this.accept("number", token.start, this.position); this.token = null;
      } else if (token?.type === "literal") {
        if (byte !== token.text.charCodeAt(token.offset++)) invalid();
        if (token.offset === token.text.length) { this.accept(token.text, token.start, this.position + 1); this.token = null; }
        continue;
      }
      if ([32, 9, 10, 13].includes(byte)) continue;
      if (byte === 34) this.token = { type: "string", start: this.position, escape: false, unicode: 0 };
      else if (byte === 123 || byte === 91) this.accept(byte === 123 ? "object" : "array", this.position, null, true);
      else if (byte === 125 || byte === 93) this.close(byte === 125 ? "object" : "array", this.position);
      else if (byte === 58) { if (this.frame?.stage !== "colon") invalid(); this.frame.stage = "value"; }
      else if (byte === 44) {
        if (this.frame?.stage !== "commaOrEnd") invalid();
        this.frame.stage = this.frame.type === "object" ? "key" : "value";
      } else if (byte === 45 || byte >= 48 && byte <= 57) {
        this.token = { type: "number", start: this.position, state: byte === 45 ? "sign" : byte === 48 ? "zero" : "integer" };
      } else if ([116, 102, 110].includes(byte)) {
        this.token = { type: "literal", start: this.position, text: { 116: "true", 102: "false", 110: "null" }[byte], offset: 1 };
      } else invalid();
    }
  }
  finish() {
    if (this.token?.type === "number" && ["zero", "integer", "fraction", "exponent"].includes(this.token.state)) {
      this.accept("number", this.token.start, this.position); this.token = null;
    }
    if (this.token || this.frame || this.root === null) invalid();
    return this.root;
  }
}

export class JsonDocument {
  constructor(source, database, directory, signal) {
    this.source = pagedSource(source);
    this.database = database;
    this.directory = directory;
    this.signal = signal;
    this.closed = false;
    this.activeRows = new Set();
    this.getById = database.prepare("SELECT * FROM nodes WHERE id=?");
    this.arrayItem = database.prepare("SELECT * FROM nodes WHERE parent=? AND ordinal=?");
    database.exec("CREATE TABLE canonical_children(parent INTEGER,sequence INTEGER,child_id INTEGER,PRIMARY KEY(parent,sequence)) WITHOUT ROWID; CREATE TABLE canonical_ready(parent INTEGER PRIMARY KEY); CREATE TABLE canonical_frames(walk_id TEXT,depth INTEGER,node_id INTEGER,next_index INTEGER,first INTEGER,metadata_mode TEXT,PRIMARY KEY(walk_id,depth)) WITHOUT ROWID; CREATE TABLE input_record_cache(node_id INTEGER PRIMARY KEY,record TEXT)");
    this.canonicalReady = database.prepare("SELECT parent FROM canonical_ready WHERE parent=?");
    this.addCanonicalChild = database.prepare("INSERT INTO canonical_children VALUES(?,?,?)");
    this.nextArrayChild = database.prepare("SELECT *,ordinal AS walk_sequence FROM nodes WHERE parent=? AND ordinal>? ORDER BY ordinal LIMIT 1");
    this.nextObjectChild = database.prepare("SELECT nodes.*,canonical_children.sequence AS walk_sequence FROM canonical_children JOIN nodes ON nodes.id=canonical_children.child_id WHERE canonical_children.parent=? AND canonical_children.sequence>? ORDER BY canonical_children.sequence LIMIT 1");
    this.addFrame = database.prepare("INSERT INTO canonical_frames VALUES(?,?,?,-1,1,?)");
    this.readFrame = database.prepare("SELECT * FROM canonical_frames WHERE walk_id=? AND depth=?");
    this.advanceFrame = database.prepare("UPDATE canonical_frames SET next_index=?,first=? WHERE walk_id=? AND depth=?");
    this.removeFrame = database.prepare("DELETE FROM canonical_frames WHERE walk_id=? AND depth=?");
    this.removeWalk = database.prepare("DELETE FROM canonical_frames WHERE walk_id=?");
    this.laterKey = database.prepare("SELECT * FROM nodes WHERE parent=? AND ordinal>? AND member_prefix=? ORDER BY ordinal LIMIT 1");
    this.countNodes = database.prepare("SELECT count(*) AS count FROM nodes");
    this.fieldCandidates = database.prepare("SELECT * FROM nodes WHERE parent=? AND member_prefix=? ORDER BY ordinal DESC");
    this.clearCanonicalChildren = database.prepare("DELETE FROM canonical_children WHERE parent=?");
    this.markCanonicalReady = database.prepare("INSERT INTO canonical_ready VALUES(?)");
    this.readInputRecord = database.prepare("SELECT record FROM input_record_cache WHERE node_id=?");
    this.writeInputRecord = database.prepare("INSERT OR REPLACE INTO input_record_cache VALUES(?,?)");
    this.memberPage = database.prepare("SELECT value.*,key.prefix,key.integer_key FROM nodes value JOIN nodes key ON value.key_id=key.id WHERE value.parent=? AND value.ordinal>? ORDER BY value.ordinal LIMIT 256");
    this.singleMember = database.prepare("SELECT value.*,key.prefix,key.integer_key FROM nodes value JOIN nodes key ON key.id=value.key_id WHERE value.id=?");
    this.childPage = database.prepare("SELECT * FROM nodes WHERE parent=? AND ordinal>? AND ordinal<? ORDER BY ordinal LIMIT 256");
  }
  assertOpen() { if (this.closed) throw new Error("JSON_DOCUMENT_RELEASED"); abort(this.signal); }
  get nodeCount() { this.assertOpen(); return this.countNodes.get().count; }
  *rows(statement, ...parameters) {
    this.assertOpen();
    const iterator = statement.iterate(...parameters);
    this.activeRows.add(iterator);
    try {
      while (true) {
        this.assertOpen();
        const entry = iterator.next();
        if (entry.done) break;
        yield entry.value;
      }
    } finally {
      this.activeRows.delete(iterator);
      try { iterator.return?.(); } catch (error) { if (!this.closed) throw error; }
    }
  }
  node(id) { this.assertOpen(); return id == null ? null : this.getById.get(id) ?? null; }
  getNode(target = []) {
    this.assertOpen();
    if (target && typeof target === "object" && !Array.isArray(target) && Number.isSafeInteger(target.id)) return this.node(target.id);
    const parts = Array.isArray(target) ? target : [target];
    let current = this.root;
    for (const part of parts) {
      if (!current) return null;
      if (current.type === "array") {
        const index = typeof part === "number" ? part : /^(0|[1-9][0-9]*)$/u.test(String(part)) ? Number(part) : -1;
        current = this.arrayItem.get(current.id, index) ?? null;
      } else if (current.type === "object") current = this.field(current, String(part));
      else return null;
    }
    return current;
  }
  field(node, name) {
    const prefix = prefixBytes(name.slice(0, PREFIX_UNITS));
    for (const candidate of this.fieldCandidates.iterate(node.id, prefix)) {
      let offset = 0, matches = true;
      for (const chunk of decodedStringChunks(this.source, this.node(candidate.key_id))) {
        if (chunk !== name.slice(offset, offset + chunk.length)) { matches = false; break; }
        offset += chunk.length;
      }
      if (matches && offset === name.length) return candidate;
    }
    return null;
  }
  getSmall(target, { maxBytes = 65536 } = {}) {
    const node = this.getNode(target);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 65536) throw new RangeError("Small JSON reads are limited to 64KiB");
    if (!node) return undefined;
    if (node.end - node.start > maxBytes) throw Object.assign(new RangeError("JSON value requires a streaming reader"), { code: "JSON_VALUE_TOO_LARGE", bytes: node.end - node.start });
    if (node.end - node.start <= WINDOW) return JSON.parse(this.source.readRangeSync(node.start, node.end).toString("utf8"));
    const chunks = [];
    for (let offset = node.start; offset < node.end; offset += WINDOW) chunks.push(this.source.readRangeSync(offset, Math.min(node.end, offset + WINDOW)));
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  smallField(node, name, limit = 4096) {
    const value = this.field(node, name);
    if (!value || value.end - value.start > limit) return undefined;
    return this.getSmall(value, { maxBytes: limit });
  }
  isString(node, text) {
    if (!node || !["key", "string"].includes(node.type)) return false;
    let offset = 0;
    for (const chunk of decodedStringChunks(this.source, node)) {
      if (chunk !== text.slice(offset, offset + chunk.length)) return false;
      offset += chunk.length;
    }
    return offset === text.length;
  }
  stringNonempty(node) {
    if (node?.type !== "string") return false;
    for (const chunk of decodedStringChunks(this.source, node)) if (chunk.length) return true;
    return false;
  }
  readRange(start, endExclusive) {
    this.assertOpen();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || endExclusive < start || start < 0 || endExclusive > this.source.bytes || endExclusive - start > WINDOW) throw new RangeError("JSON range reads are limited to 32KiB");
    return this.source.readRangeSync(start, endExclusive);
  }
  openRange(target, { signal = this.signal } = {}) {
    const node = this.getNode(target);
    if (!node) throw new Error("JSON_NODE_MISSING");
    return Readable.from(rangeChunks(this.source, node.start, node.end, signal));
  }
  span(target) { const node = this.getNode(target); return node ? { start: node.start, end: node.end, endExclusive: node.end, bytes: node.end - node.start } : null; }
  async compareMembers(left, right) {
    if (left.integer_key !== null || right.integer_key !== null) {
      if (left.integer_key === null) return 1;
      if (right.integer_key === null) return -1;
      if (left.integer_key !== right.integer_key) return left.integer_key - right.integer_key;
    }
    const prefix = Buffer.compare(left.prefix, right.prefix);
    return prefix || await compareDecoded(this.source, this.node(left.key_id), this.node(right.key_id), this.signal);
  }
  async sortBatch(members) {
    for (let width = 1; width < members.length; width *= 2) {
      const output = [];
      for (let start = 0; start < members.length; start += width * 2) {
        let left = start, right = Math.min(start + width, members.length);
        const leftEnd = right, rightEnd = Math.min(start + width * 2, members.length);
        while (left < leftEnd || right < rightEnd) {
          const comparison = left < leftEnd && right < rightEnd ? await this.compareMembers(members[left], members[right]) : left < leftEnd ? -1 : 1;
          if (comparison < 0 || comparison === 0 && members[left].id < members[right].id) output.push(members[left++]);
          else output.push(members[right++]);
        }
      }
      members = output;
    }
    return members;
  }
  member(id) {
    return this.singleMember.get(id);
  }
  async *rawChildren(parent, start = 0, end = Number.MAX_SAFE_INTEGER) {
    let after = start - 1;
    while (true) {
      this.assertOpen();
      const children = this.childPage.all(parent, after, end);
      if (!children.length) return;
      for (const child of children) { this.assertOpen(); after = child.ordinal; yield child; }
      await yieldTurn();
    }
  }
  async *memberRows(parent) {
    let after = -1;
    while (true) {
      this.assertOpen();
      const members = this.memberPage.all(parent, after);
      if (!members.length) return;
      for (const member of members) { this.assertOpen(); after = member.ordinal; yield member; }
      await yieldTurn();
    }
  }
  async sortedMembers(node) {
    const filename = path.join(this.directory, `sort-${node.id}.idx`);
    if (fs.existsSync(filename)) return filename;
    let runCount = 0, batch = [];
    const runName = (pass, index) => path.join(this.directory, `sort-${node.id}-${pass}-${index}.idx`);
    const flush = async () => {
      batch = await this.sortBatch(batch);
      const buffer = Buffer.allocUnsafe(batch.length * 8);
      let count = 0;
      for (let index = 0; index < batch.length; index++) {
        if (index + 1 < batch.length && await this.compareMembers(batch[index], batch[index + 1]) === 0) continue;
        buffer.writeDoubleLE(batch[index].id, count++ * 8);
      }
      fs.writeFileSync(runName(0, runCount++), buffer.subarray(0, count * 8), { flag: "wx", mode: 0o600 });
      batch = [];
    };
    for await (const member of this.memberRows(node.id)) {
      this.assertOpen(); batch.push(member);
      if (batch.length === RUN_ITEMS) { await flush(); await yieldTurn(); }
    }
    if (batch.length || !runCount) await flush();
    let pass = 0;
    while (runCount > 1) {
      let nextCount = 0;
      for (let index = 0; index < runCount; index += 2) {
        this.assertOpen();
        const outputName = runName(pass + 1, nextCount++);
        if (index + 1 === runCount) { fs.renameSync(runName(pass, index), outputName); continue; }
        const leftName = runName(pass, index), rightName = runName(pass, index + 1);
        const left = fs.openSync(leftName, "r"), right = fs.openSync(rightName, "r"), output = fs.openSync(outputName, "wx", 0o600);
        const word = Buffer.allocUnsafe(8);
        const next = descriptor => fs.readSync(descriptor, word, 0, 8, null) ? this.member(word.readDoubleLE()) : null;
        try {
          let leftValue = next(left), rightValue = next(right), emitted = 0;
          while (leftValue || rightValue) {
            const comparison = leftValue && rightValue ? await this.compareMembers(leftValue, rightValue) : leftValue ? -1 : 1;
            const selected = comparison === 0 ? leftValue.id > rightValue.id ? leftValue : rightValue : comparison < 0 ? leftValue : rightValue;
            word.writeDoubleLE(selected.id); fs.writeSync(output, word);
            if (comparison <= 0) leftValue = next(left);
            if (comparison >= 0) rightValue = next(right);
            if (++emitted % RUN_ITEMS === 0) { this.assertOpen(); await yieldTurn(); }
          }
        } finally { fs.closeSync(left); fs.closeSync(right); fs.closeSync(output); }
        fs.unlinkSync(leftName); fs.unlinkSync(rightName);
      }
      runCount = nextCount; pass++;
    }
    fs.renameSync(runName(pass, 0), filename);
    return filename;
  }
  async *children(target) {
    const node = this.getNode(target);
    if (!node || !["array", "object"].includes(node.type)) return;
    if (node.type === "array") {
      yield* this.rawChildren(node.id);
      return;
    }
    if (node.count <= RUN_ITEMS) {
      const members = await this.sortBatch(this.memberPage.all(node.id, -1));
      for (let index = 0; index < members.length; index++) {
        if (index + 1 < members.length && await this.compareMembers(members[index], members[index + 1]) === 0) continue;
        yield members[index];
      }
      return;
    }
    const filename = await this.sortedMembers(node);
    const descriptor = fs.openSync(filename, "r");
    const buffer = Buffer.allocUnsafe(WINDOW);
    try {
      let count;
      while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) {
        for (let offset = 0; offset < count; offset += 8) { this.assertOpen(); yield this.node(buffer.readDoubleLE(offset)); }
        await yieldTurn();
      }
    } finally { fs.closeSync(descriptor); }
  }
  async *inputItems({ start = 0, end = Infinity } = {}) {
    const input = this.getNode(["input"]);
    if (input?.type !== "array") return;
    for await (const node of this.rawChildren(input.id, start, Math.min(end, Number.MAX_SAFE_INTEGER))) {
      this.assertOpen(); yield { ...node, index: node.ordinal };
    }
  }
  async ignoredMetadata(child, field, version) {
    const key = this.node(child.key_id);
    if (this.isString(key, "turn_id")) return true;
    if (field !== "internal_chat_message_metadata_passthrough") return false;
    if (this.isString(key, "content_item_kinds")) return true;
    if (this.isString(key, "create_time")) return child.type === "null" || child.type === "number" && Number.isFinite(await numberValue(this.source, child, this.signal));
    if (version >= 2 && this.isString(key, "content_token_count") && child.type === "number") {
      const value = await numberValue(this.source, child, this.signal); return Number.isSafeInteger(value) && value >= 0;
    }
    return false;
  }
  async ensureCanonicalOrder(node, signal = this.signal) {
    if (node.type !== "object" || this.canonicalReady.get(node.id)) return;
    while (this.orderBuilding) {
      await this.orderBuilding.catch(() => {});
      this.assertOpen(); abort(signal);
      if (this.canonicalReady.get(node.id)) return;
    }
    const work = this.buildCanonicalOrder(node, signal);
    this.orderBuilding = work;
    try { await work; }
    finally { if (this.orderBuilding === work) this.orderBuilding = null; }
  }
  async buildCanonicalOrder(node, signal) {
    this.clearCanonicalChildren.run(node.id);
    let sequence = 0;
    try {
      for await (const child of this.children(node)) {
        this.assertOpen(); abort(signal);
        this.addCanonicalChild.run(node.id, sequence++, child.id);
        if (sequence % RUN_ITEMS === 0) await yieldTurn();
      }
      this.markCanonicalReady.run(node.id);
    } catch (error) {
      if (!this.closed) this.clearCanonicalChildren.run(node.id);
      throw error;
    }
  }
  nextOrderedChild(node, after = -1) {
    return (node.type === "array" ? this.nextArrayChild : this.nextObjectChild).get(node.id, after) ?? null;
  }
  async canonicalChild(node, child, mode, version, signal) {
    if (mode && mode !== "root" && await this.ignoredMetadata(child, mode, version)) return null;
    let childMode = "";
    if (mode === "root" && node.type === "object") {
      const key = this.node(child.key_id);
      for (const field of ["metadata", "internal_chat_message_metadata_passthrough"]) {
        if (child.type !== "object" || !this.isString(key, field)) continue;
        await this.ensureCanonicalOrder(child, signal);
        let entry = this.nextOrderedChild(child), exists = false;
        while (entry) {
          if (!await this.ignoredMetadata(entry, field, version)) { exists = true; break; }
          abort(signal);
          entry = this.nextOrderedChild(child, entry.walk_sequence);
        }
        if (!exists) return null;
        childMode = field;
      }
      if (this.isString(key, "content") && this.isString(this.field(node, "type"), "reasoning")
        && (child.type === "array" && child.count === 0 || version >= 2 && child.type === "null")) return null;
    }
    return { node: child, mode: childMode };
  }
  async visibleChild(parent, after = -1) {
    let child = this.nextArrayChild.get(parent.id, after) ?? null;
    while (child) {
      this.assertOpen();
      if (parent.type !== "object") return child;
      const key = this.node(child.key_id);
      let later = this.laterKey.get(parent.id, child.ordinal, key.prefix) ?? null;
      let hidden = false;
      while (later) {
        if (key.prefix.length < PREFIX_UNITS * 2 || await compareDecoded(this.source, key, this.node(later.key_id), this.signal) === 0) { hidden = true; break; }
        later = this.laterKey.get(parent.id, later.ordinal, key.prefix) ?? null;
      }
      if (!hidden) return child;
      child = this.nextArrayChild.get(parent.id, child.ordinal) ?? null;
      await yieldTurn();
    }
    return null;
  }
  async *canonicalChunks(target, { comparisonVersion, signal = this.signal } = {}) {
    const root = this.getNode(target);
    if (!root) throw new Error("JSON_NODE_MISSING");
    const walkId = crypto.randomUUID();
    let depth = -1;
    let current = { node: root, mode: comparisonVersion ? "root" : "" };
    let operations = 0;
    let stringBytes = 0;
    try {
      while (current || depth >= 0) {
        this.assertOpen(); abort(signal);
        if (++operations % RUN_ITEMS === 0) await yieldTurn();
        if (current) {
          const { node, mode } = current;
          current = null;
          if (["string", "key"].includes(node.type)) {
            yield '"';
            for (const chunk of decodedStringChunks(this.source, node)) {
              abort(signal); yield JSON.stringify(chunk).slice(1, -1);
              if ((stringBytes += Buffer.byteLength(chunk)) >= WINDOW) { stringBytes = 0; await yieldTurn(); }
            }
            yield '"';
          } else if (node.type === "number") yield JSON.stringify(await numberValue(this.source, node, signal));
          else if (["true", "false", "null"].includes(node.type)) yield node.type;
          else {
            yield node.type === "array" ? "[" : "{";
            await this.ensureCanonicalOrder(node, signal);
            this.addFrame.run(walkId, ++depth, node.id, mode);
          }
        } else {
          const frame = this.readFrame.get(walkId, depth);
          const parent = this.node(frame.node_id);
          const child = this.nextOrderedChild(parent, frame.next_index);
          if (!child) {
            this.removeFrame.run(walkId, depth--);
            yield parent.type === "array" ? "]" : "}";
            continue;
          }
          this.advanceFrame.run(child.walk_sequence, frame.first, walkId, depth);
          const entry = await this.canonicalChild(parent, child, frame.metadata_mode, comparisonVersion, signal);
          if (!entry) continue;
          if (!frame.first) yield ",";
          this.advanceFrame.run(child.walk_sequence, 0, walkId, depth);
          if (parent.type === "object") {
            yield '"';
            for (const chunk of decodedStringChunks(this.source, this.node(child.key_id))) {
              abort(signal); yield JSON.stringify(chunk).slice(1, -1);
              if ((stringBytes += Buffer.byteLength(chunk)) >= WINDOW) { stringBytes = 0; await yieldTurn(); }
            }
            yield '\":';
          }
          current = entry;
        }
      }
    } finally { if (!this.closed) this.removeWalk.run(walkId); }
  }
  async canonicalHash(target, options = {}) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of this.canonicalChunks(target, options)) hash.update(chunk);
    return hash.digest("hex");
  }
  async stringHash(node) {
    const hash = crypto.createHash("sha256");
    for (const chunk of decodedStringChunks(this.source, node)) { this.assertOpen(); hash.update(chunk); await yieldTurn(); }
    return hash.digest("hex");
  }
  async comparisonVersionsDiffer(node) {
    if (node.type !== "object") return false;
    const metadata = this.field(node, "internal_chat_message_metadata_passthrough");
    if (metadata?.type === "object") {
      const count = this.field(metadata, "content_token_count");
      if (count?.type === "number") {
        const value = await numberValue(this.source, count, this.signal);
        if (Number.isSafeInteger(value) && value >= 0) return true;
      }
    }
    return this.smallField(node, "type") === "reasoning" && this.field(node, "content")?.type === "null";
  }
  async *inputRecords(options = {}) {
    for await (const node of this.inputItems(options)) {
      const cached = this.readInputRecord.get(node.id);
      if (cached) {
        this.source.readRangeSync(0, 0);
        yield JSON.parse(cached.record);
        continue;
      }
      const type = node.type === "object" ? this.smallField(node, "type") : null;
      const status = node.type === "object" ? this.field(node, "status") : null;
      const completed = !status || this.isString(status, "completed");
      const hashV1 = await this.canonicalHash(node, { comparisonVersion: 1 });
      const hashV2 = await this.comparisonVersionsDiffer(node) ? await this.canonicalHash(node, { comparisonVersion: 2 }) : hashV1;
      const record = { index: node.index, hashV1, hashV2, isUser: node.type === "object" && this.smallField(node, "role") === "user"
          && (!this.field(node, "type") || type === "message"),
        isReasoning: type === "reasoning" && completed, isAssistantText: false };
      if (["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(type)) {
        const callId = this.field(node, "call_id");
        if (callId?.type === "string") {
          const callIdHash = await this.stringHash(callId);
          if (type.endsWith("_output")) record.outputReceipt = { type, callIdHash, hasOutput: this.field(node, "output") !== null };
          else {
            const name = this.field(node, "name"), content = this.field(node, type === "function_call" ? "arguments" : "input");
            if (this.stringNonempty(callId) && this.stringNonempty(name) && content?.type === "string") {
              const digest = crypto.createHash("sha256").update('{"call_id":');
              for await (const chunk of this.canonicalChunks(callId)) digest.update(chunk);
              digest.update(',"content":'); for await (const chunk of this.canonicalChunks(content)) digest.update(chunk);
              digest.update(',"name":'); for await (const chunk of this.canonicalChunks(name)) digest.update(chunk);
              digest.update(',"type":').update(JSON.stringify(type)).update("}");
              record.toolReceipt = { callIdHash, callHash: digest.digest("hex"), outputType: type === "function_call" ? "function_call_output" : "custom_tool_call_output" };
            }
          }
        }
      }
      if (type === "message" && completed && this.smallField(node, "role") === "assistant") {
        const content = this.field(node, "content");
        let valid = content?.type === "array" && content.count > 0, nonempty = false;
        if (valid) for await (const part of this.children(content)) {
          if (part.type !== "object" || this.smallField(part, "type") !== "output_text" || this.field(part, "text")?.type !== "string") { valid = false; break; }
          nonempty ||= this.stringNonempty(this.field(part, "text"));
        }
        record.isAssistantText = valid && nonempty;
      }
      this.writeInputRecord.run(node.id, JSON.stringify(record));
      yield record;
    }
  }
  async *compactionChunks(node) {
    yield '{"id":';
    const id = this.field(node, "id");
    if (id?.type === "string") yield* this.canonicalChunks(id); else yield "null";
    yield ',"encrypted_content":'; yield* this.canonicalChunks(this.field(node, "encrypted_content")); yield "}";
  }
  async compactionHash() {
    const hash = crypto.createHash("sha256");
    let count = 0;
    for await (const node of this.inputItems()) {
      if (node.type !== "object" || this.smallField(node, "type") !== "compaction") continue;
      if (!this.stringNonempty(this.field(node, "encrypted_content"))) return null;
      let bytes = 0;
      for await (const chunk of this.compactionChunks(node)) bytes += Buffer.byteLength(chunk);
      hash.update(`${bytes}:`);
      for await (const chunk of this.compactionChunks(node)) hash.update(chunk);
      count++;
    }
    return count ? hash.digest("hex") : null;
  }
  async normalizeLocalNotices() {
    this.assertOpen();
    if (this.noticesPrepared) return { changed: this.noticeCount > 0, count: this.noticeCount };
    this.database.exec("CREATE TABLE notice_refs(id TEXT PRIMARY KEY); CREATE TABLE notice_nodes(id INTEGER PRIMARY KEY,start INTEGER,end INTEGER); CREATE INDEX notice_ranges ON notice_nodes(start)");
    const addRef = this.database.prepare("INSERT OR IGNORE INTO notice_refs VALUES(?)");
    const pattern = /^msg_proxy_(?:root_)?[a-f0-9]{32}$/u;
    for await (const node of this.inputItems()) {
      if (node.type !== "object" || this.smallField(node, "type") !== "item_reference") continue;
      const id = this.smallField(node, "id");
      if (typeof id === "string" && pattern.test(id)) addRef.run(id);
    }
    const reference = this.database.prepare("SELECT id FROM notice_refs WHERE id=?");
    const insert = this.database.prepare("INSERT INTO notice_nodes VALUES(?,?,?)");
    let count = 0;
    for await (const node of this.inputItems()) {
      if (node.type !== "object" || this.smallField(node, "type") !== "message" || this.smallField(node, "role") !== "assistant"
        || this.smallField(node, "status") !== "completed" || this.field(node, "call_id")) continue;
      const id = this.smallField(node, "id");
      if (typeof id !== "string" || !pattern.test(id) || reference.get(id)) continue;
      const content = this.field(node, "content");
      if (content?.type !== "array" || !content.count) continue;
      let valid = true;
      for await (const part of this.children(content)) {
        if (part.type !== "object" || this.smallField(part, "type") !== "output_text" || this.field(part, "text")?.type !== "string") { valid = false; break; }
      }
      if (valid) { insert.run(node.id, node.start, node.end); count++; }
    }
    this.noticesPrepared = true; this.noticeCount = count;
    return { changed: count > 0, count };
  }
  async *normalizedRange(start, end, signal) {
    let offset = start;
    for (const entry of this.rows(this.database.prepare("SELECT * FROM notice_nodes WHERE start>=? AND end<=? ORDER BY start"), start, end)) {
      yield* rangeChunks(this.source, offset, entry.start, signal);
      yield Buffer.from("{");
      let first = true;
      for await (const child of this.rawChildren(entry.id)) {
        const key = this.node(child.key_id);
        if (this.isString(key, "id")) continue;
        if (!first) yield Buffer.from(","); first = false;
        yield* rangeChunks(this.source, key.start, key.end, signal); yield Buffer.from(":");
        yield* rangeChunks(this.source, child.start, child.end, signal);
      }
      yield Buffer.from("}"); offset = entry.end;
    }
    yield* rangeChunks(this.source, offset, end, signal);
  }
  async normalizedOriginalChunks(options = {}) {
    const { changed } = await this.normalizeLocalNotices();
    return { changed, chunks: this.originalChunks({ ...options, normalizeLocalNotices: changed }) };
  }
  async *originalChunks({ omitRootFields = [], normalizeLocalNotices = false, signal = this.signal } = {}) {
    this.assertOpen();
    if (normalizeLocalNotices) await this.normalizeLocalNotices();
    const ranges = (start, end) => normalizeLocalNotices ? this.normalizedRange(start, end, signal) : rangeChunks(this.source, start, end, signal);
    if (!omitRootFields.length) { yield* ranges(0, this.source.bytes); return; }
    yield Buffer.from("{");
    let first = true;
    for await (const child of this.children(this.root)) {
      const key = this.node(child.key_id);
      if (omitRootFields.some(name => this.isString(key, name))) continue;
      if (!first) yield Buffer.from(","); first = false;
      yield* rangeChunks(this.source, key.start, key.end, signal);
      yield Buffer.from(":"); yield* ranges(child.start, child.end);
    }
    yield Buffer.from("}");
  }
  async writeOriginal(writable, options = {}) { await pipeline(Readable.from(this.originalChunks(options)), writable, { signal: options.signal ?? this.signal }); }
  async topLevelSmall({ fields = ["model", "stream", "previous_response_id", "store", "metadata"], maxBytes = 65536 } = {}) {
    const result = {};
    for (const field of fields) {
      const node = this.getNode([field]);
      if (node && node.end - node.start <= maxBytes) Object.defineProperty(result, field, { value: this.getSmall(node, { maxBytes }), enumerable: true });
    }
    return result;
  }
  async release() {
    if (this.closed) return this.releasePromise;
    this.closed = true;
    this.releasePromise = (async () => {
      this.source.clearCache();
      for (const iterator of this.activeRows) iterator.return?.();
      this.activeRows.clear();
      try { this.database.close(); }
      finally {
        try { if (this.ownedDecoded) this.source.release(); }
        finally {
          try { await this.retainedSource?.release?.(); }
          finally { fs.rmSync(this.directory, { recursive: true, force: true }); }
        }
      }
    })();
    return this.releasePromise;
  }
}

async function* walk(document, root) {
  if (!root || !["object", "array"].includes(root.type)) return;
  let current = root, operations = 0;
  while (current) {
    document.assertOpen();
    if (++operations % RUN_ITEMS === 0) await yieldTurn();
    let next = null;
    if (["object", "array"].includes(current.type)) {
      yield current;
      next = await document.visibleChild(current);
    }
    while (!next && current.id !== root.id) {
      const parent = document.node(current.parent);
      next = await document.visibleChild(parent, current.ordinal);
      current = parent;
      document.assertOpen();
      if (++operations % RUN_ITEMS === 0) await yieldTurn();
    }
    current = next;
  }
}

async function contextAndImages(document) {
  const input = document.getNode(["input"]);
  let hasImages = false, reminderCount = 0, opaqueItems = 0;
  for await (const current of walk(document, input)) {
    if (current.type === "object" && (document.smallField(current, "type") === "input_image" || document.field(current, "image_url"))) { hasImages = true; break; }
  }
  if (input?.type !== "array") return { hasImages, contextHint: { contextPreparationHint: null, reminderCount: 0, inputItems: null, visibility: "unknown" } };
  for await (const node of document.inputItems()) {
    if (node.type !== "object") continue;
    const encrypted = document.field(node, "encrypted_content");
    if (encrypted && (encrypted.type === "string" ? document.stringNonempty(encrypted) : !["null", "false"].includes(encrypted.type) && (encrypted.type !== "number" || await numberValue(document.source, encrypted, document.signal) !== 0))) opaqueItems++;
    if (document.smallField(node, "role") !== "developer") continue;
    const content = document.field(node, "content");
    async function countReminders(textNode) {
      if (textNode?.type !== "string") return;
      let tail = "", inside = false;
      for (const chunk of decodedStringChunks(document.source, textNode)) {
        let text = tail + chunk, offset = 0;
        while (true) {
          const needle = inside ? "</context_window_reminder>" : "<context_window_reminder>";
          const position = text.indexOf(needle, offset);
          if (position < 0) { tail = text.slice(Math.max(offset, text.length - needle.length + 1)); break; }
          offset = position + needle.length;
          if (inside) reminderCount++;
          inside = !inside;
        }
        document.assertOpen(); await yieldTurn();
      }
    }
    if (content?.type === "string") await countReminders(content);
    else if (content?.type === "array") for await (const part of document.children(content)) {
      if (part.type === "object" && ["input_text", "text"].includes(document.smallField(part, "type"))) await countReminders(document.field(part, "text"));
    }
  }
  return { hasImages, contextHint: { contextPreparationHint: reminderCount ? true : null, hintFreshness: "unknown", reminderCount,
    inputItems: input.count, opaqueItems, visibility: reminderCount ? "visible_hint_not_execution" : opaqueItems ? "partial" : "visible_no_hint" } };
}

export async function inspectJsonBodySource(source, contentEncoding, { signal, directory = os.tmpdir() } = {}) {
  abort(signal);
  if (!source || !Number.isSafeInteger(source.bytes) || source.bytes < 0 || typeof source.open !== "function" || typeof source.readRangeSync !== "function") throw new TypeError("A repeatable bounded body source is required");
  const encodings = normalizedEncoding(contentEncoding);
  const workspace = fs.mkdtempSync(path.join(directory, "source-json-"));
  let database, document, retained;
  try {
    retained = source.retain ? source.retain() : source;
    database = new DatabaseSync(path.join(workspace, "index.sqlite"));
    database.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; CREATE TABLE nodes(id INTEGER PRIMARY KEY,type TEXT,start INTEGER,end INTEGER,parent INTEGER,key_id INTEGER,ordinal INTEGER,count INTEGER,stage TEXT,pending INTEGER,prefix BLOB,integer_key INTEGER,member_prefix BLOB); CREATE INDEX children ON nodes(parent,ordinal); CREATE INDEX member_keys ON nodes(parent,member_prefix,ordinal); BEGIN");
    const decoded = await decodeSource(retained, encodings, workspace, database, signal);
    document = new JsonDocument(decoded.source, database, workspace, signal);
    document.retainedSource = source.retain ? retained : null;
    document.ownedDecoded = decoded.owned;
    const scanner = new JsonScanner(document);
    const validator = new TextDecoder("utf-8", { fatal: true });
    try {
      for await (const incoming of decoded.source.open({ signal })) {
        for (let offset = 0; offset < incoming.length; offset += WINDOW) {
          abort(signal);
          const chunk = incoming.subarray(offset, Math.min(offset + WINDOW, incoming.length));
          validator.decode(chunk, { stream: true }); scanner.consume(chunk); await yieldTurn();
        }
      }
      validator.decode();
      document.root = document.node(scanner.finish());
      if (scanner.position !== decoded.source.bytes) invalid();
    } catch (cause) {
      abort(signal);
      if (cause instanceof RequestInspectionError) throw cause;
      throw new RequestInspectionError("invalid_json", { cause });
    }
    if (document.root.type !== "object") throw new RequestInspectionError("invalid_json_object", { decodedBytes: decoded.source.bytes });
    database.exec("COMMIT; BEGIN");
    const modelNode = document.getNode(["model"]);
    let model = null;
    if (modelNode?.type === "string" && modelNode.end - modelNode.start <= 256 * 6 + 2) {
      const candidate = document.getSmall(modelNode, { maxBytes: 256 * 6 + 2 });
      if (candidate.length <= 256) model = candidate;
    }
    const { hasImages, contextHint } = await contextAndImages(document);
    return { model, modelInvalid: modelNode != null && modelNode.type !== "null" && model === null,
      stream: document.getNode(["stream"])?.type === "true", contextHint, decodedBytes: decoded.source.bytes,
      contentEncoding: encodings.join(", "), hasImages, nodeCount: document.nodeCount, document };
  } catch (error) {
    if (document) await document.release();
    else {
      database?.close();
      if (retained && source.retain) await retained.release?.();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
    throw error;
  }
}
