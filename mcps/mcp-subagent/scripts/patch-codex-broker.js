import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaults, parseArgs, pathExists, timestamp } from "./config-utils.js";

const brokerPath = process.env.CODEX_MCP_BROKER_SCRIPT || path.join(os.homedir(), ".codex", "mcp-http-broker", "broker.mjs");
const projectRoot = path.resolve(import.meta.dirname, "..");
const serverEntry = path.join(projectRoot, "src", "index.js");
const dataDir = path.join(projectRoot, "subagent-data");

function usage() {
  return [
    "usage: node scripts/patch-codex-broker.js [--dry-run|--apply]",
    "",
    "Patches Codex static HTTP broker endpoints with /subagent/mcp.",
    "Creates broker.mjs.before-subagent-* backup before writing.",
  ].join("\n");
}

function endpointSnippet() {
  const nodeCommand = process.execPath;
  return [
    "  subagent: {",
    "    path: \"/subagent/mcp\",",
    `    command: ${JSON.stringify(nodeCommand)},`,
    `    args: [${JSON.stringify(serverEntry)}],`,
    `    cwd: ${JSON.stringify(projectRoot)},`,
    "    env: {",
    "      CODEX_MCP_WRAPPER: \"1\",",
    "      CODEX_MCP_TOOL_NAME: \"subagent\",",
    `      SUBAGENT_DATA_DIR: ${JSON.stringify(dataDir)},`,
    "      SUBAGENT_CLEANUP_INTERVAL_SEC: \"3600\",",
    "      SUBAGENT_IDLE_TTL_SEC: \"86400\",",
    "    },",
    "  },",
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!(await pathExists(brokerPath))) {
  throw new Error(`broker script not found: ${brokerPath}`);
}

const text = await fs.readFile(brokerPath, "utf8");
const alreadyPresent = text.includes("path: \"/subagent/mcp\"");
console.log(`mode=${args.apply ? "apply" : "dry-run"} broker=${brokerPath}`);
console.log(`alreadyPresent=${alreadyPresent}`);
console.log(`route=${defaults.route} project=${projectRoot}`);
if (alreadyPresent) process.exit(0);

const needle = "};";
const index = text.indexOf(needle, text.indexOf("const endpoints = {"));
if (index < 0) throw new Error("could not locate endpoints object terminator");
const before = text.slice(0, index);
const after = text.slice(index);
const separator = before.trimEnd().endsWith(",") ? "" : ",";
const patched = `${before.trimEnd()}${separator}\n${endpointSnippet()}${after}`;

if (!args.apply) {
  console.log("dry-run: would add /subagent/mcp endpoint and create broker.mjs.before-subagent-* backup");
  process.exit(0);
}

const backup = `${brokerPath}.before-subagent-${timestamp()}`;
await fs.copyFile(brokerPath, backup);
await fs.writeFile(brokerPath, patched, "utf8");
console.log(`backup=${backup}`);
console.log("wrote=true");
