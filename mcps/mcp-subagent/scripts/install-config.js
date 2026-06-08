import { inspect } from "node:util";
import {
  backupFile,
  brokerReferenceEntry,
  clone,
  commandEntry,
  defaults,
  parseArgs,
  readJsonFile,
  writeJsonFile,
} from "./config-utils.js";

function usage() {
  return [
    "usage: node scripts/install-config.js [--dry-run|--apply] [--target both|broker|windsurf] [--broker|--stdio-fallback]",
    "",
    "Default is dry-run. --apply writes config files after creating .before-subagent-* backups.",
  ].join("\n");
}

function ensureMcpServers(config) {
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }
  return config.mcpServers;
}

function patchBrokerConfig(config) {
  const next = clone(config);
  const servers = ensureMcpServers(next);
  servers[defaults.key] = commandEntry();
  return next;
}

function patchWindsurfConfig(config, fallback) {
  const next = clone(config);
  const servers = ensureMcpServers(next);
  servers[defaults.key] = fallback === "stdio" ? commandEntry() : brokerReferenceEntry();
  return next;
}

function changed(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

async function processConfig({ label, filePath, before, after, apply }) {
  const isChanged = changed(before, after);
  console.log(`${label}: ${filePath}`);
  console.log(`  changed=${isChanged}`);
  if (!isChanged) return { label, changed: false, backup: null };
  if (!apply) {
    console.log(`  dry-run entry=${inspect(after.mcpServers?.[defaults.key], { depth: 6, colors: false })}`);
    return { label, changed: true, backup: null };
  }
  const backup = await backupFile(filePath);
  await writeJsonFile(filePath, after);
  console.log(`  backup=${backup || "(new file)"}`);
  console.log("  wrote=true");
  return { label, changed: true, backup };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!["both", "broker", "windsurf"].includes(args.target)) {
  throw new Error("--target must be one of both|broker|windsurf");
}
if (!["broker", "stdio"].includes(args.fallback)) {
  throw new Error("fallback must be broker or stdio");
}

console.log(`mode=${args.apply ? "apply" : "dry-run"} target=${args.target} fallback=${args.fallback} key=${defaults.key}`);
console.log("risk=global MCP config write; backup=.before-subagent-*; rollback=scripts/rollback-config.js");

const results = [];
if (args.target === "both" || args.target === "broker") {
  const before = await readJsonFile(defaults.brokerConfig);
  const after = patchBrokerConfig(before);
  results.push(await processConfig({
    label: "broker",
    filePath: defaults.brokerConfig,
    before,
    after,
    apply: args.apply,
  }));
}

if (args.target === "both" || args.target === "windsurf") {
  const before = await readJsonFile(defaults.windsurfConfig);
  const after = patchWindsurfConfig(before, args.fallback);
  results.push(await processConfig({
    label: "windsurf",
    filePath: defaults.windsurfConfig,
    before,
    after,
    apply: args.apply,
  }));
}

console.log(`summary=${JSON.stringify(results)}`);
if (args.apply && args.fallback === "broker") {
  console.log("next=restart/reload broker or restart Antigravity/Codex broker host, then run npm run smoke:broker-dry-run");
}
