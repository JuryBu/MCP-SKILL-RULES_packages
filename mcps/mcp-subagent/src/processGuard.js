import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./registry.js";

let lockHandle = null;
let cleanupInstalled = false;
let parentMonitor = null;

async function pidExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupLock(lockPath) {
  try {
    await lockHandle?.close();
  } catch {}
  lockHandle = null;
  await fs.rm(lockPath, { force: true });
}

function installCleanupHandlers(lockPath) {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.once("exit", () => {
    try {
      fs.rm(lockPath, { force: true });
    } catch {}
  });
  process.once("SIGINT", async () => {
    await cleanupLock(lockPath);
    process.exit(130);
  });
  process.once("SIGTERM", async () => {
    await cleanupLock(lockPath);
    process.exit(143);
  });
}

function startParentMonitor(lockPath, parentPid) {
  if (parentMonitor || !parentPid) return;
  parentMonitor = setInterval(async () => {
    if (!(await pidExists(parentPid))) {
      await cleanupLock(lockPath);
      process.exit(0);
    }
  }, 30000);
  parentMonitor.unref?.();
}

async function writeOwnerLock(lockPath, extra = {}) {
  lockHandle = await fs.open(lockPath, "wx");
  await lockHandle.writeFile(JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    created_at: new Date().toISOString(),
    ...extra,
  }, null, 2));
  installCleanupHandlers(lockPath);
  startParentMonitor(lockPath, process.ppid);
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function tryAcquireOwnerLock(lockPath, extra = {}) {
  try {
    await writeOwnerLock(lockPath, extra);
    return { acquired: true };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { acquired: false, lock: await readLock(lockPath) };
  }
}

async function claimStaleOwnerLock(lockPath, staleLock) {
  await fs.rm(lockPath, { force: true });
  await writeOwnerLock(lockPath, {
    replaced_stale_pid: staleLock?.pid || null,
    upgraded_from: "broker-follower",
  });
}

export async function acquireProcessGuard() {
  if (process.env.SUBAGENT_DISABLE_PROCESS_GUARD === "1") {
    return {
      acquired: true,
      shouldStartSchedulers: true,
      disabled: true,
      mode: "disabled",
    };
  }
  await fs.mkdir(getDataDir(), { recursive: true });
  const lockPath = process.env.SUBAGENT_PROCESS_LOCK_PATH || path.join(getDataDir(), "process.lock");
  const first = await tryAcquireOwnerLock(lockPath);
  if (!first.acquired) {
    const lock = first.lock;
    if (lock?.pid && !(await pidExists(lock.pid))) {
      await claimStaleOwnerLock(lockPath, lock);
    } else {
      const brokerFollowerAllowed =
        process.env.SUBAGENT_ALLOW_BROKER_FOLLOWER === "1"
        || process.env.CODEX_MCP_BROKER === "1";
      if (brokerFollowerAllowed) {
        let upgradeTimer = null;
        let upgraded = false;
        return {
          acquired: false,
          shouldStartSchedulers: false,
          mode: "broker-follower",
          lockPath,
          ownerPid: lock?.pid || null,
          ownerPpid: lock?.ppid || null,
          onOwnerAcquired(callback) {
            if (upgradeTimer) return;
            const intervalMs = Number(process.env.SUBAGENT_FOLLOWER_OWNER_CHECK_MS || 30000);
            if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
            upgradeTimer = setInterval(async () => {
              if (upgraded) return;
              const currentLock = await readLock(lockPath);
              if (currentLock?.pid && await pidExists(currentLock.pid)) return;
              try {
                if (currentLock?.pid) {
                  await claimStaleOwnerLock(lockPath, currentLock);
                } else {
                  await fs.rm(lockPath, { force: true });
                  await writeOwnerLock(lockPath, { upgraded_from: "broker-follower" });
                }
                upgraded = true;
                clearInterval(upgradeTimer);
                await callback?.({
                  mode: "owner",
                  lockPath,
                  upgraded_from: "broker-follower",
                  replaced_stale_pid: currentLock?.pid || null,
                });
              } catch (error) {
                if (error.code !== "EEXIST") {
                  console.error(`[wsf-subagent processGuard] follower upgrade failed: ${error.message}`);
                }
              }
            }, intervalMs);
            upgradeTimer.unref?.();
          },
        };
      }
      throw new Error(`mcp-subagent process already running; lock=${lockPath} pid=${lock?.pid || "unknown"}`);
    }
  }
  return {
    acquired: true,
    shouldStartSchedulers: true,
    mode: "owner",
    lockPath,
    parentPid: process.ppid,
  };
}
