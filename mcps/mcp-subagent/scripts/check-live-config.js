import { defaults, readJsonFile } from "./config-utils.js";

const config = await readJsonFile(defaults.windsurfConfig);
const entry = config.mcpServers?.[defaults.key] || null;
const usesExpectedEntry = Boolean(entry?.command && Array.isArray(entry?.args));

console.log(JSON.stringify({
  ok: usesExpectedEntry,
  scope: "windsurf-only",
  windsurf_config: defaults.windsurfConfig,
  key: defaults.key,
  configured: Boolean(entry),
  uses_stdio_entry: usesExpectedEntry,
  notes: ["This package does not configure or expose native Codex, Claude, or Antigravity integration."],
}, null, 2));
