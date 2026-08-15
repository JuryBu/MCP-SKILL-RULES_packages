import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES = 8;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function integerOption(value, fallback, minimum, maximum, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function existingSize(filePath, fsImpl) {
  try {
    return Number(fsImpl.statSync(filePath).size ?? 0);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

export function createBoundedJsonlWriter(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const rawFilePath = typeof options.filePath === "string" ? options.filePath.trim() : "";
  if (!rawFilePath) throw new Error("filePath is required");
  const filePath = path.resolve(rawFilePath);
  const maxBytes = integerOption(options.maxBytes, DEFAULT_MAX_BYTES, 1024, 1024 * 1024 * 1024, "maxBytes");
  const maxFiles = integerOption(options.maxFiles, DEFAULT_MAX_FILES, 1, 128, "maxFiles");
  const retentionMs = integerOption(options.retentionMs, DEFAULT_RETENTION_MS, 1000, 365 * 24 * 60 * 60 * 1000, "retentionMs");
  const now = options.now ?? (() => new Date());

  const rotatedPath = (index) => `${filePath}.${index}`;
  const pruneExpired = () => {
    const cutoff = new Date(now()).getTime() - retentionMs;
    for (let index = 0; index < maxFiles; index += 1) {
      const candidate = index === 0 ? filePath : rotatedPath(index);
      try {
        if (fsImpl.statSync(candidate).mtimeMs < cutoff) fsImpl.rmSync(candidate, { force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  };
  const rotate = () => {
    if (maxFiles === 1) {
      fsImpl.rmSync(filePath, { force: true });
      return;
    }
    fsImpl.rmSync(rotatedPath(maxFiles - 1), { force: true });
    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      const source = rotatedPath(index);
      if (fsImpl.existsSync(source)) fsImpl.renameSync(source, rotatedPath(index + 1));
    }
    if (fsImpl.existsSync(filePath)) fsImpl.renameSync(filePath, rotatedPath(1));
  };

  return {
    append(value) {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      pruneExpired();
      let line = `${JSON.stringify(value)}\n`;
      let bytes = Buffer.byteLength(line);
      if (bytes > maxBytes) {
        line = `${JSON.stringify({
          at: new Date(now()).toISOString(),
          type: "log_entry_omitted",
          reason: "entry_exceeds_file_limit",
          originalBytes: bytes,
        })}\n`;
        bytes = Buffer.byteLength(line);
      }
      if (existingSize(filePath, fsImpl) + bytes > maxBytes) rotate();
      fsImpl.appendFileSync(filePath, line, "utf8");
      return true;
    },
    status() {
      return { filePath, maxBytes, maxFiles, retentionMs, currentBytes: existingSize(filePath, fsImpl) };
    },
  };
}
