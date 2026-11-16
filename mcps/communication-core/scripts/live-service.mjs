import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLiveFromConfig } from "../src/live-runtime.mjs";
import { prepareServiceEndpoint } from "../src/runtime-lease.mjs";

export async function startLiveService(options, { startRuntime = startLiveFromConfig, probes } = {}) {
  const endpoint = await prepareServiceEndpoint({ ...options, probes });
  let runtime;
  try {
    runtime = await startRuntime(options);
    await endpoint.publish(runtime.url);
  } catch (error) {
    await runtime?.close();
    await endpoint.close();
    throw error;
  }
  let closing;
  return {
    url: runtime.url,
    close() {
      if (!closing) closing = Promise.resolve().then(async () => {
        await runtime.close();
        await endpoint.close();
      });
      return closing;
    },
  };
}

async function run() {
  let service;
  let startup;
  let closing;
  let stopping = false;
  const disconnect = () => { if (process.connected) process.disconnect(); };
  const close = () => {
    if (closing) return closing;
    stopping = true;
    closing = Promise.resolve().then(async () => {
      await startup?.catch(() => {});
      await service?.close();
      disconnect();
    });
    return closing;
  };
  const stop = () => { void close().catch(() => { process.exitCode = 1; disconnect(); }); };
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 1) {
      const option = process.argv[index];
      if (option === "--recover-terminated") {
        if (options.recoverTerminated) throw new Error();
        options.recoverTerminated = true;
      } else {
        const field = { "--config": "configPath", "--state-dir": "stateDir", "--endpoint-file": "endpointFile" }[option];
        const value = process.argv[++index];
        if (!field || options[field] || !value || value.startsWith("--")) throw new Error();
        options[field] = resolve(value);
      }
    }
    if (!options.configPath || !options.stateDir || !options.endpointFile) throw new Error();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.on("message", message => { if (message === "shutdown") stop(); });
    startup = startLiveService(options);
    service = await startup;
    if (stopping) { await close(); return; }
    process.stdout.write(`${JSON.stringify({ event: "listening", url: service.url, pid: process.pid })}\n`);
  } catch {
    process.stderr.write("真实测试服务启动失败，现有配置和状态保留\n");
    process.exitCode = 1;
    disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
