import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseOuterRuntimeArguments(argv) {
  const names = new Set(["runtime-state", "token-file", "action", "instance", "candidate", "sha256", "revision", "receipt", "receipt-out"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.slice(2);
    if (!argv[index]?.startsWith("--") || !names.has(name) || !argv[index + 1]
      || argv[index + 1].startsWith("--") || Object.hasOwn(values, name)) throw new Error("INVALID_OUTER_RUNTIME_ARGUMENT");
    values[name] = argv[index + 1];
  }
  if (!["status", "prepare", "activate", "restore"].includes(values.action)
    || !values["runtime-state"] || !values["token-file"]) throw new Error("OUTER_RUNTIME_ARGUMENT_REQUIRED");
  if (values.action === "prepare" && (!values.candidate || !/^[a-f0-9]{64}$/.test(values.sha256 ?? ""))) throw new Error("OUTER_RUNTIME_CANDIDATE_REQUIRED");
  if (values.action === "activate" && !values.receipt) throw new Error("OUTER_RUNTIME_RECEIPT_REQUIRED");
  if (values.revision !== undefined && (!/^\d+$/.test(values.revision) || !Number.isSafeInteger(Number(values.revision)))) throw new Error("INVALID_OUTER_RUNTIME_REVISION");
  if (values["receipt-out"] && values.action !== "prepare") throw new Error("OUTER_RUNTIME_RECEIPT_OUTPUT_REQUIRES_PREPARE");
  return values;
}

const readJson = filePath => JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));

export async function runOuterRuntimeCommand(values) {
  const runtime = readJson(values["runtime-state"]);
  const url = new URL(runtime.controlUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !url.port) throw new Error("OUTER_RUNTIME_CONTROL_REQUIRES_LOOPBACK");
  const token = fs.readFileSync(values["token-file"], "utf8").trim();
  if (!token) throw new Error("OUTER_RUNTIME_TOKEN_REQUIRED");
  if (values["receipt-out"] && fs.existsSync(path.resolve(values["receipt-out"]))) throw new Error("OUTER_RUNTIME_RECEIPT_OUTPUT_EXISTS");
  const request = async (route, input) => {
    try {
      const response = await fetch(`${url.origin}/v1/outer-runtime${route}`, {
        method: input ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${token}`, ...(input ? { "content-type": "application/json" } : {}) },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      return { ...await response.json(), httpStatus: response.status };
    } catch (error) {
      return { ok: false, error: { code: "OUTER_RUNTIME_CONTROL_TRANSPORT_ERROR", message: String(error.message ?? error) },
        operationState: input ? "unknown" : "read_failed" };
    }
  };
  const current = await request("");
  if (!current.ok) return current;
  const instanceId = values.instance ?? runtime.instanceToken;
  if (!instanceId || current.instanceId !== instanceId) return { ok: false, error: { code: "OUTER_RUNTIME_INSTANCE_MISMATCH" }, httpStatus: 409 };
  if (values.action === "status") return current;
  const revision = values.revision === undefined ? current.revision : Number(values.revision);
  let input = { instanceId, revision };
  if (values.action === "prepare") input = { ...input, candidate: values.candidate, sha256: values.sha256 };
  if (values.action === "activate") {
    const saved = readJson(values.receipt);
    input = saved.receipt ?? saved;
    if (input?.instanceId !== instanceId) return { ok: false, error: { code: "OUTER_RUNTIME_INSTANCE_MISMATCH" }, httpStatus: 409 };
    if (values.revision !== undefined && input.revision !== revision) return { ok: false, error: { code: "OUTER_RUNTIME_REVISION_MISMATCH" }, httpStatus: 409 };
  }
  const result = await request(`/${values.action}`, input);
  if (result.ok && values.action === "prepare" && values["receipt-out"]) {
    const receipt = Object.fromEntries(["instanceId", "revision", "preparationId", "version", "sha256"].map(name => [name, result[name]]));
    try {
      fs.writeFileSync(path.resolve(values["receipt-out"]), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      return { ...result, ok: false, operationState: "prepared", receipt,
        error: { code: "OUTER_RUNTIME_RECEIPT_WRITE_FAILED", message: String(error.message ?? error) } };
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => runOuterRuntimeCommand(parseOuterRuntimeArguments(process.argv.slice(2)))).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  }).catch(error => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: String(error.message ?? error) } })}\n`);
    process.exitCode = 1;
  });
}
