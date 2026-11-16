import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { CoreError, assertExactKeys } from "./contracts.mjs";

const HASH = /^[a-f0-9]{64}$/i;

function validHash(value) {
  return typeof value === "string" && value.length === 64 && HASH.test(value);
}

function localModulePath(value) {
  return typeof value === "string" && value.length <= 32768 && isAbsolute(value)
    && value.endsWith(".mjs") && !/[\u0000-\u001f?#]/u.test(value)
    && !/^[\\/]{2}/u.test(value)
    && (process.platform !== "win32" || /^[a-z]:[\\/]/i.test(value));
}

async function loadCheckedModule(configuration) {
  try {
    assertExactKeys(configuration, ["module_path", "sha256"], "Codex来源恢复");
    if (!localModulePath(configuration.module_path) || !validHash(configuration.sha256)) throw new Error();
    const filename = await realpath(configuration.module_path);
    if (!localModulePath(filename)) throw new Error();
    const information = await stat(filename);
    if (!information.isFile() || information.size > 1024 * 1024) throw new Error();
    const bytes = await readFile(filename);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== configuration.sha256.toLowerCase()) throw new Error();
    const address = pathToFileURL(filename);
    address.searchParams.set("sha256", digest);
    const module = await import(address.href);
    return module;
  } catch {
    throw new CoreError("invalid_config", "Codex来源恢复模块配置或校验无效");
  }
}

export async function loadCodexSourceRecovery(configuration) {
  const module = await loadCheckedModule(configuration);
  if (typeof module.ensureCodexCommunication !== "function") throw new CoreError("invalid_config", "Codex来源恢复模块配置或校验无效");
  return module.ensureCodexCommunication;
}

export async function loadCodexStatusSource(configuration) {
  const module = await loadCheckedModule(configuration);
  if (typeof module.readHostStatus !== "function" || typeof module.inspectThread !== "function") throw new CoreError("invalid_config", "Codex状态来源模块配置或校验无效");
  return { readHostStatus: module.readHostStatus, inspectThread: module.inspectThread };
}

function references(value) {
  const result = {};
  for (const [key, maximum] of [["receiptPath", 32768], ["attemptId", 200]]) {
    if (typeof value?.[key] === "string" && value[key].length > 0 && value[key].length <= maximum
      && !/[\u0000-\u001f]/u.test(value[key])) result[key] = value[key];
  }
  return result;
}

function ready(result, endpoint) {
  const binding = result?.binding;
  return result?.ok === true && result.status === "ready" && result.endpoint === endpoint
    && binding && typeof binding === "object" && !Array.isArray(binding)
    && Object.keys(binding).sort().join(",") === "configuration_sha256,instance_id,manifest_sha256"
    && typeof binding.instance_id === "string" && binding.instance_id.length > 0 && binding.instance_id.length <= 80
    && !/[^a-z0-9-]/i.test(binding.instance_id)
    && validHash(binding.manifest_sha256) && validHash(binding.configuration_sha256)
    && (result.instanceId === undefined || result.instanceId === binding.instance_id);
}

function blocked(status, receipt) {
  return new CoreError("codex_control_not_connected", "Codex来源尚未就绪，业务请求尚未发送", {
    request_sent: false, source_recovery: { status, ...receipt },
  });
}

export class CodexSourceRecovery {
  #ensure;
  #endpoint;
  #pending = null;
  #inspectOnly = false;
  #receipt = {};
  #closed = false;

  constructor({ ensure, endpoint }) {
    if (typeof ensure !== "function") throw new CoreError("invalid_config", "Codex来源恢复回调无效");
    this.#ensure = ensure;
    this.#endpoint = endpoint;
  }

  prepare() {
    if (this.#closed) return Promise.reject(blocked("closed", this.#receipt));
    if (!this.#pending) {
      const pending = Promise.resolve().then(() => this.#run()).finally(() => {
        if (this.#pending === pending) this.#pending = null;
      });
      this.#pending = pending;
    }
    return this.#pending;
  }

  async #run() {
    if (this.#closed) throw blocked("closed", this.#receipt);
    let result;
    try {
      result = await this.#ensure({ mode: this.#inspectOnly ? "inspect" : "ensure" });
    } catch (error) {
      this.#receipt = { ...references(error), ...this.#receipt };
      this.#inspectOnly = true;
      throw blocked("unknown", this.#receipt);
    }
    if (ready(result, this.#endpoint)) {
      if (this.#inspectOnly) this.#receipt = { ...references(result), ...this.#receipt };
      return { status: "ready" };
    }
    if (result?.ok === true && result.status === "disabled") return { status: "disabled" };
    this.#receipt = { ...references(result), ...this.#receipt };
    if (!(result?.ok === false && result.status === "unavailable" && result.changed === false
      && result.attached !== true && !Object.keys(references(result)).length)) this.#inspectOnly = true;
    const status = typeof result?.status === "string" && result.status.length > 0 && result.status.length <= 80
      && !/[^a-z_]/u.test(result.status) ? result.status : "unknown";
    throw blocked(status === "ready" ? "ready_mismatch" : status, this.#receipt);
  }

  async close() {
    this.#closed = true;
    await this.#pending?.catch(() => {});
  }
}
