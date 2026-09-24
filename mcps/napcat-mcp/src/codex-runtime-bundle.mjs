import crypto from "node:crypto";
import fs from "node:fs";
import { promises as files } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REQUIRED_FILES = ["codex.exe", "codex-code-mode-host.exe"];
const MANIFEST_NAME = ".codex-runtime-manifest.json";
const MAX_FILES = 128;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

function checkActive(options = {}) {
  if (options.signal?.aborted) throw options.signal.reason;
  if (options.shouldStop?.()) throw new Error("Codex runtime preparation stopped");
}

async function withAbort(promise, options = {}) {
  checkActive(options);
  if (!options.signal) return promise;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(options.signal.reason);
    options.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}

async function describeFiles(root, skipManifest = false) {
  const entries = [];
  let bytes = 0;
  async function visit(directory, depth) {
    if (depth > 8) throw new Error("Codex runtime package is too deep");
    for (const entry of await files.readdir(directory, { withFileTypes: true })) {
      if (entry.name === MANIFEST_NAME && skipManifest && directory === root) continue;
      if (entry.name === MANIFEST_NAME) throw new Error("Codex runtime package contains a reserved manifest name");
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        const stat = await files.stat(absolute);
        bytes += stat.size;
        if (entries.length >= MAX_FILES || bytes > MAX_BYTES) throw new Error("Codex runtime package exceeds size limits");
        entries.push({ name: path.relative(root, absolute).replaceAll(path.sep, "/"), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
      } else {
        throw new Error(`Codex runtime package contains an unsupported entry: ${entry.name}`);
      }
    }
  }
  await visit(root, 0);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const name of REQUIRED_FILES) {
    if (!entries.some((entry) => entry.name === name && entry.size > 0)) {
      throw new Error(`Codex runtime package is missing ${name}`);
    }
  }
  return entries;
}

function metadataKey(entries) {
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function fileHash(filePath, options = {}) {
  checkActive(options);
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath, { signal: options.signal })) hash.update(chunk);
  checkActive(options);
  return hash.digest("hex");
}

async function hashEntries(root, entries, options = {}) {
  const hashed = [];
  for (const entry of entries) {
    hashed.push({ name: entry.name, size: entry.size, sha256: await fileHash(path.join(root, entry.name), options) });
  }
  return hashed;
}

function contentDigest(entries) {
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export async function inspectCodexSource(executablePath, options = {}) {
  checkActive(options);
  const sourcePath = path.resolve(executablePath);
  const sourceRoot = path.dirname(sourcePath);
  const entries = await describeFiles(sourceRoot);
  checkActive(options);
  return { sourcePath, sourceRoot, entries, sourceMetadata: metadataKey(entries) };
}

export async function digestCodexSource(description, options = {}) {
  const before = await hashEntries(description.sourceRoot, description.entries, options);
  const afterDescription = await inspectCodexSource(description.sourcePath, options);
  if (afterDescription.sourceMetadata !== description.sourceMetadata) throw new Error("Codex runtime source changed during verification");
  const after = await hashEntries(description.sourceRoot, description.entries, options);
  if (contentDigest(before) !== contentDigest(after)) throw new Error("Codex runtime source changed during verification");
  return contentDigest(after);
}

export async function validateOpenAiSignatures(bundleRoot, entries, options = {}) {
  checkActive(options);
  if (process.platform !== "win32") throw new Error("OpenAI runtime signature verification requires Windows");
  const executables = entries.filter((entry) => entry.name.toLowerCase().endsWith(".exe"));
  const encodedPaths = executables.map((entry) => path.join(bundleRoot, entry.name));
  const script = `$ErrorActionPreference = 'Stop'; $paths = ConvertFrom-Json '${JSON.stringify(encodedPaths).replaceAll("'", "''")}'; foreach ($item in $paths) { $signature = Get-AuthenticodeSignature -LiteralPath $item; if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O="OpenAI OpCo, LLC"') { throw "Invalid OpenAI signature: $item" } }`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 60000, signal: options.signal });
  checkActive(options);
}

export async function verifyCodexRuntimeBundle(executablePath, options = {}) {
  checkActive(options);
  const bundleRoot = path.resolve(options.bundleRoot);
  const packageRoot = path.dirname(path.resolve(executablePath));
  const parent = path.dirname(packageRoot);
  const belongsToStore = process.platform === "win32"
    ? parent.toLowerCase() === bundleRoot.toLowerCase()
    : parent === bundleRoot;
  if (!belongsToStore || path.basename(executablePath).toLowerCase() !== "codex.exe") {
    throw new Error("Codex runtime bundle path is outside the managed store");
  }
  const manifest = JSON.parse(await files.readFile(path.join(packageRoot, MANIFEST_NAME), "utf8"));
  const entries = await describeBundleFiles(packageRoot, options);
  if (contentDigest(entries) !== manifest.digest || manifest.digest !== path.basename(packageRoot)) {
    throw new Error("Codex runtime bundle manifest does not match its files");
  }
  if (options.validateBundleSignature) {
    await withAbort(options.validateBundleSignature(packageRoot, entries, options), options);
  } else {
    await validateOpenAiSignatures(packageRoot, entries, options);
  }
  checkActive(options);
  return { executablePath: path.join(packageRoot, "codex.exe"), digest: manifest.digest, sourcePath: manifest.sourcePath, sourceMetadata: manifest.sourceMetadata };
}

async function describeBundleFiles(packageRoot, options = {}) {
  const described = await describeFiles(packageRoot, true);
  return hashEntries(packageRoot, described, options);
}

export async function prepareCodexRuntimeBundle(executablePath, options = {}) {
  checkActive(options);
  const description = await inspectCodexSource(executablePath, options);
  const bundleRoot = path.resolve(options.bundleRoot);
  await files.mkdir(bundleRoot, { recursive: true });
  const sourceBefore = await hashEntries(description.sourceRoot, description.entries, options);
  const digest = contentDigest(sourceBefore);
  const finalRoot = path.join(bundleRoot, digest);
  if (await files.stat(finalRoot).then(() => true, () => false)) {
    const sourceAfterDescription = await inspectCodexSource(description.sourcePath, options);
    const sourceAfter = await hashEntries(description.sourceRoot, sourceAfterDescription.entries, options);
    if (sourceAfterDescription.sourceMetadata !== description.sourceMetadata || contentDigest(sourceAfter) !== digest) {
      throw new Error("Codex runtime source changed during verification");
    }
    const verified = await verifyCodexRuntimeBundle(path.join(finalRoot, "codex.exe"), options);
    checkActive(options);
    return { ...verified, sourcePath: description.sourcePath, sourceMetadata: description.sourceMetadata };
  }
  const stagingRoot = path.join(bundleRoot, `.preparing-${process.pid}-${crypto.randomUUID()}`);
  await files.mkdir(stagingRoot);
  try {
    for (const entry of description.entries) {
      checkActive(options);
      const destination = path.join(stagingRoot, entry.name);
      await files.mkdir(path.dirname(destination), { recursive: true });
      await pipeline(
        fs.createReadStream(path.join(description.sourceRoot, entry.name)),
        fs.createWriteStream(destination, { flags: "wx" }),
        { signal: options.signal },
      );
    }
    await withAbort(options.afterCopy?.(stagingRoot) ?? Promise.resolve(), options);
    const copied = await hashEntries(stagingRoot, description.entries, options);
    const sourceAfterDescription = await inspectCodexSource(description.sourcePath, options);
    const sourceAfter = await hashEntries(description.sourceRoot, sourceAfterDescription.entries, options);
    if (sourceAfterDescription.sourceMetadata !== description.sourceMetadata
      || contentDigest(copied) !== digest || contentDigest(sourceAfter) !== digest) {
      throw new Error("Codex runtime source changed or a companion file was lost during copy");
    }
    if (options.validateBundleSignature) {
      await withAbort(options.validateBundleSignature(stagingRoot, copied, options), options);
    } else {
      await validateOpenAiSignatures(stagingRoot, copied, options);
    }
    checkActive(options);
    await files.writeFile(path.join(stagingRoot, MANIFEST_NAME), `${JSON.stringify({ digest, sourcePath: description.sourcePath, sourceMetadata: description.sourceMetadata })}\n`);
    checkActive(options);
    try {
      await files.rename(stagingRoot, finalRoot);
    } catch (error) {
      if (!await files.stat(finalRoot).then(() => true, () => false)) throw error;
      await verifyCodexRuntimeBundle(path.join(finalRoot, "codex.exe"), options);
    }
    return { executablePath: path.join(finalRoot, "codex.exe"), digest, sourcePath: description.sourcePath, sourceMetadata: description.sourceMetadata };
  } finally {
    await files.rm(stagingRoot, { recursive: true, force: true });
  }
}
