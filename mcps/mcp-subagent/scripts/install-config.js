import { inspect } from "node:util";
import {
  backupFile,
  clone,
  commandEntry,
  defaults,
  parseArgs,
  readJsonFile,
  writeJsonFile,
} from "./config-utils.js";

function usage() {
  return [
    "usage: node scripts/install-config.js [--dry-run|--apply]",
    "",
    "Windsurf-only. The default is dry-run; --apply backs up and updates only WSF_CONFIG.",
  ].join("\n");
}

function patchWindsurfConfig(config) {
  const next = clone(config);
  if (!next.mcpServers || typeof next.mcpServers !== "object") next.mcpServers = {};
  next.mcpServers[defaults.key] = commandEntry();
  return next;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const before = await readJsonFile(defaults.windsurfConfig);
const after = patchWindsurfConfig(before);
const changed = JSON.stringify(before) !== JSON.stringify(after);
console.log(`mode=${args.apply ? "apply" : "dry-run"} target=windsurf key=${defaults.key}`);
console.log(`windsurf_config=${defaults.windsurfConfig}`);
console.log(`changed=${changed}`);
if (!changed) process.exit(0);
if (!args.apply) {
  console.log(`entry=${inspect(after.mcpServers[defaults.key], { depth: 6, colors: false })}`);
  process.exit(0);
}

const backup = await backupFile(defaults.windsurfConfig);
await writeJsonFile(defaults.windsurfConfig, after);
console.log(`backup=${backup || "(new file)"}`);
console.log("wrote=true");
