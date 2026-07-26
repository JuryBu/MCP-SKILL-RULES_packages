import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function processIsAlive(pid, processKill = process.kill.bind(process)) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    processKill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function removeStopFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function createTaskRouterController(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const environment = options.env ?? process.env;
  const spawnProcess = options.spawnProcess ?? spawn;
  const processKill = options.processKill ?? process.kill.bind(process);
  const nodePath = options.nodePath ?? process.execPath;
  const runnerPath = path.resolve(options.runnerPath ?? path.join(rootDir, "src", "task-router-runner.mjs"));
  const stateDir = path.resolve(options.stateDir ?? path.join(rootDir, "state"));
  const paths = {
    registry: path.resolve(environment.NAPCAT_TASK_REGISTRY_PATH ?? path.join(stateDir, "task-registry.json")),
    binding: path.resolve(environment.NAPCAT_MCP_BINDING_PATH ?? path.join(rootDir, "binding.json")),
    state: path.resolve(environment.NAPCAT_MCP_STATE_PATH ?? path.join(stateDir, "dedupe.json")),
    runtimeState: path.resolve(environment.NAPCAT_TASK_ROUTER_RUNTIME_PATH ?? path.join(stateDir, "task-router-runtime.json")),
    log: path.resolve(environment.NAPCAT_TASK_ROUTER_LOG_PATH ?? path.join(stateDir, "task-router.jsonl")),
    stopFile: path.resolve(environment.NAPCAT_TASK_ROUTER_STOP_PATH ?? path.join(stateDir, "task-router.stop")),
    lock: path.resolve(environment.NAPCAT_TASK_ROUTER_LOCK_PATH ?? path.join(stateDir, "task-router.lock")),
  };
  const intervalMs = Math.max(1000, Number(environment.NAPCAT_TASK_ROUTER_INTERVAL_MS ?? 30000));

  function status() {
    const runtime = readJson(paths.runtimeState);
    const lock = readJson(paths.lock);
    const alive = processIsAlive(runtime?.pid, processKill)
      && Number(lock?.pid) === Number(runtime?.pid)
      && Boolean(lock?.startedAt)
      && lock.startedAt === runtime?.startedAt;
    return {
      enabled: environment.NAPCAT_TASK_ROUTER_AUTOSTART !== "0",
      alive,
      state: alive ? (runtime?.state ?? "running") : "stopped",
      runtime,
      lock,
      paths,
      intervalMs,
    };
  }

  function ensureStarted() {
    if (environment.NAPCAT_TASK_ROUTER_AUTOSTART === "0") {
      return { started: false, reason: "autostart_disabled", ...status() };
    }
    if (!fs.existsSync(runnerPath)) {
      throw new Error(`找不到 task router runner：${runnerPath}`);
    }
    const current = status();
    if (current.alive) return { started: false, reason: "already_running", ...current };

    fs.mkdirSync(stateDir, { recursive: true });
    removeStopFile(paths.stopFile);
    const argumentsList = [
      runnerPath,
      "--registry", paths.registry,
      "--binding", paths.binding,
      "--state", paths.state,
      "--runtime-state", paths.runtimeState,
      "--log", paths.log,
      "--stop-file", paths.stopFile,
      "--lock", paths.lock,
      "--interval-ms", String(intervalMs),
    ];
    const child = spawnProcess(nodePath, argumentsList, {
      cwd: rootDir,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: environment,
    });
    child.unref?.();
    return {
      started: true,
      pid: child.pid ?? null,
      state: "starting",
      paths,
      intervalMs,
    };
  }

  return { ensureStarted, status, paths };
}
