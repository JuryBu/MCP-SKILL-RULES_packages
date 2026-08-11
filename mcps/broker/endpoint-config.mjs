export const DEFAULT_BACKEND_STARTUP_TIMEOUT_MS = 15000;
export const MIN_BACKEND_STARTUP_TIMEOUT_MS = 1000;
export const MAX_BACKEND_STARTUP_TIMEOUT_MS = 10 * 60 * 1000;

export function normalizeBackendStartupTimeoutMs(value, fallback = DEFAULT_BACKEND_STARTUP_TIMEOUT_MS) {
  const fallbackNumber = Number(fallback);
  const normalizedFallback = Number.isFinite(fallbackNumber) && fallbackNumber > 0
    ? Math.max(
      MIN_BACKEND_STARTUP_TIMEOUT_MS,
      Math.min(Math.floor(fallbackNumber), MAX_BACKEND_STARTUP_TIMEOUT_MS),
    )
    : DEFAULT_BACKEND_STARTUP_TIMEOUT_MS;
  const configured = Number(value);
  if (!Number.isFinite(configured) || configured <= 0) return normalizedFallback;
  return Math.max(
    MIN_BACKEND_STARTUP_TIMEOUT_MS,
    Math.min(Math.floor(configured), MAX_BACKEND_STARTUP_TIMEOUT_MS),
  );
}

export function getEndpointStartupTimeoutEnvKey(name) {
  const suffix = String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!suffix) throw new Error("Endpoint name is required for startup timeout configuration");
  return `CODEX_MCP_BROKER_${suffix}_STARTUP_TIMEOUT_MS`;
}

export function resolveEndpointStartupTimeoutMs(name, options = {}) {
  const env = options.env || process.env;
  const privateEnv = options.privateEnv || {};
  const defaultTimeoutMs = normalizeBackendStartupTimeoutMs(
    privateEnv.CODEX_MCP_BROKER_STARTUP_TIMEOUT_MS ?? env.CODEX_MCP_BROKER_STARTUP_TIMEOUT_MS,
    options.defaultTimeoutMs,
  );
  const endpointKey = getEndpointStartupTimeoutEnvKey(name);
  return normalizeBackendStartupTimeoutMs(
    privateEnv[endpointKey] ?? env[endpointKey],
    defaultTimeoutMs,
  );
}
