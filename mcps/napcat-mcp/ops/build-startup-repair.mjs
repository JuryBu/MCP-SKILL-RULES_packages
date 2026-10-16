import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sourceFiles = ["src/control-plane.mjs", "src/codex-thread-bridge.mjs", "src/codex-app-server-proxy-runner.mjs",
  "src/inner-runtime-profile.mjs", "src/windows-powershell-environment.mjs", "src/inner-managed-events.mjs",
  "src/codex-runtime-bundle.mjs", "ops/start-codex-app-server-proxy.ps1", "ops/recover-inner-startup.mjs",
  "src/inner-startup-residual-recovery.mjs", "ops/Run-NapCatSupervisorWatchdog.ps1"];

export function repairDesktopLauncher(content) {
  if (content.includes("gate_resolved_unclean_exit")) {
    const start = content.indexOf("    try {\n      $MpPath=Join-Path $Plan.dataRoot");
    const end = content.indexOf("    $StartModelArgs=@{", start);
    if (start < 0 || end < 0 || content.indexOf("gate_resolved_unclean_exit", end) >= 0
      || !content.slice(start, end).includes(".crash-")) throw new Error("DESKTOP_RECOVERY_SOURCE_UNRECOGNIZED");
    content = content.slice(0, start) + content.slice(end);
  }
  const fallback = "    if($null -eq $ProxyStatus) {\n      $StartAppArgs=@{";
  const managedFailure = "    if($null -eq $ProxyStatus -and $null -ne $ModelStatus -and $ModelStatus.mode -eq 'managed') {throw 'APP_SERVER_PROXY_NOT_READY'}\n";
  if (content.includes("$AppDeadline=") && content.includes(fallback) && !content.includes(managedFailure)) {
    content = content.replace(fallback, managedFailure + fallback);
  }
  content = content.replaceAll("$Ps.runtime.state -eq 'running'", "$Ps.runtime.state -in @('running','waiting_for_desktop')")
    .replaceAll("$ProxyStatus.runtime.state -ne 'running'", "$ProxyStatus.runtime.state -notin @('running','waiting_for_desktop')");
  content = content.replace(/^[ \t]*\$Parked=\$false\n[ \t]*try \{\$Parked=.*waiting_for_desktop.*\n/gmu, "");
  content = content.replaceAll("if(-not $ModelStatus.healthy -and -not $Parked)", "if(-not $ModelStatus.healthy -and -not $ModelStatus.readyForDesktop)")
    .replaceAll("if(-not $ModelStatus.healthy)", "if(-not $ModelStatus.healthy -and -not $ModelStatus.readyForDesktop)");
  return content;
}

export function buildStartupRepairPayload({ sourceRoot, installedRoot, desktopLauncherPath, outputRoot }) {
  const installation = fs.realpathSync.native(installedRoot);
  const output = path.resolve(outputRoot);
  if (output === installation || output.startsWith(`${installation}${path.sep}`) || fs.existsSync(output)) {
    throw new Error("REPAIR_OUTPUT_MUST_BE_NEW_AND_OUTSIDE_INSTALLATION");
  }
  const runnerName = "src/codex-app-server-proxy-runner.mjs";
  const runnerImports = content => new Set([...content.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/gu)].map(match => match[1]));
  const originalImports = runnerImports(fs.readFileSync(path.join(installation, runnerName), "utf8"));
  const candidateImports = runnerImports(fs.readFileSync(path.join(sourceRoot, runnerName), "utf8"));
  if ([...candidateImports].some(specifier => !originalImports.has(specifier)
    && !sourceFiles.includes(path.posix.normalize(path.posix.join("src", specifier))))) {
    throw new Error("STARTUP_ONLY_REQUIRES_FULL_RUNTIME_PACKAGE");
  }
  fs.mkdirSync(output, { recursive: true });
  const files = [];
  const save = (name, targetPath, bytes, provenance) => {
    const original = fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null;
    if (original?.equals(bytes)) return;
    const payloadPath = path.join(output, `${files.length}.bin`);
    fs.writeFileSync(payloadPath, bytes, { flag: "wx" });
    files.push({ name, targetPath: path.resolve(targetPath), payloadPath, candidateSha256: digest(bytes),
      beforeSha256: original ? digest(original) : null, provenance });
  };
  for (const name of sourceFiles) {
    const source = path.join(sourceRoot, name);
    save(name, path.join(installation, name), fs.readFileSync(source), { kind: "unique_source", sourceSha256: digest(fs.readFileSync(source)) });
  }
  const coordinatorName = "src/inner-proxy-coordinator.mjs";
  const baseline = fs.readFileSync(path.join(installation, coordinatorName), "utf8");
  const selectedLine = fs.readFileSync(path.join(sourceRoot, coordinatorName), "utf8").split(/\r?\n/u)
    .find(line => line.includes('cwd: process.platform === "win32" && root.length >= 260'))?.trim();
  const oldLine = "cwd: root, windowsHide: true,";
  if (!selectedLine || baseline.split(oldLine).length !== 2) throw new Error("COORDINATOR_MINIMAL_CWD_BASELINE_CHANGED");
  save(coordinatorName, path.join(installation, coordinatorName), Buffer.from(baseline.replace(oldLine, selectedLine)),
    { kind: "selected_unique_source_line", installedBaselineSha256: digest(Buffer.from(baseline)), selectedLine });
  if (desktopLauncherPath) {
    const original = fs.readFileSync(desktopLauncherPath);
    const normalized = original.toString("utf8").replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
    const repaired = repairDesktopLauncher(normalized);
    if (repaired !== normalized) save("desktop-launcher.ps1", desktopLauncherPath, Buffer.from(`\uFEFF${repaired}`),
      { kind: "remove_legacy_recovery_only", installedBaselineSha256: digest(original) });
  }
  fs.writeFileSync(path.join(output, "payload.json"), JSON.stringify({ schemaVersion: 1, targetRoot: installation, files,
    scope: "startup-notification-only", fullHotUpgradeIncluded: false, productionActions: 0 }, null, 2), { flag: "wx" });
  return { payloadPath: path.join(output, "payload.json"), fileCount: files.length, productionActions: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceRoot, installedRoot, desktopLauncherPath, outputRoot] = process.argv.slice(2);
  console.log(JSON.stringify(buildStartupRepairPayload({ sourceRoot, installedRoot,
    desktopLauncherPath: desktopLauncherPath === "-" ? null : desktopLauncherPath, outputRoot })));
}
