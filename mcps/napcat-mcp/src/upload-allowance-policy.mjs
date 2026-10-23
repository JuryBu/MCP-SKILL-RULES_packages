import fs from "node:fs";
import path from "node:path";
import { DEFAULT_UPLOAD_ALLOWANCE_MS_PER_MIB, MAX_UPLOAD_ALLOWANCE_MS } from "./request-wait-budget.mjs";

export function readUploadAllowancePolicy(stateRoot, environment = process.env) {
  const policyPath = path.join(stateRoot, "codex-model-upload-policy.json");
  let policy = {};
  try {
    const stat = fs.lstatSync(policyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("UPLOAD_POLICY_FILE_INVALID");
    policy = JSON.parse(fs.readFileSync(policyPath, "utf8").replace(/^\uFEFF/u, ""));
    if (!policy || Array.isArray(policy) || policy.schemaVersion !== 1
      || Object.keys(policy).some(key => !["schemaVersion", "uploadAllowanceMsPerMiB", "maxUploadAllowanceMs"].includes(key))) {
      throw new Error("UPLOAD_POLICY_INVALID");
    }
    for (const key of ["uploadAllowanceMsPerMiB", "maxUploadAllowanceMs"]) {
      if (policy[key] !== undefined && !Number.isSafeInteger(policy[key])) throw new Error("UPLOAD_POLICY_INVALID");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const integer = (name, fallback, maximum) => {
    const raw = environment[name] ?? fallback;
    const value = Number(raw);
    if ((typeof raw === "string" && !/^\d+$/u.test(raw))
      || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${name}_INVALID`);
    return value;
  };
  const uploadAllowanceMsPerMiB = integer("CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB",
    policy.uploadAllowanceMsPerMiB ?? DEFAULT_UPLOAD_ALLOWANCE_MS_PER_MIB, 60_000);
  const maxUploadAllowanceMs = integer("CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS",
    policy.maxUploadAllowanceMs ?? Math.min(MAX_UPLOAD_ALLOWANCE_MS, 128 * uploadAllowanceMsPerMiB), MAX_UPLOAD_ALLOWANCE_MS);
  return { uploadAllowanceMsPerMiB, maxUploadAllowanceMs };
}
