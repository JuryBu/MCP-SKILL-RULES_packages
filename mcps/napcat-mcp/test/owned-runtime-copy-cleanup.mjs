import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNTIME_NAMES = new Set(["codex.exe", "codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe"]);

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function sha256(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  const hash = crypto.createHash("sha256");
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytesRead));
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function alive(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try { process.kill(processId, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

export function cleanupOwnedRuntimeCopies({ ownedRoot, copies, processIds = [], isProcessAlive = alive }) {
  const resolvedRoot = fs.realpathSync(ownedRoot);
  if (!inside(fs.realpathSync(os.tmpdir()), resolvedRoot)) throw new Error("OWNED_TEMP_ROOT_REQUIRED");
  if (!Array.isArray(copies) || copies.length > 16) throw new Error("EXPLICIT_RUNTIME_COPY_LIST_REQUIRED");
  const record = { schemaVersion: 1, ownedRoot: resolvedRoot, checkedAt: new Date().toISOString(), state: "prepared", files: [], removedBytes: 0 };
  const manifestPath = path.join(resolvedRoot, `runtime-copy-cleanup-${crypto.randomUUID()}.json`);
  const blocked = () => processIds.some(isProcessAlive);
  if (blocked()) return { ...record, state: "preserved-live-process", manifestPath: null };
  for (const copy of copies) {
    const targetPath = path.resolve(copy.targetPath);
    const sourcePath = fs.realpathSync(copy.sourcePath);
    if (!inside(resolvedRoot, targetPath) || inside(resolvedRoot, sourcePath)
      || !RUNTIME_NAMES.has(path.basename(targetPath)) || targetPath === sourcePath) {
      throw new Error("RUNTIME_COPY_SCOPE_INVALID");
    }
    if (!fs.existsSync(targetPath)) { record.files.push({ targetPath, sourcePath, state: "already-absent" }); continue; }
    const targetStat = fs.lstatSync(targetPath);
    if (!targetStat.isFile() || !inside(resolvedRoot, fs.realpathSync(targetPath))) throw new Error("RUNTIME_COPY_REPARSE_OR_TYPE_INVALID");
    const sourceSha256 = sha256(sourcePath);
    const targetSha256 = sha256(targetPath);
    record.files.push({ targetPath, sourcePath, sourceSha256, targetSha256, bytes: targetStat.size,
      fileId: targetStat.ino, deviceId: targetStat.dev, modifiedMs: targetStat.mtimeMs,
      state: sourceSha256 === targetSha256 ? "verified-rebuildable" : "preserved-content-drift" });
  }
  fs.writeFileSync(manifestPath, JSON.stringify(record, null, 2), { flag: "wx" });
  for (const file of record.files) {
    if (file.state !== "verified-rebuildable") continue;
    if (blocked()) { record.state = "preserved-live-process"; break; }
    const current = fs.lstatSync(file.targetPath);
    if (!current.isFile() || !inside(resolvedRoot, fs.realpathSync(file.targetPath))
      || current.ino !== file.fileId || current.dev !== file.deviceId
      || current.size !== file.bytes || current.mtimeMs !== file.modifiedMs) {
      file.state = "preserved-identity-drift";
      continue;
    }
    try {
      fs.unlinkSync(file.targetPath);
      file.state = "removed-rebuildable-copy";
      record.removedBytes += file.bytes;
    } catch (error) {
      file.state = "preserved-delete-failure";
      file.errorCode = error.code ?? "UNKNOWN";
    }
    fs.writeFileSync(manifestPath, JSON.stringify(record, null, 2));
  }
  if (record.state === "prepared") record.state = "completed";
  record.completedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(record, null, 2));
  return { ...record, manifestPath };
}
