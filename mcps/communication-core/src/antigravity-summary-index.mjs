import { constants, copyFileSync, createReadStream, lstatSync, mkdtempSync, statfsSync } from "node:fs";
import { readdir, rmdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { CoreError, requireInteger } from "./contracts.mjs";

const DATABASE_NAME = "conversation_summaries.db";
const JOB_KIND = "communication-core-ag-summary-page";
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;
const BYTE_CAP = 256 * 1024 * 1024;
const WORK_PREFIX = "communication-ag-catalog-";

export function antigravityWorkspaceLabels(uris) {
  const labels = new Set();
  if (!Array.isArray(uris)) return undefined;
  for (const value of uris.slice(0, 12)) {
    if (typeof value !== "string" || value.length > 2048 || labels.size >= 4) continue;
    try {
      const uri = new URL(value);
      if (uri.protocol !== "file:" || uri.username || uri.password || uri.search || uri.hash) continue;
      const segment = decodeURIComponent(uri.pathname.split("/").filter(Boolean).at(-1) ?? "");
      if (!segment.trim() || /[\\/:\u0000-\u001f\u007f]/u.test(segment) || segment.length > 96) continue;
      labels.add(segment);
    } catch {}
  }
  return labels.size ? [...labels].join("、") : undefined;
}

function safeWorkspaces(value) {
  if (typeof value !== "string") return undefined;
  try { return antigravityWorkspaceLabels(JSON.parse(value)); } catch { return undefined; }
}

function unavailable(code = "host_content_unavailable") {
  return new CoreError(code, "没有取得反重力桌面目录的只读结果");
}

function fileSet(filePath) {
  if (!isAbsolute(filePath) || basename(filePath) !== DATABASE_NAME) throw unavailable();
  return ["", "-wal"].flatMap(suffix => {
    let info;
    try { info = lstatSync(filePath + suffix, { bigint: true }); }
    catch (error) {
      if (suffix === "-wal" && error.code === "ENOENT") return [];
      throw error;
    }
    if (!info.isFile() || info.size > BigInt(BYTE_CAP)) throw unavailable();
    const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    return [{ suffix, identity, byteSize: Number(info.size), stamp: `${identity}:${info.size}:${info.ctimeNs}:${info.mtimeNs}` }];
  });
}

async function fileHash(filename) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}

async function readPage({ filePath, copyDirectory, after, limit, exact }) {
  const files = fileSet(filePath);
  const free = statfsSync(copyDirectory);
  const required = files.reduce((sum, file) => sum + file.byteSize, 0);
  if (free.bavail * free.bsize < required + 16 * 1024 * 1024) throw unavailable();
  const copied = join(copyDirectory, DATABASE_NAME);
  for (const file of files) copyFileSync(filePath + file.suffix, copied + file.suffix, constants.COPYFILE_EXCL);
  for (const file of files) {
    if (await fileHash(filePath + file.suffix) !== await fileHash(copied + file.suffix)) throw unavailable();
  }
  if (JSON.stringify(fileSet(filePath)) !== JSON.stringify(files)) throw unavailable();
  const database = new DatabaseSync(copied, { readOnly: true, allowExtension: false, timeout: 80 });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    if (database.prepare("SELECT type FROM sqlite_schema WHERE name='conversation_summaries'").get()?.type !== "table") {
      throw unavailable("host_content_unverified");
    }
    const columns = new Map(database.prepare("PRAGMA table_info(conversation_summaries)").all().map(row => [row.name, row]));
    if (columns.get("conversation_id")?.pk !== 1
      || !["title", "workspace_uris", "last_modified_time", "parent_conversation_id", "nesting_depth", "source", "agent_name"].every(name => columns.has(name))) {
      throw unavailable("host_content_unverified");
    }
    const statement = database.prepare(`SELECT conversation_id, substr(title,1,256) AS title, substr(workspace_uris,1,2048) AS workspace_uris,
      substr(last_modified_time,1,64) AS updated_at FROM conversation_summaries WHERE conversation_id ${exact ? "=" : ">"} ?
      AND coalesce(parent_conversation_id,'') = '' AND coalesce(nesting_depth,0) = 0
      AND coalesce(source,'') = '' AND coalesce(agent_name,'') = '' ORDER BY conversation_id LIMIT ?`);
    const rows = statement.all(after, limit + 1);
    if (rows.some(row => typeof row.conversation_id !== "string" || !ID_PATTERN.test(row.conversation_id))) throw unavailable("host_content_unverified");
    return {
      conversations: rows.slice(0, limit).map(row => ({
        cascade_id: row.conversation_id, title: row.title, workspace: safeWorkspaces(row.workspace_uris), updated_at: row.updated_at,
      })),
      has_more: rows.length > limit,
      generation: createHash("sha256").update(files[0].identity).digest("hex").slice(0, 24),
    };
  } finally {
    database.close();
  }
}

if (!isMainThread && workerData?.kind === JOB_KIND) {
  try { parentPort.postMessage({ value: await readPage(workerData) }); }
  catch (error) { parentPort.postMessage({ error: error instanceof CoreError ? error.code : "host_content_unavailable" }); }
}

async function removeOwnedCopy(directory) {
  if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith(WORK_PREFIX)) throw unavailable();
  for (const name of await readdir(directory)) {
    if (![DATABASE_NAME, DATABASE_NAME + "-wal", DATABASE_NAME + "-shm", DATABASE_NAME + "-journal"].includes(name)) throw unavailable();
    await unlink(join(directory, name));
  }
  await rmdir(directory);
}

export function createAntigravitySummaryIndex({ filePath, timeoutMs = 1800 } = {}) {
  if (typeof filePath !== "string" || !isAbsolute(filePath) || basename(filePath) !== DATABASE_NAME) throw unavailable("invalid_config");
  requireInteger(timeoutMs, "timeoutMs", 100, 3000);
  const lifetime = new AbortController();
  let active;
  function query({ after, limit, signal, exact = false }) {
    if (lifetime.signal.aborted || signal?.aborted) throw unavailable("request_cancelled");
    if (active) throw unavailable("host_content_busy");
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([lifetime.signal, deadline, ...(signal ? [signal] : [])]);
    const copyDirectory = mkdtempSync(join(resolve(tmpdir()), WORK_PREFIX));
    let worker;
    try {
      worker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: { kind: JOB_KIND, filePath, copyDirectory, after, limit, exact } });
    } catch {
      active = removeOwnedCopy(copyDirectory).then(() => { throw unavailable(); }).finally(() => { active = undefined; });
      return active;
    }
    let payload;
    const abort = () => { void worker.terminate().catch(() => {}); };
    active = new Promise((resolve, reject) => {
      worker.once("message", value => { payload = value; });
      worker.once("error", () => { payload = undefined; });
      worker.once("exit", code => {
        if (combined.aborted) reject(unavailable(deadline.aborted ? "host_content_timeout" : "request_cancelled"));
        else if (code !== 0 || !payload?.value) reject(unavailable(payload?.error === "host_content_unverified" ? payload.error : "host_content_unavailable"));
        else resolve(payload.value);
      });
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
    }).finally(async () => {
      combined.removeEventListener("abort", abort);
      try { await removeOwnedCopy(copyDirectory); }
      finally { active = undefined; }
    });
    return active;
  }
  return {
    page({ after = "", limit, signal } = {}) {
      if (typeof after !== "string" || after !== "" && !ID_PATTERN.test(after)) throw unavailable("invalid_cursor");
      requireInteger(limit, "limit", 1, 50);
      return query({ after, limit, signal });
    },
    find({ conversationId, signal } = {}) {
      if (typeof conversationId !== "string" || !ID_PATTERN.test(conversationId)) throw unavailable("invalid_input");
      return query({ after: conversationId, limit: 1, signal, exact: true }).then(result => result.conversations[0] ?? null);
    },
    async close() {
      lifetime.abort();
      await active?.catch(() => {});
    },
  };
}
