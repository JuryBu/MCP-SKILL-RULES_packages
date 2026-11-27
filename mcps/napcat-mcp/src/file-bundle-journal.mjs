import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const keyPattern = /^[a-f0-9]{64}$/u;
const recordPattern = /^([0-9]{4})\.json$/u;
const maxRevision = 127;
const maxRecordBytes = 512 * 1024;

function fault(code, message) {
  throw Object.assign(new Error(message), { code });
}

function filename(revision) {
  return String(revision).padStart(4, "0") + ".json";
}

export function relayFileJournalKey(direction, sourceMachine, transferId) {
  return createHash("sha256").update(JSON.stringify([direction, sourceMachine, transferId])).digest("hex");
}

export function canArchiveFileBundle(value) {
  return value?.releaseState === "released"
    && (value.direction === "in" && value.state === "acknowledged"
      || value.direction === "out" && value.state === "received" && value.cleanupState === "removed");
}

export async function openRelayFileJournal(rootDirectory) {
  if (typeof rootDirectory !== "string" || !path.isAbsolute(rootDirectory)) {
    fault("RELAY_FILE_JOURNAL_ROOT_INVALID", "文件包账本需要私有绝对目录");
  }
  const root = await fs.realpath(rootDirectory);
  if (!(await fs.stat(root)).isDirectory()) {
    fault("RELAY_FILE_JOURNAL_ROOT_INVALID", "文件包账本目录无效");
  }

  function directory(key) {
    if (typeof key !== "string" || !keyPattern.test(key)) {
      fault("RELAY_FILE_JOURNAL_KEY_INVALID", "文件包账本编号无效");
    }
    return path.join(root, key);
  }

  const archiveRoot = path.join(root, "settled");

  async function checkArchive(create = false) {
    if (create) await fs.mkdir(archiveRoot, { mode: 0o700, recursive: true });
    try {
      if (!(await fs.lstat(archiveRoot)).isDirectory() || await fs.realpath(archiveRoot) !== archiveRoot) {
        fault("RELAY_FILE_JOURNAL_CORRUPT", "文件包历史目录身份变化");
      }
      return true;
    } catch (error) {
      if (error?.code === "ENOENT" && !create) return false;
      throw error;
    }
  }

  async function readAt(recordDirectory, key) {
    let entries;
    try {
      if (!(await fs.lstat(recordDirectory)).isDirectory()) {
        fault("RELAY_FILE_JOURNAL_CORRUPT", "文件包账本目录身份变化");
      }
      entries = await fs.readdir(recordDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const versions = entries.map((name) => recordPattern.exec(name)).filter(Boolean)
      .map((match) => Number(match[1])).sort((left, right) => left - right);
    if (!versions.length) return null;
    const revision = versions.at(-1);
    if (revision > maxRevision || versions.length !== revision + 1) {
      fault("RELAY_FILE_JOURNAL_CORRUPT", "文件包账本的修订不连续");
    }
    const filePath = path.join(recordDirectory, filename(revision));
    let record;
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.size > maxRecordBytes || !stat.size) {
        fault("RELAY_FILE_JOURNAL_CORRUPT", "文件包账本记录不是有效文件");
      }
      record = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        try { await fs.lstat(recordDirectory); } catch (gone) { if (gone?.code === "ENOENT") return null; throw gone; }
      }
      if (error instanceof SyntaxError) fault("RELAY_FILE_JOURNAL_CORRUPT", "文件包账本无法读回");
      throw error;
    }
    if (record?.key !== key || record?.revision !== revision || typeof record?.value !== "object"
      || record.value === null || Array.isArray(record.value)) {
      fault("RELAY_FILE_JOURNAL_CORRUPT", "文件包账本原件身份变化");
    }
    return record;
  }

  async function read(key) {
    const active = await readAt(directory(key), key);
    if (active || !await checkArchive()) return active;
    const archived = await readAt(path.join(archiveRoot, key), key);
    if (!archived) return null;
    if (!canArchiveFileBundle(archived.value)) fault("RELAY_FILE_JOURNAL_CORRUPT", "未结文件包误进历史目录");
    return { ...archived, archived: true };
  }

  async function advance(key, priorRevision, value) {
    const recordDirectory = directory(key);
    const previous = await read(key);
    if ((previous?.revision ?? null) !== priorRevision || canArchiveFileBundle(previous?.value)) return null;
    const revision = priorRevision === null ? 0 : priorRevision + 1;
    if (revision > maxRevision) {
      fault("RELAY_FILE_JOURNAL_LIMIT", "单次文件包操作修订数已达上限");
    }
    const record = { key, revision, value };
    const encoded = JSON.stringify(record);
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || Buffer.byteLength(encoded) > maxRecordBytes) {
      fault("RELAY_FILE_JOURNAL_RECORD_INVALID", "文件包账本记录超限或无效");
    }
    try {
      await fs.mkdir(recordDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const draftPath = path.join(recordDirectory, randomUUID() + ".part");
    const handle = await fs.open(draftPath, "wx", 0o600);
    try {
      try {
        await handle.writeFile(encoded, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(draftPath, path.join(recordDirectory, filename(revision)));
      } catch (error) {
        if (error?.code === "EEXIST") return null;
        throw error;
      }
      return JSON.parse(encoded);
    } finally {
      await fs.unlink(draftPath).catch(() => {});
    }
  }

  async function* scan({ limit = 4096, signal } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16_384) {
      fault("RELAY_FILE_JOURNAL_LIMIT", "文件包账本扫描限制无效");
    }
    const opened = await fs.opendir(root);
    let records = 0;
    for await (const entry of opened) {
      signal?.throwIfAborted();
      if (!keyPattern.test(entry.name)) continue;
      records += 1;
      if (records > limit) fault("RELAY_FILE_JOURNAL_LIMIT", "文件包账本超出有界扫描范围");
      const current = await readAt(directory(entry.name), entry.name);
      if (current) yield current;
    }
  }

  async function archiveCompleted(key, revision) {
    const current = await read(key);
    if (!current || current.revision !== revision || !canArchiveFileBundle(current.value)) return false;
    if (current.archived) return true;
    await checkArchive(true);
    const destination = path.join(archiveRoot, key);
    try {
      await fs.lstat(destination);
      fault("RELAY_FILE_JOURNAL_CORRUPT", "同一文件包出现两份历史原件");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(directory(key), destination);
      return true;
    } catch (error) {
      if (["EACCES", "EBUSY", "EPERM"].includes(error?.code)) return false;
      if (error?.code === "ENOENT") return (await read(key))?.archived === true;
      throw error;
    }
  }

  return { read, advance, scan, archiveCompleted };
}
