import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { parseCliArguments } from "../src/cli.mjs";
import { startLiveFromConfig } from "../src/live-runtime.mjs";

const USAGE = "用法：node scripts/live.mjs --config <真实测试配置.json> --state-dir <独立状态目录>\n仅支持显式 adapter_mode: live_test 的本机真实测试服务。\nstdin 输入 shutdown 或发送退出信号后正常关闭。\n";

export async function runLiveCli(argumentsList, { stdout = process.stdout, stderr = process.stderr, factories } = {}) {
  let options;
  try {
    options = parseCliArguments(argumentsList);
    if (options.help) throw new Error();
  } catch {
    stderr.write(USAGE);
    return 1;
  }
  let input;
  let startup;
  let shutdownPromise;
  let stopping = false;
  const releaseInput = () => {
    input?.close();
    process.stdin.pause();
    if (!process.stdin.isTTY) process.stdin.destroy();
  };
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    shutdownPromise = Promise.resolve().then(async () => {
      releaseInput();
      const service = await startup.catch(() => null);
      await service?.close();
    }).catch(() => {
      process.exitCode = 1;
      stderr.write("真实测试服务退出清理失败\n");
    });
    return shutdownPromise;
  };
  const stop = () => { void shutdown(); };
  startup = startLiveFromConfig({ ...options, factories, onError: message => { process.exitCode = 1; stderr.write(message); stop(); } });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let service;
  try {
    service = await startup;
  } catch {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    releaseInput();
    stderr.write("真实测试服务启动失败，请核对显式配置、状态目录和本机依赖\n");
    return 1;
  }
  if (stopping) { await shutdown(); return process.exitCode === 1 ? 1 : 0; }
  if (!process.stdin.isTTY) {
    input = createInterface({ input: process.stdin, terminal: false });
    input.on("line", line => { if (line.trim() === "shutdown") stop(); });
    input.on("error", stop);
    input.on("close", stop);
  }
  stdout.write(`${JSON.stringify({ event: "listening", url: service.url })}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runLiveCli(process.argv.slice(2));
}
