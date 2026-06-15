import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./registry.js";

let lockHandle = null;

async function pidExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  try {
    lockHandle = await fs.open(lockPath, "wx");
    await lockHandle.writeFile(JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      created_at: new Date().toISOString(),
    }, null, 2));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let lock = null;
    try {
      lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    } catch {}
    if (lock?.pid && !(await pidExists(lock.pid))) {
      await fs.rm(lockPath, { force: true });
      lockHandle = await fs.open(lockPath, "wx");
      await lockHandle.writeFile(JSON.stringify({
        pid: process.pid,
        ppid: process.ppid,
        created_at: new Date().toISOString(),
        replaced_stale_pid: lock.pid,
      }, null, 2));
    } else {
      const brokerFollowerAllowed =
        process.env.SUBAGENT_ALLOW_BROKER_FOLLOWER === "1"
        || process.env.CODEX_MCP_BROKER === "1";
      if (brokerFollowerAllowed) {
        return {
          acquired: false,
          shouldStartSchedulers: false,
          mode: "broker-follower",
          lockPath,
          ownerPid: lock?.pid || null,
          ownerPpid: lock?.ppid || null,
        };
      }
      throw new Error(`mcp-subagent process already running; lock=${lockPath} pid=${lock?.pid || "unknown"}`);
    }
  }

  const cleanup = async () => {
    try {
      await lockHandle?.close();
    } catch {}
    await fs.rm(lockPath, { force: true });
  };
  process.once("exit", () => {
    try {
      fs.rm(lockPath, { force: true });
    } catch {}
  });
  process.once("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });

  const parentPid = process.ppid;
  const interval = setInterval(async () => {
    if (parentPid && !(await pidExists(parentPid))) {
      await cleanup();
      process.exit(0);
    }
  }, 30000);
  interval.unref?.();
  return {
    acquired: true,
    shouldStartSchedulers: true,
    mode: "owner",
    lockPath,
    parentPid,
  };
}
