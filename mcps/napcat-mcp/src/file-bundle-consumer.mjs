import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { renameReplaceSync } from "./atomic-file.mjs";

const consumedCodes = new Set(["RELAY_FILE_CONTROL_INVALID", "RELAY_FILE_SOURCE_MISMATCH", "RELAY_FILE_OFFER_INVALID",
  "RELAY_FILE_ID_CONFLICT"]);
const gapCodes = new Set(["RELAY_CURSOR_EXPIRED", "RELAY_HISTORY_EXPIRED", "RELAY_HISTORY_GAP", "RELAY_CURSOR_SCOPE_MISMATCH"]);
const controlOps = new Set(["file_notice", "file_ack"]);
const routeKey = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function fault(code, message) {
  throw Object.assign(new Error(message), { code });
}

function scopeOf(value) {
  if (typeof value?.relay_key !== "string" || !routeKey.test(value.relay_key)
    || typeof value.group_id !== "string" || !/^[1-9][0-9]{4,31}$/u.test(value.group_id)
    || !Number.isSafeInteger(value.route_generation) || value.route_generation < 1) {
    fault("RELAY_FILE_CONTROL_SCOPE", "读取文件控制帧需要精确的群和代次");
  }
  return { relay_key: value.relay_key, group_id: value.group_id, route_generation: value.route_generation };
}

function sameScope(scope, other) {
  return scope.relay_key === other?.relay_key && scope.group_id === other?.group_id
    && scope.route_generation === other?.route_generation;
}

function validCursor(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\u0000-\u0020]/u.test(value);
}

export async function openFileBundleControlConsumer({ privateRoot, listScopes, readVerifiedPage, decodeVerifiedEvent, ingestControl,
  now = Date.now, routeBudgetMs = 2000 }) {
  if (!Number.isSafeInteger(routeBudgetMs) || routeBudgetMs < 10 || routeBudgetMs > 5000) {
    fault("RELAY_FILE_CONTROL_SCOPE", "单群文件控制帧时限无效");
  }
  const root = await fs.realpath(privateRoot);
  const checkpoints = path.join(root, "control-checkpoints");
  await fs.mkdir(checkpoints, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(checkpoints)).isDirectory() || await fs.realpath(checkpoints) !== checkpoints) {
    fault("RELAY_FILE_CONTROL_CURSOR_INVALID", "文件控制帧进度目录身份已变化");
  }
  const during = new Set();

  async function readCheckpoint(file, scope) {
    try {
      const metadata = await fs.lstat(file);
      if (!metadata.isFile() || !metadata.size || metadata.size > 4096) {
        fault("RELAY_FILE_CONTROL_CURSOR_INVALID", "文件控制帧进度文件不可用");
      }
      const stored = JSON.parse(await fs.readFile(file, "utf8"));
      if (stored?.v !== 1 || !sameScope(scope, stored.scope) || !validCursor(stored.cursor)) {
        fault("RELAY_FILE_CONTROL_CURSOR_INVALID", "文件控制帧进度不属于此群或代次");
      }
      return stored.cursor;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) fault("RELAY_FILE_CONTROL_CURSOR_INVALID", "文件控制帧进度无法读回");
      throw error;
    }
  }

  async function saveCheckpoint(file, scope, cursor, signal) {
    signal?.throwIfAborted();
    const draft = path.join(checkpoints, randomUUID() + ".part");
    try {
      const handle = await fs.open(draft, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ v: 1, scope, cursor }), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      renameReplaceSync(draft, file);
    } finally {
      await fs.unlink(draft).catch(() => {});
    }
  }

  async function sweepScope(scope, signal) {
    const key = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
    if (during.has(key)) return { relay_key: scope.relay_key, status: "in_progress" };
    during.add(key);
    try {
      const file = path.join(checkpoints, key + ".json");
      const cursor = await readCheckpoint(file, scope);
      const page = await readVerifiedPage({ ...scope, cursor, limit: 12, signal });
      signal?.throwIfAborted();
      if (page?.route_gap || (Array.isArray(page?.route_gaps) && page.route_gaps.some((gap) => !gap?.relay_key
        || sameScope(scope, gap)))) return { relay_key: scope.relay_key, status: "history_gap" };
      const events = page?.events;
      if (!Array.isArray(events) || events.length > 12 || (events.length > 0
        && (!validCursor(page.next_cursor) || page.next_cursor === cursor))
        || (page?.route_gaps !== undefined && !Array.isArray(page.route_gaps))
        || (events.length === 0 && page?.has_more === true) || events.some((event) => !sameScope(scope, event))) {
        fault("RELAY_FILE_CONTROL_PAGE_INVALID", "中继读取没有返回同一群和代次的有效进度");
      }
      let processed = 0;
      let rejected = 0;
      let retryNeeded = false;
      for (const event of events) {
        signal?.throwIfAborted();
        if (!controlOps.has(event?.frame?.op)) continue;
        try {
          const verified = await decodeVerifiedEvent(event, { signal });
          signal?.throwIfAborted();
          if (!verified || (verified.op === "file_notice" && Number.isSafeInteger(verified.offer?.expiresAt)
            && verified.offer.expiresAt <= now())) {
            rejected += 1;
            continue;
          }
          const outcome = await ingestControl(verified, { signal });
          if ((verified.op === "file_notice" && outcome?.direction === "in")
            || outcome?.status === "received") processed += 1;
          else if (outcome?.status === "not_found") rejected += 1;
          else retryNeeded = true;
        } catch (error) {
          signal?.throwIfAborted();
          if (consumedCodes.has(error?.code)) rejected += 1;
          else retryNeeded = true;
        }
      }
      if (events.length > 0 && !retryNeeded) await saveCheckpoint(file, scope, page.next_cursor, signal);
      return { relay_key: scope.relay_key, status: retryNeeded ? "checking_original" : "read", processed, rejected,
        has_more: page?.has_more === true };
    } catch (error) {
      signal?.throwIfAborted();
      if (gapCodes.has(error?.code)) return { relay_key: scope.relay_key, status: "history_gap", code: error.code };
      return { relay_key: scope.relay_key, status: "blocked", code: error?.code ?? "RELAY_FILE_CONTROL_UNAVAILABLE" };
    } finally {
      during.delete(key);
    }
  }

  async function sweepWithBudget(scope, signal) {
    signal?.throwIfAborted();
    const request = new AbortController();
    let timeout;
    let cancel;
    const interrupted = new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        resolve({ relay_key: scope.relay_key, status: "checking_original", reason: "route_read_deadline" });
        request.abort(new Error("原群文件控制帧读取期限已到"));
      }, routeBudgetMs);
      cancel = () => { request.abort(signal.reason); reject(signal.reason); };
      signal?.addEventListener("abort", cancel, { once: true });
    });
    try {
      return await Promise.race([sweepScope(scope, request.signal), interrupted]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  }

  return {
    async sweep({ relayKeys, signal } = {}) {
      const scopes = await listScopes({ relayKeys, signal });
      if (!Array.isArray(scopes) || scopes.length > 16) fault("RELAY_FILE_CONTROL_SCOPE", "单次文件控制帧巡查限 16 条已配置路线");
      const results = new Array(scopes.length);
      let next = 0;
      async function runNext() {
        while (next < scopes.length) {
          const index = next++;
          const value = scopes[index];
          signal?.throwIfAborted();
          if (relayKeys && !relayKeys.includes(value?.relay_key)) continue;
          let scope;
          try {
            scope = scopeOf(value);
          } catch (error) {
            results[index] = { relay_key: routeKey.test(value?.relay_key ?? "") ? value.relay_key : null,
              status: "blocked", code: error.code };
            continue;
          }
          results[index] = await sweepWithBudget(scope, signal);
        }
      }
      await Promise.all(Array.from({ length: Math.min(scopes.length, 4) }, runNext));
      return results.filter(Boolean);
    },
  };
}
