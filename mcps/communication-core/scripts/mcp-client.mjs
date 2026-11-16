import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const option = process.argv[index];
  if (!["--connection", "--request", "--result", "--wait-ms", "--until"].includes(option) || options[option] || !process.argv[index + 1]) throw new Error("需要明确连接、请求和结果路径");
  options[option] = process.argv[index + 1];
}
for (const required of ["--connection", "--request", "--result"]) if (!options[required]) throw new Error("缺少明确路径");
const waitMs = Number(options["--wait-ms"] ?? 0);
if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 45000) throw new Error("等待期限必须在0到45000毫秒之间");
const until = options["--until"] ?? "reply";
if (!["reply", "delivery", "processing"].includes(until)) throw new Error("等待对象无效");
const connection = JSON.parse((await readFile(resolve(options["--connection"]), "utf8")).replace(/^\uFEFF/, ""));
const endpoint = JSON.parse((await readFile(resolve(connection.endpoint_file), "utf8")).replace(/^\uFEFF/, ""));
if (endpoint.state !== "listening") throw new Error("原服务尚未监听，请核原进程状态");
const url = new URL(endpoint.url);
if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) throw new Error("只允许已登记的本机回环服务");
const request = JSON.parse((await readFile(resolve(options["--request"]), "utf8")).replace(/^\uFEFF/, ""));
const client = new Client({ name: "communication-core-scoped-client", version: "0.1.0" });
const result = { started_at: new Date().toISOString(), phase: "connecting" };
try {
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } }));
  async function call(name, input) {
    const response = await client.callTool({ name, arguments: input }, undefined, { timeout: 55000 });
    if (response.isError) throw new Error("核心拒绝本次调用，请查询原请求");
    return response.structuredContent;
  }
  const sent = await call("communication_send_message", request.input);
  result.message_id = sent.message.message_id;
  result.delivery_id = sent.delivery.delivery_id;
  result.duplicate = sent.duplicate;
  result.phase = "persisted";
  await writeFile(resolve(options["--result"]), JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 });
  if (waitMs) result.wait = await call("communication_wait", { caller: request.input.caller, message_id: result.message_id, until, wait_ms: waitMs });
  result.snapshot = await call("communication_get_message", { caller: request.input.caller, message_id: result.message_id });
  result.phase = result.wait?.matched ? until === "reply" ? "reply_observed" : "delivery_observed" : "persisted";
} catch {
  result.phase = "failed";
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  result.finished_at = new Date().toISOString();
  await writeFile(resolve(options["--result"]), JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ phase: result.phase, message_id: result.message_id, delivery_id: result.delivery_id, duplicate: result.duplicate, delivery_status: result.snapshot?.delivery?.status, reply: result.wait?.events?.filter(event => event.kind === "reply").map(event => event.data.text) })}\n`);
