import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { CoreError, assertExactKeys, normalizeIdentity, normalizeTarget, requireInteger, requireText } from "./contracts.mjs";
import { createMcpHttpServer } from "./mcp-server.mjs";

const USAGE = "用法：node src/cli.mjs --config <隔离配置.json> --state-dir <独立状态目录>\n仅支持显式 adapter_mode: mock 的本机隔离服务。\n--help 显示帮助；stdin 输入 shutdown 后正常退出。\n";

export function parseCliArguments(argumentsList) {
  if (argumentsList.length === 1 && ["--help", "-h"].includes(argumentsList[0])) return { help: true };
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--config", "--state-dir"].includes(flag) || values[flag] !== undefined || typeof value !== "string" || !value.trim() || value.startsWith("--")) {
      throw new CoreError("invalid_input", "需要明确且不重复的配置与状态目录参数");
    }
    values[flag] = value;
  }
  if (!values["--config"] || !values["--state-dir"]) throw new CoreError("invalid_input", "缺少配置或独立状态目录");
  return { configPath: resolve(values["--config"]), stateDir: resolve(values["--state-dir"]) };
}

async function readConfiguration(configPath) {
  const information = await stat(configPath);
  if (!information.isFile() || information.size > 1048576) throw new CoreError("invalid_config", "隔离配置大小无效");
  const configuration = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
  assertExactKeys(configuration, ["adapter_mode", "host", "port", "principals", "targets"], "隔离配置");
  if (configuration.adapter_mode !== "mock") throw new CoreError("invalid_config", "本版本只支持显式mock隔离模式");
  const host = configuration.host ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost"].includes(host)) throw new CoreError("invalid_config", "隔离服务只允许本机回环地址");
  const port = requireInteger(configuration.port ?? 0, "port", 0, 65535);
  if (!Array.isArray(configuration.targets) || !configuration.targets.length || configuration.targets.length > 256) throw new CoreError("invalid_config", "需要有界的模拟目标列表");
  if (!Array.isArray(configuration.principals) || !configuration.principals.length || configuration.principals.length > 256) throw new CoreError("invalid_config", "需要有界的连接授权列表");
  const targets = configuration.targets.map(target => {
    assertExactKeys(target, ["machine_id", "host", "surface", "conversation_id", "binding_id", "binding_generation", "adapter_id", "capabilities", "evidence"], "模拟目标");
    return normalizeTarget(target);
  });
  const bindingIds = new Set(targets.map(target => target.binding_id));
  if (bindingIds.size !== targets.length) throw new CoreError("invalid_config", "目标绑定ID重复");
  const principalIds = new Set();
  const tokens = new Set();
  const principals = configuration.principals.map(principal => {
    assertExactKeys(principal, ["id", "token", "identity", "allowed_targets", "origin_kinds", "channel_component"], "连接授权");
    const id = requireText(principal.id, "principal.id", 128);
    const token = requireText(principal.token, "principal.token", 4096);
    if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || principalIds.has(id) || tokens.has(token)) throw new CoreError("invalid_config", "连接授权ID或令牌无效或重复");
    principalIds.add(id);
    tokens.add(token);
    const allowedTargets = principal.allowed_targets;
    const originKinds = principal.origin_kinds ?? ["agent_message"];
    if (!Array.isArray(allowedTargets) || allowedTargets.length > 256 || new Set(allowedTargets).size !== allowedTargets.length || allowedTargets.some(binding => !bindingIds.has(binding))) throw new CoreError("invalid_config", "目标授权列表无效");
    if (!Array.isArray(originKinds) || !originKinds.length || originKinds.length > 32) throw new CoreError("invalid_config", "来源授权列表无效");
    return {
      id,
      token,
      identity: normalizeIdentity(principal.identity),
      allowed_targets: allowedTargets,
      origin_kinds: originKinds.map(kind => requireText(kind, "origin_kind", 64)),
      ...(principal.channel_component === undefined ? {} : { channel_component: requireText(principal.channel_component, "channel_component", 64) }),
    };
  });
  return { host, port, principals, targets };
}

export async function startFromConfig({ configPath, stateDir, onError = () => {} }) {
  const configuration = await readConfiguration(configPath);
  const { MessageStore } = await import("./store.mjs");
  const { CommunicationCore } = await import("./core.mjs");
  const { MockAdapter } = await import("./adapters/mock.mjs");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let store;
  let core;
  let http;
  let adapters = {};
  let timer;
  let dispatchPromise = Promise.resolve();
  let closePromise;
  let closing = false;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(timer);
    closePromise = (async () => {
      let failed = false;
      for (const cleanup of [() => core?.close(), () => http?.close(), () => dispatchPromise, ...Object.values(adapters).map(adapter => () => adapter.close?.()), () => store?.close()]) {
        try { await cleanup(); } catch { failed = true; }
      }
      if (failed) throw new CoreError("shutdown_failed", "隔离服务退出清理失败");
    })();
    return closePromise;
  };
  const schedule = () => {
    if (closing) return;
    timer = setTimeout(() => {
      if (closing) return;
      dispatchPromise = Promise.resolve().then(() => core.dispatchPending()).catch(() => {
        onError("隔离投递调度异常，正在关闭服务\n");
        void close().catch(() => onError("隔离服务退出清理失败\n"));
      }).finally(schedule);
    }, 250);
    timer.unref();
  };
  try {
    store = new MessageStore({ filePath: join(stateDir, "core.sqlite") });
    adapters = Object.fromEntries([...new Set(configuration.targets.map(target => target.adapter_id))].map(adapterId => [adapterId, new MockAdapter()]));
    core = new CommunicationCore({ store, targets: configuration.targets, principals: configuration.principals, adapters });
    await core.start();
    http = await createMcpHttpServer({ core, principals: configuration.principals, host: configuration.host, port: configuration.port });
    schedule();
    return { url: http.url, address: http.address, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

export async function runCli(argumentsList, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseCliArguments(argumentsList);
  } catch {
    stderr.write(USAGE);
    return 1;
  }
  if (options.help) { stdout.write(USAGE); return 0; }
  let service;
  let input;
  let shutdownPromise;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (input) {
      input.close();
      process.stdin.pause();
      process.stdin.destroy();
    }
    shutdownPromise = Promise.resolve().then(() => service?.close()).catch(() => {
      process.exitCode = 1;
      stderr.write("隔离服务退出清理失败\n");
    });
    return shutdownPromise;
  };
  const stop = () => { void shutdown(); };
  try {
    service = await startFromConfig({ ...options, onError: message => { process.exitCode = 1; stderr.write(message); stop(); } });
  } catch {
    stderr.write("隔离服务启动失败，请核对显式配置、状态目录和本机依赖\n");
    return 1;
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (!process.stdin.isTTY) {
    input = createInterface({ input: process.stdin, terminal: false });
    input.on("line", line => { if (line.trim() === "shutdown") stop(); });
    input.on("error", stop);
  }
  stdout.write(`${JSON.stringify({ event: "listening", url: service.url })}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
