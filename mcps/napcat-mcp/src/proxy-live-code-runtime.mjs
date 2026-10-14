import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const schema = "proxy-live-state-v1";
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const fail = code => { throw Object.assign(new Error(code), { code }); };
const externalRequire = createRequire(import.meta.url);
const protectedFields = Object.freeze(["clients", "websocketServer", "controlServer", "journal", "wakeVisibility", "displayPolicy", "outerRuntime", "controlToken", "writerEpoch", "managedInnerControl"]);

function inspectBundle(root, manifestPath, expectedSha256) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "")) fail("LIVE_CODE_MANIFEST_SHA_REQUIRED");
  const resolvedManifest = fs.realpathSync(manifestPath);
  if (!inside(root, resolvedManifest) || fs.lstatSync(manifestPath).isSymbolicLink()) fail("LIVE_CODE_MANIFEST_OUTSIDE_ROOT");
  const manifestBytes = fs.readFileSync(resolvedManifest);
  if (manifestBytes.length > 65536 || digest(manifestBytes) !== expectedSha256) fail("LIVE_CODE_MANIFEST_CHANGED");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.stateSchema !== schema
    || typeof manifest.version !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(manifest.version)
    || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 128) fail("LIVE_CODE_MANIFEST_INVALID");
  const format = manifest.format ?? "esm";
  if (!["esm", "commonjs-bundle"].includes(format)) fail("LIVE_CODE_FORMAT_INVALID");
  const bundleRoot = path.dirname(resolvedManifest);
  const entries = new Map();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !/^[a-zA-Z0-9_-]+\.(?:mjs|cjs)$/u.test(entry.path)
      || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "") || entries.has(entry.path)) fail("LIVE_CODE_FILE_INVALID");
    const suppliedPath = path.join(bundleRoot, entry.path);
    const stat = fs.lstatSync(suppliedPath);
    const filePath = fs.realpathSync(suppliedPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !inside(bundleRoot, filePath)) fail("LIVE_CODE_FILE_IDENTITY_INVALID");
    const bytes = fs.readFileSync(filePath);
    totalBytes += bytes.length;
    if (bytes.length > 1024 * 1024 || totalBytes > 8 * 1024 * 1024 || digest(bytes) !== entry.sha256) fail("LIVE_CODE_FILE_CHANGED");
    entries.set(entry.path, { filePath, bytes, sha256: entry.sha256 });
  }
  if (!entries.has(manifest.entry)) fail("LIVE_CODE_ENTRY_MISSING");
  if (!manifest.entry.endsWith(format === "esm" ? ".mjs" : ".cjs")) fail("LIVE_CODE_ENTRY_FORMAT_MISMATCH");
  for (const { bytes } of entries.values()) {
    const source = bytes.toString("utf8");
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/gu)];
    for (const match of imports) {
      const dependency = match[1];
      if (dependency.startsWith("node:") || dependency === "ws") continue;
      if (!dependency.startsWith("./") || !entries.has(dependency.slice(2))) fail("LIVE_CODE_DEPENDENCY_NOT_PINNED");
    }
  }
  return { manifest, format, entryPath: entries.get(manifest.entry).filePath, entries };
}

function loadCompiledBundle(bundle) {
  const entry = bundle.entries.get(bundle.manifest.entry);
  const module = { exports: {} };
  const require = dependency => {
    if (typeof dependency !== "string" || (!dependency.startsWith("node:") && dependency !== "ws")) {
      fail("LIVE_CODE_EXTERNAL_DEPENDENCY_REFUSED");
    }
    return externalRequire(dependency);
  };
  const execute = vm.compileFunction(entry.bytes.toString("utf8"),
    ["exports", "require", "module", "__filename", "__dirname"], { filename: entry.filePath });
  execute(module.exports, require, module, entry.filePath, path.dirname(entry.filePath));
  return module.exports;
}

export function inspectProxyLiveBundle(root, manifestPath, expectedSha256) {
  return inspectBundle(fs.realpathSync(root), manifestPath, expectedSha256);
}

export function loadProxyLiveCompiledBundle(root, manifestPath, expectedSha256) {
  const bundle = inspectProxyLiveBundle(root, manifestPath, expectedSha256);
  if (bundle.format !== "commonjs-bundle") fail("LIVE_PARENT_COMPILED_BUNDLE_REQUIRED");
  const module = loadCompiledBundle(bundle);
  inspectProxyLiveBundle(root, manifestPath, expectedSha256);
  return { manifest: bundle.manifest, module };
}

export function createProxyClassCodeParticipant(target) {
  const originalPrototype = Object.getPrototypeOf(target);
  const baselineMethods = Object.getOwnPropertyNames(originalPrototype).filter(name => name !== "constructor");
  const snapshots = new WeakSet();
  const preparations = new WeakSet();
  let generation = 0;
  const snapshot = () => {
    const token = Object.freeze({ state: target, implementation: Object.getPrototypeOf(target), generation });
    snapshots.add(token);
    return token;
  };
  const replace = prototype => {
    if (target.closed) fail("LIVE_CODE_NOT_READY");
    const retained = protectedFields.map(name => target[name]);
    const previousPrototype = Object.getPrototypeOf(target);
    try {
      Object.setPrototypeOf(target, prototype);
      if (protectedFields.some((name, index) => target[name] !== retained[index])) fail("LIVE_CODE_RESOURCE_DRIFT");
      if (target.status().closed === true || target.closed) fail("LIVE_CODE_ACTIVATION_FAILED");
    } catch (error) {
      Object.setPrototypeOf(target, previousPrototype);
      throw error;
    }
    generation++;
  };
  return Object.freeze({
    id: "outer-proxy", stateSchema: schema, exportName: "CodexAppServerProxy", snapshot,
    prepare(module) {
      const candidateClass = module?.CodexAppServerProxy;
      if (candidateClass?.hotRuntimeSchema !== schema) fail("LIVE_CODE_STATE_SCHEMA_MISMATCH");
      if (baselineMethods.some(name => typeof candidateClass.prototype[name] !== "function")) fail("LIVE_CODE_METHOD_MISSING");
      const candidate = Object.freeze({ state: target, implementation: candidateClass.prototype });
      preparations.add(candidate);
      return candidate;
    },
    activate(candidate) {
      if (!preparations.has(candidate) || candidate.state !== target) fail("LIVE_CODE_CANDIDATE_INVALID");
      const token = snapshot();
      replace(candidate.implementation);
      return token;
    },
    restore(token) {
      if (!snapshots.has(token) || token.state !== target) fail("LIVE_CODE_SNAPSHOT_INVALID");
      replace(token.implementation);
    },
  });
}

export function createProxyLiveCodeRuntime(target, options = {}) {
  const root = options.candidateRoot ? fs.realpathSync(options.candidateRoot) : null;
  const originalPrototype = Object.getPrototypeOf(target);
  const baselineMethods = Object.getOwnPropertyNames(originalPrototype).filter(name => name !== "constructor");
  const preparations = new Map();
  const legacyBundles = new Set();
  let revision = 0;
  let selected = { id: "original", version: "original", prototype: originalPrototype, manifestSha256: null };
  let previous = null;
  let preparing = false;
  const bind = input => {
    if (!root) fail("LIVE_CODE_DISABLED");
    if (!input || input.instanceId !== options.instanceId || input.expectedRevision !== revision) fail("LIVE_CODE_STALE_IDENTITY_OR_REVISION");
  };
  const status = () => ({ enabled: Boolean(root), stateSchema: schema, revision, preparing,
    legacyImports: legacyBundles.size, legacyImportLimit: 4,
    selected: { id: selected.id, version: selected.version, manifestSha256: selected.manifestSha256 },
    previous: previous ? { id: previous.id, version: previous.version } : null,
    prepared: [...preparations.values()].map(entry => ({ id: entry.id, version: entry.version, manifestSha256: entry.manifestSha256 })) });
  return {
    status,
    async prepare(input) {
      bind(input);
      if (preparing || preparations.size >= 4) fail("LIVE_CODE_PREPARATION_LIMIT");
      preparing = true;
      try {
        const bundle = inspectBundle(root, input.manifestPath, input.manifestSha256);
        let module;
        if (bundle.format === "commonjs-bundle") module = loadCompiledBundle(bundle);
        else {
          if (legacyBundles.has(bundle.entryPath)) fail("LIVE_CODE_BUNDLE_ALREADY_IMPORTED");
          if (legacyBundles.size >= 4) fail("LIVE_CODE_LEGACY_IMPORT_LIMIT");
          legacyBundles.add(bundle.entryPath);
          module = await import(pathToFileURL(bundle.entryPath).href);
        }
        const candidateClass = module.CodexAppServerProxy;
        if (candidateClass?.hotRuntimeSchema !== schema) fail("LIVE_CODE_STATE_SCHEMA_MISMATCH");
        const prototype = candidateClass.prototype;
        if (baselineMethods.some(name => typeof prototype[name] !== "function")) fail("LIVE_CODE_METHOD_MISSING");
        inspectBundle(root, input.manifestPath, input.manifestSha256);
        const entry = { id: crypto.randomUUID(), version: bundle.manifest.version, prototype,
          manifestPath: input.manifestPath, manifestSha256: input.manifestSha256, preparedRevision: revision };
        preparations.set(entry.id, entry);
        return { id: entry.id, version: entry.version, manifestSha256: entry.manifestSha256, revision };
      } finally { preparing = false; }
    },
    activate(input) {
      bind(input);
      if (preparing || target.closed) fail("LIVE_CODE_NOT_READY");
      const candidate = preparations.get(input.preparationId);
      if (!candidate || candidate.preparedRevision !== revision) fail("LIVE_CODE_PREPARATION_STALE");
      inspectBundle(root, candidate.manifestPath, candidate.manifestSha256);
      const retained = protectedFields.map(name => target[name]);
      const old = selected;
      const startedAt = performance.now();
      try {
        Object.setPrototypeOf(target, candidate.prototype);
        if (protectedFields.some((name, index) => target[name] !== retained[index])) fail("LIVE_CODE_RESOURCE_DRIFT");
        const snapshot = target.status();
        if (snapshot.closed === true || target.closed) fail("LIVE_CODE_ACTIVATION_FAILED");
      } catch (error) {
        Object.setPrototypeOf(target, old.prototype);
        throw error;
      }
      previous = old;
      selected = candidate;
      preparations.clear();
      revision++;
      return { ...status(), actualMs: performance.now() - startedAt, connectionsPreserved: true, retryCount: 0 };
    },
    restore(input) {
      bind(input);
      if (!previous || preparing) fail("LIVE_CODE_RESTORE_UNAVAILABLE");
      const discarded = selected;
      Object.setPrototypeOf(target, previous.prototype);
      selected = previous;
      previous = discarded;
      preparations.clear();
      revision++;
      return { ...status(), connectionsPreserved: true, retryCount: 0 };
    },
  };
}
