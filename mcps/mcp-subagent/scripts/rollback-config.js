import fs from "node:fs/promises";
import path from "node:path";
import { defaults, parseArgs, pathExists, timestamp } from "./config-utils.js";

async function latestBackup(configPath) {
  const directory = path.dirname(configPath);
  const baseName = path.basename(configPath);
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const backups = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${baseName}.before-subagent-`))
      .map(async (entry) => {
        const fullPath = path.join(directory, entry.name);
        return { fullPath, mtimeMs: (await fs.stat(fullPath)).mtimeMs };
      }));
    backups.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return backups[0]?.fullPath || null;
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("usage: node scripts/rollback-config.js [--dry-run|--apply] [--backup <path>]");
  process.exit(0);
}

const backup = args.backup || await latestBackup(defaults.windsurfConfig);
console.log(`mode=${args.apply ? "apply" : "dry-run"} target=windsurf`);
console.log(`windsurf_config=${defaults.windsurfConfig}`);
console.log(`backup=${backup || "(none)"}`);
if (!backup || !(await pathExists(backup)) || !args.apply) process.exit(backup ? 0 : 1);

if (await pathExists(defaults.windsurfConfig)) {
  await fs.copyFile(defaults.windsurfConfig, `${defaults.windsurfConfig}.before-rollback-${timestamp()}`);
}
await fs.copyFile(backup, defaults.windsurfConfig);
console.log("restored=true");
