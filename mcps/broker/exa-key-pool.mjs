import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_VERSION = 1;

function parseNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitApiKeys(value) {
  return unique(
    String(value || "")
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function normalizeRemoteUrl(value, fallback) {
  const url = new URL(value || fallback);
  const apiKey = url.searchParams.get("exaApiKey") || "";
  url.searchParams.delete("exaApiKey");
  return { url: url.toString(), apiKey };
}

function emptyEntry() {
  return {
    status: "healthy",
    reason: null,
    openUntil: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
  };
}

export function fingerprintApiKey(apiKey) {
  return crypto.createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 10);
}

export function defaultPoolStatePath(env = process.env) {
  if (env.EXA_MCP_POOL_STATE_PATH) {
    return env.EXA_MCP_POOL_STATE_PATH;
  }
  if (env.CODEX_MCP_BROKER_STATE) {
    return path.join(path.dirname(env.CODEX_MCP_BROKER_STATE), "exa-key-pool-state.json");
  }
  const dataRoot = env.CODEX_TOOLKIT_DATA_ROOT || path.join(os.homedir(), ".codex-toolkit");
  return path.join(dataRoot, "broker", "exa-key-pool-state.json");
}

export function buildExaEndpointConfig(env = process.env) {
  const defaultUrl = "https://mcp.exa.ai/mcp";
  const legacyValue = env.EXA_MCP_REMOTE_URL || env.CODEX_TOOLKIT_EXA_MCP_REMOTE_URL || "";
  const baseValue = env.EXA_MCP_REMOTE_BASE_URL || legacyValue || defaultUrl;
  const normalizedBase = normalizeRemoteUrl(baseValue, defaultUrl);
  const legacy = legacyValue ? normalizeRemoteUrl(legacyValue, defaultUrl) : null;
  const apiKeys = unique([
    legacy?.apiKey || "",
    ...splitApiKeys(env.EXA_MCP_API_KEYS),
  ]);
  const endpoints = apiKeys.map((apiKey, index) => {
    const id = fingerprintApiKey(apiKey);
    return {
      id,
      name: `key-${index + 1}-${id}`,
      url: normalizedBase.url,
      apiKey,
      isPublic: false,
    };
  });

  if (endpoints.length === 0 && legacyValue && !legacy?.apiKey) {
    endpoints.push({
      id: "legacy-public",
      name: "legacy-public",
      url: legacy.url,
      apiKey: "",
      isPublic: true,
    });
  }

  const publicEnabled = String(env.EXA_MCP_PUBLIC_FALLBACK_ENABLED ?? "1") !== "0";
  const publicEndpoint = publicEnabled
    ? {
        id: "public",
        name: "public",
        url: normalizedBase.url,
        apiKey: "",
        isPublic: true,
      }
    : null;

  return {
    endpoints,
    publicEndpoint,
    statePath: defaultPoolStatePath(env),
    cooldownMs: parseNonNegativeNumber(env.EXA_MCP_KEY_COOLDOWN_MS, 24 * 60 * 60 * 1000),
    cooldownJitterMs: parseNonNegativeNumber(env.EXA_MCP_KEY_COOLDOWN_JITTER_MS, 15 * 60 * 1000),
    rateLimitCooldownMs: parseNonNegativeNumber(env.EXA_MCP_RATE_LIMIT_COOLDOWN_MS, 60 * 1000),
  };
}

export function classifyExaFailure(text, status) {
  const detail = String(text || "");
  if (
    status === 402 ||
    /NO_MORE_CREDITS|API_KEY_BUDGET_EXCEEDED|TEAM_BUDGET_EXCEEDED|exceeded your credits limit|error\s*\(402\)/i.test(
      detail,
    )
  ) {
    return { kind: "quota", reason: "NO_MORE_CREDITS" };
  }
  if (status === 429 || /rate limit|too many requests|error\s*\(429\)/i.test(detail)) {
    return { kind: "rate_limit", reason: "RATE_LIMITED" };
  }
  if (status === 401 || /INVALID_API_KEY|unauthorized|error\s*\(401\)/i.test(detail)) {
    return { kind: "auth", reason: "UNAUTHORIZED" };
  }
  if (status === 403 || /ACCESS_DENIED|FEATURE_DISABLED|forbidden|error\s*\(403\)/i.test(detail)) {
    return { kind: "auth", reason: "FORBIDDEN" };
  }
  return null;
}

export function classifyExaToolResult(result) {
  if (!result?.isError) {
    return null;
  }
  const detail = Array.isArray(result.content)
    ? result.content.map((item) => item?.text || "").join("\n")
    : "";
  return classifyExaFailure(detail);
}

export class ExaKeyPool {
  constructor({
    endpoints,
    statePath,
    cooldownMs,
    cooldownJitterMs,
    rateLimitCooldownMs,
    now = () => Date.now(),
    random = () => Math.random(),
    logger = console,
  }) {
    this.endpoints = endpoints;
    this.statePath = statePath;
    this.cooldownMs = cooldownMs;
    this.cooldownJitterMs = cooldownJitterMs;
    this.rateLimitCooldownMs = rateLimitCooldownMs;
    this.now = now;
    this.random = random;
    this.logger = logger;
    this.halfOpenInFlight = new Set();
    this.state = this.loadState();
  }

  loadState() {
    let loaded = {};
    if (this.statePath && fs.existsSync(this.statePath)) {
      try {
        loaded = JSON.parse(fs.readFileSync(this.statePath, "utf8").replace(/^\uFEFF/, ""));
      } catch (error) {
        this.logger.error(`[exa-key-pool] state load failed: ${error.message}`);
      }
    }
    const endpoints = {};
    for (const endpoint of this.endpoints) {
      const existing = loaded?.endpoints?.[endpoint.id];
      endpoints[endpoint.id] = existing && typeof existing === "object"
        ? { ...emptyEntry(), ...existing }
        : emptyEntry();
    }
    return {
      version: STATE_VERSION,
      nextIndex:
        Number.isInteger(loaded?.nextIndex) && this.endpoints.length > 0
          ? loaded.nextIndex % this.endpoints.length
          : 0,
      endpoints,
    };
  }

  persist() {
    if (!this.statePath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      try {
        fs.renameSync(temporaryPath, this.statePath);
      } catch {
        fs.rmSync(this.statePath, { force: true });
        fs.renameSync(temporaryPath, this.statePath);
      }
    } catch (error) {
      this.logger.error(`[exa-key-pool] state persist failed: ${error.message}`);
    }
  }

  select(attemptedIds = new Set()) {
    const count = this.endpoints.length;
    if (count === 0) {
      return null;
    }
    const currentTime = this.now();
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.state.nextIndex + offset) % count;
      const endpoint = this.endpoints[index];
      if (attemptedIds.has(endpoint.id)) {
        continue;
      }
      const entry = this.state.endpoints[endpoint.id] || emptyEntry();
      if (entry.status === "disabled") {
        continue;
      }
      let probe = false;
      if (entry.status === "open") {
        if (Number(entry.openUntil || 0) > currentTime) {
          continue;
        }
        if (this.halfOpenInFlight.has(endpoint.id)) {
          continue;
        }
        this.halfOpenInFlight.add(endpoint.id);
        probe = true;
      }
      this.state.nextIndex = (index + 1) % count;
      return { endpoint, probe };
    }
    return null;
  }

  reportSuccess(selection) {
    if (!selection) {
      return;
    }
    const entry = this.state.endpoints[selection.endpoint.id] || emptyEntry();
    entry.status = "healthy";
    entry.reason = null;
    entry.openUntil = 0;
    entry.lastSuccessAt = new Date(this.now()).toISOString();
    this.state.endpoints[selection.endpoint.id] = entry;
    this.halfOpenInFlight.delete(selection.endpoint.id);
    this.persist();
  }

  reportFailure(selection, failure) {
    if (!selection) {
      return;
    }
    const currentTime = this.now();
    const entry = this.state.endpoints[selection.endpoint.id] || emptyEntry();
    entry.reason = failure.reason;
    entry.lastFailureAt = new Date(currentTime).toISOString();
    if (failure.kind === "auth") {
      entry.status = "disabled";
      entry.openUntil = 0;
    } else {
      const baseCooldown =
        failure.kind === "rate_limit" ? this.rateLimitCooldownMs : this.cooldownMs;
      const jitter =
        failure.kind === "quota"
          ? Math.round((this.random() * 2 - 1) * this.cooldownJitterMs)
          : 0;
      entry.status = "open";
      entry.openUntil = currentTime + Math.max(1000, baseCooldown + jitter);
    }
    this.state.endpoints[selection.endpoint.id] = entry;
    this.halfOpenInFlight.delete(selection.endpoint.id);
    this.persist();
  }

  release(selection) {
    if (!selection) {
      return;
    }
    this.halfOpenInFlight.delete(selection.endpoint.id);
    this.persist();
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }
}
