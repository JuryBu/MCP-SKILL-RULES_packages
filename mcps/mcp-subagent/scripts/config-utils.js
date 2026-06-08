import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const projectRoot = path.resolve(import.meta.dirname, "..");
export const serverEntry = path.join(projectRoot, "src", "index.js");
export const dataDir = path.join(projectRoot, "subagent-data");
const homeDir = os.homedir();

export const defaults = {
  key: process.env.WSF_SUBAGENT_KEY || "subagent",
  route: process.env.WSF_SUBAGENT_BROKER_ROUTE || "http://127.0.0.1:14588/subagent/mcp",
  brokerConfig: process.env.WSF_BROKER_CONFIG || path.join(homeDir, ".gemini", "antigravity", "mcp_config.json"),
  windsurfConfig: process.env.WSF_CONFIG || path.join(homeDir, ".codeium", "windsurf", "mcp_config.json"),
};

export function parseArgs(argv) {
  const args = {
    apply: false,
    target: "both",
    fallback: "broker",
    backup: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--target") args.target = argv[++index] || args.target;
    else if (arg === "--stdio-fallback") args.fallback = "stdio";
    else if (arg === "--broker") args.fallback = "broker";
    else if (arg === "--backup") args.backup = argv[++index] || null;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

export async function readJsonFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function backupFile(filePath) {
  if (!(await pathExists(filePath))) return null;
  const backupPath = `${filePath}.before-subagent-${timestamp()}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

export async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-subagent-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export function commandEntry() {
  return {
    command: process.execPath,
    args: [serverEntry],
    env: {
      SUBAGENT_DATA_DIR: dataDir,
      SUBAGENT_CLEANUP_INTERVAL_SEC: process.env.SUBAGENT_CLEANUP_INTERVAL_SEC || "3600",
      SUBAGENT_IDLE_TTL_SEC: process.env.SUBAGENT_IDLE_TTL_SEC || "86400",
    },
    disabled: false,
  };
}

export function brokerReferenceEntry() {
  return {
    serverUrl: defaults.route,
  };
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
