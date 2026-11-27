import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const header = Buffer.from("NAPCAT-PURE-DATA-V1\n", "ascii");
const trailerBytes = 4;
const chunkBytes = 64 * 1024;
const shaPattern = /^[a-f0-9]{64}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function invalid(code, message) {
  throw Object.assign(new Error(message), { code });
}

function integerLimit(value, fallback, ceiling) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ceiling) {
    invalid("RELAY_BUNDLE_LIMIT_INVALID", "文件包限制无效");
  }
  return limit;
}

export function relayBundleLimits(limits = {}) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    invalid("RELAY_BUNDLE_LIMIT_INVALID", "文件包限制无效");
  }
  return {
    maxBundleBytes: integerLimit(limits.maxBundleBytes, 16 * 1024 ** 2, 4 * 1024 ** 3),
    maxManifestBytes: integerLimit(limits.maxManifestBytes, 64 * 1024, 1024 ** 2),
    maxFiles: integerLimit(limits.maxFiles, 64, 1024),
  };
}

function checkName(name) {
  if (typeof name !== "string" || !name.trim() || name === "." || name === ".."
    || /[\\/:<>"|?*\u0000-\u001f\u007f]/u.test(name)
    || Buffer.byteLength(name) > 255 || Buffer.from(name).toString("utf8") !== name) {
    invalid("RELAY_BUNDLE_NAME_INVALID", "文件标签无效");
  }
  return name;
}

function sameFile(left, right) {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function openRegularFile(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    invalid("RELAY_BUNDLE_FILE_INVALID", "文件必须来自本机认可的绝对路径");
  }
  const original = await fs.lstat(filePath);
  if (!original.isFile() || !Number.isSafeInteger(original.size)) {
    invalid("RELAY_BUNDLE_FILE_INVALID", "只接收普通文件");
  }
  const handle = await fs.open(filePath, "r");
  try {
    if (!sameFile(original, await handle.stat())) {
      invalid("RELAY_BUNDLE_FILE_CHANGED", "文件在读取前发生变化");
    }
    return { handle, original };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function makeWorkDirectory(parent, prefix) {
  if (typeof parent !== "string" || !path.isAbsolute(parent)) {
    invalid("RELAY_BUNDLE_SPOOL_INVALID", "文件包目录必须是本机私有绝对目录");
  }
  const realParent = await fs.realpath(parent);
  if (!(await fs.stat(realParent)).isDirectory()) {
    invalid("RELAY_BUNDLE_SPOOL_INVALID", "文件包目录无效");
  }
  return fs.mkdtemp(path.join(realParent, prefix));
}

async function discardWork(directory, createdPaths) {
  await Promise.allSettled(createdPaths.map((filePath) => fs.unlink(filePath)));
  await fs.rmdir(directory).catch(() => {});
}

async function readExactly(handle, buffer, length, position, signal) {
  let received = 0;
  while (received < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, received, length - received, position + received);
    if (!bytesRead) invalid("RELAY_BUNDLE_TRUNCATED", "读取到不完整的文件包");
    received += bytesRead;
  }
}

async function writeExactly(handle, buffer, signal) {
  let written = 0;
  while (written < buffer.length) {
    signal?.throwIfAborted();
    const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, null);
    if (!bytesWritten) invalid("RELAY_BUNDLE_WRITE_FAILED", "文件包写入未推进");
    written += bytesWritten;
  }
}

async function copyRange({ input, output, start, bytes, buffer, bundleHash, entryHash, signal }) {
  let copied = 0;
  while (copied < bytes) {
    const size = Math.min(buffer.length, bytes - copied);
    await readExactly(input, buffer, size, start + copied, signal);
    const chunk = buffer.subarray(0, size);
    await writeExactly(output, chunk, signal);
    bundleHash.update(chunk);
    entryHash.update(chunk);
    copied += size;
  }
}

function manifestBytes(entries) {
  return Buffer.from(JSON.stringify({ entries }), "utf8");
}

function readManifest(encoded, dataBytes, maxFiles) {
  let parsed;
  try {
    parsed = JSON.parse(decoder.decode(encoded));
  } catch {
    invalid("RELAY_BUNDLE_MANIFEST_INVALID", "文件包索引不是有效 UTF-8 JSON");
  }
  if (!Array.isArray(parsed?.entries) || !parsed.entries.length || parsed.entries.length > maxFiles) {
    invalid("RELAY_BUNDLE_MANIFEST_INVALID", "文件包索引数量无效");
  }
  let remaining = dataBytes;
  const entries = parsed.entries.map((entry) => {
    const name = checkName(entry?.name);
    const { bytes, sha256 } = entry;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining
      || typeof sha256 !== "string" || !shaPattern.test(sha256)) {
      invalid("RELAY_BUNDLE_MANIFEST_INVALID", "文件大小或 SHA-256 无效");
    }
    remaining -= bytes;
    return { name, bytes, sha256 };
  });
  if (remaining !== 0 || !encoded.equals(manifestBytes(entries))) {
    invalid("RELAY_BUNDLE_MANIFEST_INVALID", "文件包的索引和数据不对应");
  }
  return entries;
}

export async function writeRelayFileBundle({ workRoot, files, limits, signal }) {
  const bounds = relayBundleLimits(limits);
  if (!Array.isArray(files) || !files.length || files.length > bounds.maxFiles) {
    invalid("RELAY_BUNDLE_FILE_COUNT", "文件数量超出本次文件包限制");
  }
  const sources = files.map((file) => ({ name: checkName(file?.name), filePath: file?.filePath }));
  signal?.throwIfAborted();
  const directory = await makeWorkDirectory(workRoot, "send-");
  const bundlePath = path.join(directory, "bundle.data");
  const created = [];
  let complete = false;
  try {
    const output = await fs.open(bundlePath, "wx", 0o600);
    created.push(bundlePath);
    const bundleHash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(chunkBytes);
    const entries = [];
    let bytes = header.length + trailerBytes;
    try {
      await writeExactly(output, header, signal);
      bundleHash.update(header);
      for (const source of sources) {
        signal?.throwIfAborted();
        const { handle, original } = await openRegularFile(source.filePath);
        let sha256;
        try {
          if (original.size > bounds.maxBundleBytes - bytes) {
            invalid("RELAY_BUNDLE_TOO_LARGE", "文件包超过传输字节上限");
          }
          const entryHash = createHash("sha256");
          await copyRange({ input: handle, output, start: 0, bytes: original.size, buffer, bundleHash, entryHash, signal });
          if (!sameFile(original, await handle.stat())) {
            invalid("RELAY_BUNDLE_FILE_CHANGED", "文件在封包时发生变化");
          }
          sha256 = entryHash.digest("hex");
        } finally {
          await handle.close();
        }
        bytes += original.size;
        entries.push({ name: source.name, bytes: original.size, sha256 });
      }
      const index = manifestBytes(entries);
      if (index.length > bounds.maxManifestBytes || index.length > bounds.maxBundleBytes - bytes) {
        invalid("RELAY_BUNDLE_TOO_LARGE", "文件包索引超过传输上限");
      }
      const trailer = Buffer.alloc(trailerBytes);
      trailer.writeUInt32BE(index.length);
      await writeExactly(output, index, signal);
      await writeExactly(output, trailer, signal);
      bundleHash.update(index).update(trailer);
      bytes += index.length;
      await output.sync();
      signal?.throwIfAborted();
    } finally {
      await output.close();
    }
    const result = { directory, bundlePath, entries, bytes, sha256: bundleHash.digest("hex") };
    complete = true;
    return result;
  } finally {
    if (!complete) await discardWork(directory, created);
  }
}

export async function stageRelayFileBundle({ workRoot, bundlePath, expected, limits, signal }) {
  const bounds = relayBundleLimits(limits);
  if (!Number.isSafeInteger(expected?.bytes) || expected.bytes <= header.length + trailerBytes
    || expected.bytes > bounds.maxBundleBytes || typeof expected.sha256 !== "string" || !shaPattern.test(expected.sha256)) {
    invalid("RELAY_BUNDLE_EXPECTATION_INVALID", "缺少有效的文件包长度或 SHA-256");
  }
  signal?.throwIfAborted();
  const { handle, original } = await openRegularFile(bundlePath);
  let directory;
  let complete = false;
  const created = [];
  try {
    let result;
    try {
      if (original.size !== expected.bytes) invalid("RELAY_BUNDLE_SIZE_MISMATCH", "文件包长度与预告不同");
      const magic = Buffer.alloc(header.length);
      const trailer = Buffer.alloc(trailerBytes);
      await readExactly(handle, magic, magic.length, 0, signal);
      if (!magic.equals(header)) invalid("RELAY_BUNDLE_FORMAT_INVALID", "不是受支持的纯数据文件包");
      const trailerAt = expected.bytes - trailerBytes;
      await readExactly(handle, trailer, trailer.length, trailerAt, signal);
      const indexLength = trailer.readUInt32BE();
      const indexAt = trailerAt - indexLength;
      if (indexLength < 1 || indexLength > bounds.maxManifestBytes || indexAt < magic.length) {
        invalid("RELAY_BUNDLE_MANIFEST_INVALID", "文件包索引越界");
      }
      const index = Buffer.alloc(indexLength);
      await readExactly(handle, index, index.length, indexAt, signal);
      const entries = readManifest(index, indexAt - magic.length, bounds.maxFiles);
      directory = await makeWorkDirectory(workRoot, "receive-");
      const bundleHash = createHash("sha256").update(magic);
      const buffer = Buffer.allocUnsafe(chunkBytes);
      let start = magic.length;
      const files = [];
      for (const [position, entry] of entries.entries()) {
        signal?.throwIfAborted();
        const filePath = path.join(directory, String(position) + ".data");
        const output = await fs.open(filePath, "wx", 0o600);
        created.push(filePath);
        try {
          const entryHash = createHash("sha256");
          await copyRange({ input: handle, output, start, bytes: entry.bytes, buffer, bundleHash, entryHash, signal });
          if (entryHash.digest("hex") !== entry.sha256) {
            invalid("RELAY_BUNDLE_ENTRY_HASH_MISMATCH", "包内文件未通过 SHA-256 校验");
          }
          await output.sync();
        } finally {
          await output.close();
        }
        files.push({ ...entry, filePath });
        start += entry.bytes;
      }
      if (bundleHash.update(index).update(trailer).digest("hex") !== expected.sha256) {
        invalid("RELAY_BUNDLE_HASH_MISMATCH", "整包未通过 SHA-256 校验");
      }
      if (!sameFile(original, await handle.stat())) {
        invalid("RELAY_BUNDLE_FILE_CHANGED", "文件包在验证过程中发生变化");
      }
      signal?.throwIfAborted();
      result = { directory, files, bytes: expected.bytes, sha256: expected.sha256 };
    } finally {
      await handle.close();
    }
    complete = true;
    return result;
  } finally {
    if (directory && !complete) await discardWork(directory, created);
  }
}
