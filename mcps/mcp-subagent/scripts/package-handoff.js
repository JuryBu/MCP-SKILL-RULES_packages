import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const distRoot = path.join(root, "dist");
const packageRoot = path.join(distRoot, "mcp-subagent-handoff");
const projectRoot = path.join(packageRoot, "mcp-subagent");

const include = [
  ".gitignore",
  "README.md",
  "package.json",
  "package-lock.json",
  "Plan",
  "schemas",
  "scripts",
  "src",
];

const excludedNames = new Set([
  "node_modules",
  "subagent-data",
  "dist",
  ".git",
]);

async function copyRecursive(source, target) {
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    if (excludedNames.has(path.basename(source))) return;
    await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      if (excludedNames.has(entry)) continue;
      await copyRecursive(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

await fs.rm(packageRoot, { recursive: true, force: true });
await fs.mkdir(projectRoot, { recursive: true });

for (const item of include) {
  await copyRecursive(path.join(root, item), path.join(projectRoot, item));
}

const manifest = {
  generated_at: new Date().toISOString(),
  source_workspace: root,
  target_repo: "https://github.com/JuryBu/MCP-SKILL-RULES_packages",
  suggested_target_path: "packages/mcp-subagent",
  package_root: projectRoot,
  excludes: Array.from(excludedNames).sort(),
  verification: [
    "npm install",
    "npm run build",
    "npm run smoke:mcp-tools",
    "npm run smoke:models",
    "npm run smoke:model-fallback",
    "npm run smoke:model-profile -- <main_id>",
    "npm run smoke:list-defaults",
    "npm run smoke:current-binding -- <main_id>",
    "npm run smoke:auto-collect -- <main_id>",
    "npm run smoke:collect-dedupe -- <main_id>",
    "npm run smoke:timeout-late-collect -- <main_id>",
    "npm run smoke:step-pagination -- <main_id> <marker>",
    "npm run smoke:broker-dry-run",
    "npm run check:live-config",
    "npm run patch:codex-broker",
    "npm run smoke:broker-tools",
    "npm run smoke:broker-follower-lock",
    "npm run smoke:stage-g -- <main_id>",
    "npm run smoke:stage-g-tool -- <main_id>",
    "npm run smoke:stage-g-boundary -- <main_id>",
    "npm run smoke:stage-h -- <main_id>",
    "npm run smoke:stage-h-tool -- <main_id>",
  ],
  live_broker_apply: {
    status: "pending explicit authorization",
    command: "npm run install:config -- --apply && npm run patch:codex-broker -- --apply",
    verify: "npm run check:live-config && npm run smoke:broker-load && npm run smoke:broker-tools",
    rollback: "npm run rollback:config -- --apply",
  },
};

await fs.writeFile(path.join(packageRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(packageRoot, "README_HANDOFF.md"), [
  "# mcp-subagent handoff",
  "",
  "Target repository: https://github.com/JuryBu/MCP-SKILL-RULES_packages",
  "",
  "Suggested target path: `packages/mcp-subagent`.",
  "",
  "This handoff excludes `node_modules/`, `subagent-data/`, `.git/`, and `dist/` runtime/generated data.",
  "",
  "## Verify after import",
  "",
  "```powershell",
  "npm install",
  "npm run build",
  "npm run smoke:mcp-tools",
  "npm run smoke:models",
  "npm run smoke:model-fallback",
  "npm run smoke:model-profile -- <main_id>",
  "npm run smoke:list-defaults",
  "npm run smoke:current-binding -- <main_id>",
  "npm run smoke:auto-collect -- <main_id>",
  "npm run smoke:collect-dedupe -- <main_id>",
  "npm run smoke:timeout-late-collect -- <main_id>",
  "npm run smoke:step-pagination -- <main_id> <marker>",
  "npm run smoke:broker-dry-run",
  "npm run check:live-config",
  "npm run patch:codex-broker",
  "npm run smoke:broker-follower-lock",
  "npm run smoke:stage-h -- <main_id>",
  "npm run smoke:stage-h-tool -- <main_id>",
  "```",
  "",
  "Live broker installation is intentionally not applied in this package. It modifies global MCP config files and requires explicit operator authorization.",
  "",
  "```powershell",
  "npm run install:config -- --apply",
  "npm run patch:codex-broker -- --apply",
  "npm run smoke:broker-load",
  "npm run smoke:broker-tools",
  "npm run rollback:config -- --apply",
  "```",
  "",
].join("\n"), "utf8");

console.log(`handoff package ready: ${packageRoot}`);
