import fs from "node:fs";

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);

function sleepSync(milliseconds) {
  Atomics.wait(SLEEP_VIEW, 0, 0, milliseconds);
}

export function renameReplaceSync(sourcePath, destinationPath, options = {}) {
  const renameSync = options.renameSync ?? fs.renameSync;
  const platform = options.platform ?? process.platform;
  const sleep = options.sleep ?? sleepSync;
  const maximumAttempts = options.maximumAttempts ?? 6;
  const initialDelayMs = options.initialDelayMs ?? 10;
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      renameSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      const retryable = platform === "win32"
        && TRANSIENT_RENAME_CODES.has(error?.code)
        && attempt < maximumAttempts;
      if (!retryable) throw error;
      sleep(initialDelayMs * (2 ** (attempt - 1)));
    }
  }
}
