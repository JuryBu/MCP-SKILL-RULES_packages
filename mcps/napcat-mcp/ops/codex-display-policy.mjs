import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseDisplayPolicyArguments(argv) {
  const names = new Set(["runtime-state", "token-file", "action", "instance", "root-id", "candidate", "sha256", "revision", "receipt", "receipt-out"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.slice(2);
    if (!argv[index]?.startsWith("--") || !names.has(name) || !argv[index + 1]
      || argv[index + 1].startsWith("--") || Object.hasOwn(values, name)) throw new Error("INVALID_DISPLAY_POLICY_ARGUMENT");
    values[name] = argv[index + 1];
  }
  if (!["status", "prepare", "activate", "restore", "discard"].includes(values.action)
    || !values["runtime-state"] || !values["token-file"]) throw new Error("DISPLAY_POLICY_ARGUMENT_REQUIRED");
  if (values.action === "prepare" && (!values.candidate || !values.sha256 || !values["root-id"])) throw new Error("DISPLAY_POLICY_CANDIDATE_REQUIRED");
  if (["activate", "discard"].includes(values.action) && !values.receipt) throw new Error("DISPLAY_POLICY_RECEIPT_REQUIRED");
  if (values.revision !== undefined && !/^\d+$/.test(values.revision)) throw new Error("INVALID_DISPLAY_POLICY_REVISION");
  return values;
}

export async function runDisplayPolicyCommand(values) {
  const runtime = JSON.parse(fs.readFileSync(values["runtime-state"], "utf8").replace(/^\uFEFF/, ""));
  const url = new URL(runtime.controlUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !url.port) throw new Error("DISPLAY_POLICY_CONTROL_REQUIRES_LOOPBACK");
  const token = fs.readFileSync(values["token-file"], "utf8").trim();
  if (!token) throw new Error("DISPLAY_POLICY_TOKEN_REQUIRED");
  const request = async (route, input) => {
    const response = await fetch(`${url.origin}/v1/display-policy${route}`, {
      method: input ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}`, ...(input ? { "content-type": "application/json" } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { ...await response.json(), httpStatus: response.status };
  };
  const current = await request("");
  if (!current.ok) return current;
  const instanceId = values.instance ?? runtime.instanceToken;
  if (!instanceId || current.instanceId !== instanceId) return { ok: false, error: { code: "DISPLAY_POLICY_INSTANCE_MISMATCH" }, httpStatus: 409 };
  if (values.action === "status") return current;
  const expectedRevision = values.revision === undefined ? current.revision : Number(values.revision);
  let input = { instanceId, rootId: values["root-id"] ?? current.rootId, expectedRevision };
  if (values.action === "prepare") input = { ...input, candidate: values.candidate, sha256: values.sha256 };
  if (["activate", "discard"].includes(values.action)) {
    const saved = JSON.parse(fs.readFileSync(values.receipt, "utf8").replace(/^\uFEFF/, ""));
    input = saved.receipt ?? saved;
    if (input.instanceId !== instanceId) return { ok: false, error: { code: "DISPLAY_POLICY_INSTANCE_MISMATCH" }, httpStatus: 409 };
  }
  const result = await request(`/${values.action}`, input);
  if (result.ok && result.receipt && values["receipt-out"]) {
    fs.writeFileSync(path.resolve(values["receipt-out"]), `${JSON.stringify(result.receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => runDisplayPolicyCommand(parseDisplayPolicyArguments(process.argv.slice(2)))).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  }).catch(error => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: String(error.message ?? error) } })}\n`);
    process.exitCode = 1;
  });
}
