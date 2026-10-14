import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renameReplaceSync } from "./atomic-file.mjs";

export const OUTER_RUNTIME_SELECTION_FILE = "outer-runtime-selection.json";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const maximumBytes = 256 * 1024;
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function validDescriptor(value) {
  if (!object(value) || Object.keys(value).length !== 3 || typeof value.version !== "string"
    || !value.version.trim() || value.version.length > 128) return false;
  if (value.candidate === null) return value.version === "original" && value.sha256 === null;
  return typeof value.candidate === "string" && value.candidate.length > 0 && value.candidate.length <= 1024
    && !path.isAbsolute(value.candidate) && path.extname(value.candidate) === ".mjs"
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
}

function decode(bytes, maximumHistory) {
  const record = JSON.parse(bytes.toString("utf8"));
  if (!object(record) || Object.keys(record).length !== 6 || record.schemaVersion !== 1
    || !Number.isSafeInteger(record.revision) || record.revision < 0 || !validDescriptor(record.selected)
    || !Array.isArray(record.previous) || record.previous.length > maximumHistory || !record.previous.every(validDescriptor)
    || typeof record.savedAt !== "string" || !Number.isFinite(Date.parse(record.savedAt))) fail("OUTER_RUNTIME_SELECTION_RECORD_INVALID");
  const { sha256, ...payload } = record;
  if (sha256 !== digest(JSON.stringify(payload))) fail("OUTER_RUNTIME_SELECTION_RECORD_SHA_MISMATCH");
  return record;
}

export function createOuterRuntimeSelection(root, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const filePath = path.join(root, OUTER_RUNTIME_SELECTION_FILE);
  let observed = false;
  let originalBytes = null;
  let originalSha256 = null;
  let preserveRequired = false;
  let evidence = null;
  function checkRoot() {
    if (fsImpl.realpathSync(root) !== root) fail("OUTER_RUNTIME_SELECTION_ROOT_CHANGED");
  }
  function readBytes() {
    checkRoot();
    let stat;
    try { stat = fsImpl.lstatSync(filePath); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) fail("OUTER_RUNTIME_SELECTION_FILE_INVALID");
    return fsImpl.readFileSync(filePath);
  }
  function read() {
    try {
      originalBytes = readBytes();
      originalSha256 = originalBytes === null ? null : digest(originalBytes);
      observed = true;
      if (originalBytes === null) return { state: "empty", record: null, recordSha256: null };
      const record = decode(originalBytes, options.maximumHistory ?? 31);
      return { state: "loaded", record, recordSha256: originalSha256 };
    } catch (error) {
      preserveRequired = true;
      return { state: "invalid", record: null, recordSha256: originalSha256, error: error.code ?? error.message };
    }
  }
  function preserveEvidence() {
    preserveRequired = true;
    if (!observed || originalBytes === null) return null;
    checkRoot();
    const name = `outer-runtime-selection-evidence-${originalSha256}.json`;
    const destination = path.join(root, name);
    const temporaryPath = path.join(root, `.outer-runtime-selection-evidence-${crypto.randomUUID()}.tmp`);
    let descriptor;
    let created = false;
    const validateEvidence = file => {
      const stat = fsImpl.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== originalBytes.length
        || digest(fsImpl.readFileSync(file)) !== originalSha256) fail("OUTER_RUNTIME_SELECTION_EVIDENCE_INVALID");
    };
    try {
      validateEvidence(destination);
      evidence = name;
      return evidence;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    try {
      descriptor = fsImpl.openSync(temporaryPath, "wx", 0o600);
      created = true;
      fsImpl.writeFileSync(descriptor, originalBytes);
      fsImpl.fsyncSync(descriptor);
      fsImpl.closeSync(descriptor);
      descriptor = undefined;
      validateEvidence(temporaryPath);
      checkRoot();
      try { fsImpl.linkSync(temporaryPath, destination); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      validateEvidence(destination);
    } finally {
      if (descriptor !== undefined) { try { fsImpl.closeSync(descriptor); } catch {} }
      if (created) { try { fsImpl.rmSync(temporaryPath, { force: true }); } catch {} }
    }
    evidence = name;
    return evidence;
  }
  function save(payload) {
    if (!observed) read();
    const temporaryPath = path.join(root, `.outer-runtime-selection-${crypto.randomUUID()}.tmp`);
    let descriptor;
    let created = false;
    try {
      if (!observed) fail("OUTER_RUNTIME_SELECTION_UNREADABLE");
      const checkUnchanged = () => {
        const currentBytes = readBytes();
        if ((currentBytes === null ? null : digest(currentBytes)) !== originalSha256) fail("OUTER_RUNTIME_SELECTION_CHANGED");
      };
      checkUnchanged();
      if (preserveRequired) preserveEvidence();
      const value = { schemaVersion: 1, ...payload, savedAt: new Date().toISOString() };
      const bytes = Buffer.from(`${JSON.stringify({ ...value, sha256: digest(JSON.stringify(value)) }, null, 2)}\n`);
      decode(bytes, options.maximumHistory ?? 31);
      if (bytes.length > maximumBytes) fail("OUTER_RUNTIME_SELECTION_TOO_LARGE");
      descriptor = fsImpl.openSync(temporaryPath, "wx", 0o600);
      created = true;
      fsImpl.writeFileSync(descriptor, bytes);
      fsImpl.fsyncSync(descriptor);
      fsImpl.closeSync(descriptor);
      descriptor = undefined;
      checkUnchanged();
      renameReplaceSync(temporaryPath, filePath, { renameSync(source, destination) {
        checkUnchanged();
        fsImpl.renameSync(source, destination);
      } });
      originalBytes = bytes;
      originalSha256 = digest(bytes);
      preserveRequired = false;
      return { state: "saved", recordSha256: originalSha256, persistedVersion: payload.selected.version, evidence };
    } catch (cause) {
      const error = new Error("OUTER_RUNTIME_SELECTION_WRITE_FAILED", { cause });
      error.code = error.message;
      error.failureCode = cause.code ?? cause.message;
      throw error;
    } finally {
      if (descriptor !== undefined) { try { fsImpl.closeSync(descriptor); } catch {} }
      if (created) { try { fsImpl.rmSync(temporaryPath, { force: true }); } catch {} }
    }
  }
  return { read, save, preserveEvidence };
}
