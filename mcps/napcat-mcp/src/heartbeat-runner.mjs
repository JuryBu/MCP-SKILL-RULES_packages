import fs from "node:fs";
import path from "node:path";
import { createNapCatNotifier } from "./core.mjs";
import {
  loadHeartbeatConfig,
  runHeartbeatAttempt,
  writeHeartbeatRuntimeState,
} from "./heartbeat.mjs";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--once") {
      values.once = true;
      continue;
    }
    if (!item.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`无效参数：${item}`);
    }
    values[item.slice(2)] = argv[index + 1];
    index += 1;
  }
  for (const required of ["config", "private-env", "binding", "state", "runtime-state", "log", "stop-file"]) {
    if (!values[required]) throw new Error(`缺少参数 --${required}`);
  }
  return values;
}

function readPrivateEnvironment(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  return {
    NAPCAT_HTTP_URL: String(raw.NAPCAT_HTTP_URL ?? ""),
    NAPCAT_ACCESS_TOKEN: String(raw.NAPCAT_ACCESS_TOKEN ?? ""),
    NAPCAT_HTTP_TIMEOUT_MS: String(raw.NAPCAT_HTTP_TIMEOUT_MS ?? "10000"),
  };
}

function wait(milliseconds, stopFilePath) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(stopFilePath) || Date.now() - startedAt >= milliseconds) {
        clearInterval(timer);
        resolve();
      }
    }, Math.min(1000, milliseconds));
  });
}

const args = parseArguments(process.argv.slice(2));
const paths = Object.fromEntries(
  Object.entries(args)
    .filter(([key]) => key !== "once")
    .map(([key, value]) => [key, path.resolve(value)]),
);
const privateEnvironment = readPrivateEnvironment(paths["private-env"]);
const notifier = createNapCatNotifier({
  cwd: path.dirname(paths.binding),
  env: {
    ...process.env,
    ...privateEnvironment,
    NAPCAT_MCP_BINDING_PATH: paths.binding,
    NAPCAT_MCP_STATE_PATH: paths.state,
  },
});
const startedAt = new Date().toISOString();

writeHeartbeatRuntimeState(paths["runtime-state"], {
  status: "running",
  pid: process.pid,
  startedAt,
  command: "heartbeat-runner.mjs",
  stopFilePath: paths["stop-file"],
});

let fatalError = null;
try {
  while (!fs.existsSync(paths["stop-file"])) {
    const attempt = await runHeartbeatAttempt({
      notifier,
      configPath: paths.config,
      runtimeStatePath: paths["runtime-state"],
      logPath: paths.log,
      pid: process.pid,
    });
    if (args.once) break;
    await wait(attempt.config.intervalMinutes * 60000, paths["stop-file"]);
  }
} catch (error) {
  fatalError = error;
  writeHeartbeatRuntimeState(paths["runtime-state"], {
    status: "failed",
    stoppedAt: new Date().toISOString(),
    fatalError: { code: error?.code ?? "HEARTBEAT_FATAL", message: error?.message ?? String(error) },
  });
  process.exitCode = 1;
} finally {
  if (!fatalError) {
    const finalConfig = loadHeartbeatConfig(paths.config);
    writeHeartbeatRuntimeState(paths["runtime-state"], {
      status: "stopped",
      taskId: finalConfig.taskId,
      runId: finalConfig.runId,
      stoppedAt: new Date().toISOString(),
      stopReason: args.once ? "once_completed" : "stop_file",
    });
  }
}
