import fs from "node:fs/promises";
import path from "node:path";
import {
  defaults,
  parseArgs,
  pathExists,
  timestamp,
} from "./config-utils.js";

function usage() {
  return [
    "usage: node scripts/rollback-config.js [--dry-run|--apply] [--target both|broker|windsurf] [--backup <path>]",
    "",
    "Without --backup, the latest .before-subagent-* backup for each target is selected.",
  ].join("\n");
}

async function latestBackup(configPath) {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(`${base}.before-subagent-`)) continue;
    const fullPath = path.join(dir, entry.name);
    const stat = await fs.stat(fullPath);
    backups.push({ fullPath, mtimeMs: stat.mtimeMs });
  }
  backups.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return backups[0]?.fullPath || null;
}

async function restore({ label, configPath, backupPath, apply }) {
  const selectedBackup = backupPath || await latestBackup(configPath);
  console.log(`${label}: ${configPath}`);
  console.log(`  backup=${selectedBackup || "(none)"}`);
  if (!selectedBackup) return { label, restored: false, reason: "no backup found" };
  if (!(await pathExists(selectedBackup))) return { label, restored: false, reason: "backup missing" };
  if (!apply) return { label, restored: false, dry_run: true, backup: selectedBackup };

  const preRollback = `${configPath}.before-rollback-${timestamp()}`;
  if (await pathExists(configPath)) {
    await fs.copyFile(configPath, preRollback);
  }
  await fs.copyFile(selectedBackup, configPath);
  console.log(`  preRollback=${preRollback}`);
  console.log("  restored=true");
  return { label, restored: true, backup: selectedBackup, preRollback };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!["both", "broker", "windsurf"].includes(args.target)) {
  throw new Error("--target must be one of both|broker|windsurf");
}

console.log(`mode=${args.apply ? "apply" : "dry-run"} target=${args.target}`);
const results = [];
if (args.target === "both" || args.target === "broker") {
  results.push(await restore({
    label: "broker",
    configPath: defaults.brokerConfig,
    backupPath: args.target === "broker" ? args.backup : null,
    apply: args.apply,
  }));
}
if (args.target === "both" || args.target === "windsurf") {
  results.push(await restore({
    label: "windsurf",
    configPath: defaults.windsurfConfig,
    backupPath: args.target === "windsurf" ? args.backup : null,
    apply: args.apply,
  }));
}
console.log(`summary=${JSON.stringify(results)}`);
