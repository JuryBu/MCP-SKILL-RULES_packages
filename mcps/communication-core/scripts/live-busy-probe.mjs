import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLiveFromConfig } from "../src/live-runtime.mjs";
import { AntigravityLsTransport } from "../src/transports/antigravity-ls.mjs";

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const option = process.argv[index];
  if (!["--config", "--state-dir", "--request", "--result"].includes(option) || options[option] || !process.argv[index + 1]) throw new Error("需要明确配置、状态、忙碌测试请求和结果路径");
  options[option] = resolve(process.argv[index + 1]);
}
for (const required of ["--config", "--state-dir", "--request", "--result"]) if (!options[required]) throw new Error("缺少明确路径");
const configuration = JSON.parse((await readFile(options["--config"], "utf8")).replace(/^\uFEFF/, ""));
const request = JSON.parse((await readFile(options["--request"], "utf8")).replace(/^\uFEFF/, ""));
const principal = configuration.principals.find(item => item.id === request.principal_id);
if (!principal || !request.base || !request.supplement) throw new Error("没有匹配的调用者或两条原请求");
const result = { mode: "live_test", started_at: new Date().toISOString(), phase: "starting" };
let runtime;
let client;
const transport = new AntigravityLsTransport({ timeoutMs: 2500 });
async function save() { await writeFile(options["--result"], JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 }); }
try {
  runtime = await startLiveFromConfig({ configPath: options["--config"], stateDir: options["--state-dir"] });
  client = new Client({ name: "communication-core-busy-probe", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(runtime.url), { requestInit: { headers: { Authorization: `Bearer ${principal.token}` } } }));
  async function call(name, input) {
    const response = await client.callTool({ name, arguments: input }, undefined, { timeout: 55000 });
    if (response.isError) throw new Error("核心测试调用失败");
    return response.structuredContent;
  }
  const before = await transport.describe(request.base.target);
  if (before.status !== "CASCADE_RUN_STATUS_IDLE") throw new Error("专用目标尚未空闲，不开始新测试");
  result.before = before;
  result.base = await call("communication_send_message", request.base);
  result.phase = "base_persisted";
  await save();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const description = await transport.describe(request.base.target);
    const window = await transport.readSteps(request.base.target, { stepOffset: before.step_count });
    result.observations = window.steps;
    const unfinishedTool = window.steps.find(step => !["CORTEX_STEP_TYPE_USER_INPUT", "CORTEX_STEP_TYPE_PLANNER_RESPONSE"].includes(step.type) && step.status !== "CORTEX_STEP_STATUS_DONE");
    if (description.status === "CASCADE_RUN_STATUS_RUNNING" && unfinishedTool) {
      result.busy_observed_at = new Date().toISOString();
      result.busy_step = unfinishedTool;
      result.supplement = await call("communication_send_message", request.supplement);
      result.phase = "supplement_persisted_while_tool_running";
      await save();
      break;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  if (!result.supplement) throw new Error("没有取得可核对的在途工具，不发送补充");
  result.wait = await call("communication_wait", { caller: principal.identity, message_id: result.supplement.message.message_id, until: "reply", wait_ms: 45000 });
  result.phase = result.wait.matched ? "reply_observed" : "waiting";
  result.after = await transport.describe(request.base.target);
  result.native_steps = (await transport.readSteps(request.base.target, { stepOffset: before.step_count })).steps;
  result.base_snapshot = await call("communication_get_message", { caller: principal.identity, message_id: result.base.message.message_id });
  result.supplement_snapshot = await call("communication_get_message", { caller: principal.identity, message_id: result.supplement.message.message_id });
} catch (error) {
  result.phase = "failed";
  result.error = { code: typeof error.code === "string" ? error.code : "busy_probe_failed", message: error.message?.startsWith("没有取得") || error.message?.startsWith("专用目标") ? error.message : "忙碌测试尚未取得完整结果" };
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  await runtime?.close().catch(() => { result.close_failed = true; process.exitCode = 1; });
  await transport.close();
  result.finished_at = new Date().toISOString();
  await save();
}
process.stdout.write(`${JSON.stringify({ phase: result.phase, base_message_id: result.base?.message.message_id, supplement_message_id: result.supplement?.message.message_id, busy_observed: Boolean(result.busy_step), matched: result.wait?.matched, close_failed: result.close_failed ?? false })}\n`);
