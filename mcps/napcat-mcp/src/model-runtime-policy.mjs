import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const fields = Object.freeze({
  incrementalWs: "CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS",
  incrementalImages: "CODEX_MODEL_STREAM_PROXY_INCREMENTAL_IMAGES",
  maxWsSessions: "CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSIONS",
  uploadAllowanceMsPerMiB: "CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB",
  maxUploadAllowanceMs: "CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS",
});

export function readModelRuntimeEnvironment({ stateRoot, corePath, environment = process.env }) {
  const effective = { ...environment };
  const coreHash = crypto.createHash("sha256").update(fs.readFileSync(corePath)).digest("hex");
  const versionedFilename = path.join(stateRoot, `codex-model-runtime-policy-${coreHash}.json`);
  let filename = versionedFilename;
  try {
    fs.lstatSync(versionedFilename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    filename = path.join(stateRoot, "codex-model-runtime-policy.json");
  }
  let bytes;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("MODEL_RUNTIME_POLICY_FILE_INVALID");
    bytes = fs.readFileSync(filename);
  } catch (error) {
    if (error.code === "ENOENT" && filename !== versionedFilename) return effective;
    throw error;
  }
  const policy = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  if (!policy || Array.isArray(policy) || policy.schemaVersion !== 1
    || !/^[a-f0-9]{64}$/u.test(policy.sourceCoreSha256 ?? "")
    || Object.keys(policy).some(key => !["schemaVersion", "sourceCoreSha256", ...Object.keys(fields)].includes(key))) {
    throw new Error("MODEL_RUNTIME_POLICY_INVALID");
  }
  for (const field of ["incrementalWs", "incrementalImages"]) {
    if (policy[field] !== undefined && typeof policy[field] !== "boolean") throw new Error("MODEL_RUNTIME_POLICY_INVALID");
  }
  for (const field of ["uploadAllowanceMsPerMiB", "maxUploadAllowanceMs"]) {
    if (policy[field] !== undefined && (!Number.isSafeInteger(policy[field]) || policy[field] < 0)) {
      throw new Error("MODEL_RUNTIME_POLICY_INVALID");
    }
  }
  if (policy.maxWsSessions !== undefined && (!Number.isSafeInteger(policy.maxWsSessions)
    || policy.maxWsSessions < 1 || policy.maxWsSessions > 128)) throw new Error("MODEL_RUNTIME_POLICY_INVALID");
  if (coreHash !== policy.sourceCoreSha256) {
    if (filename === versionedFilename) throw new Error("MODEL_RUNTIME_POLICY_CORE_MISMATCH");
    return effective;
  }
  for (const [field, name] of Object.entries(fields)) {
    if (policy[field] !== undefined) effective[name] = String(typeof policy[field] === "boolean" ? Number(policy[field]) : policy[field]);
  }
  return effective;
}
