import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [];
function collect(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(absolutePath);
    else if (entry.name.endsWith(".mjs")) files.push(absolutePath);
  }
}
for (const directory of ["src", "scripts", "test"]) collect(path.join(root, directory));
for (const filePath of files) {
  const result = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `检查失败：${path.relative(root, filePath)}\n`);
    process.exit(1);
  }
}
process.stdout.write(`语法检查通过：${files.length}个模块\n`);
