import { execFileSync as nativeExecFileSync, spawn as nativeSpawn, spawnSync as nativeSpawnSync } from "node:child_process";
import path from "node:path";
import { windowsPowerShellEnvironment } from "../../src/windows-powershell-environment.mjs";

function processOptions(executable, options = {}) {
  if (process.platform !== "win32" || path.win32.basename(String(executable)).toLowerCase() !== "powershell.exe") return options;
  return { ...options, env: windowsPowerShellEnvironment(options.env ?? process.env).environment };
}

export function spawn(executable, argumentsList, options) {
  return nativeSpawn(executable, argumentsList, processOptions(executable, options));
}

export function spawnSync(executable, argumentsList, options) {
  return nativeSpawnSync(executable, argumentsList, processOptions(executable, options));
}

export function execFileSync(executable, argumentsList, options) {
  return nativeExecFileSync(executable, argumentsList, processOptions(executable, options));
}
