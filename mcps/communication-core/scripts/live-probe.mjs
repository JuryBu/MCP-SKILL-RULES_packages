import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLiveFromConfig } from "../src/live-runtime.mjs";
import { AntigravityDeliveryAdapter } from "../src/adapters/antigravity.mjs";
import { AntigravityLsTransport } from "../src/transports/antigravity-ls.mjs";

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const option = process.argv[index];
  if (!["--config", "--state-dir", "--request", "--result", "--wait-ms", "--preflight-failure-once"].includes(option) || options[option] !== undefined || !process.argv[index + 1]) throw new Error("需要明确且唯一的配置、状态、请求与结果参数");
  options[option] = process.argv[index + 1];
}
for (const required of ["--config", "--state-dir", "--request", "--result"]) if (!options[required]) throw new Error("缺少明确路径参数");
const waitMs = Number(options["--wait-ms"] ?? 40000);
if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 45000) throw new Error("等待期限必须在0到45000毫秒之间");
const config = JSON.parse((await readFile(resolve(options["--config"]), "utf8")).replace(/^\uFEFF/, ""));
const request = JSON.parse((await readFile(resolve(options["--request"]), "utf8")).replace(/^\uFEFF/, ""));
const principal = config.principals.find(item => item.id === request.principal_id);
if (!principal || !request.input) throw new Error("请求没有匹配的明确调用者");
let runtime;
let client;
const result = { mode: "live_test", started_at: new Date().toISOString(), phase: "starting" };
try {
  const factories = {};
  if (options["--preflight-failure-once"] !== undefined) {
    if (options["--preflight-failure-once"] !== "true") throw new Error("故障注入选项必须显式true");
    result.preflight = { failures: 0, submissions: 0 };
    factories.antigravity = () => {
      const transport = new AntigravityLsTransport();
      const adapter = new AntigravityDeliveryAdapter({ transport: {
        describe: async (...args) => { if (!result.preflight.failures) { result.preflight.failures += 1; throw new Error("controlled_preflight_failure"); } return transport.describe(...args); },
        call: (...args) => { result.preflight.submissions += 1; return transport.call(...args); },
        readSteps: (...args) => transport.readSteps(...args),
      } });
      adapter.close = () => transport.close();
      return adapter;
    };
  }
  runtime = await startLiveFromConfig({ configPath: resolve(options["--config"]), stateDir: resolve(options["--state-dir"]), factories });
  client = new Client({ name: "communication-core-live-probe", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(runtime.url), { requestInit: { headers: { Authorization: `Bearer ${principal.token}` } } }));
  async function call(name, input) {
    const response = await client.callTool({ name, arguments: input }, undefined, { timeout: 55000 });
    if (response.isError) throw new Error("核心工具调用失败");
    return response.structuredContent;
  }
  const resolved = await call("communication_resolve_target", { caller: principal.identity, binding_id: request.input.target.binding_id });
  const sent = await call("communication_send_message", request.input);
  result.message_id = sent.message.message_id;
  result.delivery_id = sent.delivery.delivery_id;
  result.duplicate = sent.duplicate;
  result.target = resolved.target ?? resolved;
  result.phase = "persisted";
  await writeFile(resolve(options["--result"]), JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 });
  const waited = await call("communication_wait", { caller: principal.identity, message_id: result.message_id, until: "reply", wait_ms: waitMs });
  const snapshot = await call("communication_get_message", { caller: principal.identity, message_id: result.message_id });
  result.phase = waited.matched ? "reply_observed" : "waiting";
  result.wait = waited;
  result.snapshot = snapshot;
} catch (error) {
  result.phase = "failed";
  result.error = { code: typeof error.code === "string" ? error.code : "live_probe_failed" };
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  await runtime?.close().catch(() => { result.close_failed = true; process.exitCode = 1; });
  result.finished_at = new Date().toISOString();
  await writeFile(resolve(options["--result"]), JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ phase: result.phase, message_id: result.message_id, delivery_id: result.delivery_id, duplicate: result.duplicate, matched: result.wait?.matched, close_failed: result.close_failed ?? false })}\n`);
