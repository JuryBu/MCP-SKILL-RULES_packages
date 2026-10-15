import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { repairDesktopLauncher } from "./build-startup-repair.mjs";

export const startupStaticFiles = ["src/inner-runtime-profile.mjs", "src/inner-startup-residual-recovery.mjs",
  "ops/start-codex-app-server-proxy.ps1", "ops/start-codex-model-stream-proxy.ps1", "ops/get-codex-model-stream-proxy-status.ps1"];
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

export function prepareStartupStatic({ sourceRoot, installedRoot, packageRoot, desktopLauncherPath }) {
  const source = fs.realpathSync.native(sourceRoot);
  const installed = fs.realpathSync.native(installedRoot);
  const output = path.resolve(packageRoot);
  if (fs.existsSync(output) || output.toLowerCase().startsWith(installed.toLowerCase() + path.sep)) throw new Error("NEW_EXTERNAL_PACKAGE_REQUIRED");
  const read = filename => {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1048576) throw new Error("PLAIN_STARTUP_FILE_REQUIRED");
    return fs.readFileSync(filename);
  };
  const entries = startupStaticFiles.map(name => ({ name, target: path.join(installed, name), candidate: read(path.join(source, name)) }));
  if (desktopLauncherPath) {
    const before = read(desktopLauncherPath);
    const text = before.toString("utf8").replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
    entries.push({ name: "desktop-launcher.ps1", target: path.resolve(desktopLauncherPath), candidate: Buffer.from("\uFEFF" + repairDesktopLauncher(text)) });
  }
  const prepared = entries.map(entry => ({ ...entry, original: read(entry.target) })).filter(entry => !entry.original.equals(entry.candidate));
  fs.mkdirSync(output, { recursive: true });
  const files = prepared.map((entry, index) => {
    fs.writeFileSync(path.join(output, `${index}.original`), entry.original, { flag: "wx" });
    fs.writeFileSync(path.join(output, `${index}.candidate`), entry.candidate, { flag: "wx" });
    return { name: entry.name, target: entry.target, original: `${index}.original`, candidate: `${index}.candidate`,
      beforeSha256: digest(entry.original), afterSha256: digest(entry.candidate) };
  });
  const entryBytes = read(path.join(source, "ops/update-startup-static.ps1"));
  fs.writeFileSync(path.join(output, "update-startup-static.ps1"), entryBytes, { flag: "wx" });
  const manifest = { schemaVersion: 1, scope: "next-startup-files-only", installedRoot: installed,
    desktopLauncherPath: desktopLauncherPath ? path.resolve(desktopLauncherPath) : null, files, serviceActions: 0, stateWrites: 0 };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const manifestPath = path.join(output, "manifest.json");
  fs.writeFileSync(manifestPath, manifestBytes, { flag: "wx" });
  return { manifestPath, manifestSha256: digest(manifestBytes), entrySha256: digest(entryBytes), files: files.length, targetWrites: 0, serviceActions: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceRoot, installedRoot, packageRoot, launcher] = process.argv.slice(2);
  console.log(JSON.stringify(prepareStartupStatic({ sourceRoot, installedRoot, packageRoot, desktopLauncherPath: launcher === "-" ? null : launcher })));
}
