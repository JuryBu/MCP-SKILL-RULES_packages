import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTrainingTemporaryDirectory(prefix) {
  const parent = path.resolve(path.dirname(prefix));
  const ownedTemp = path.resolve(os.tmpdir());
  const relative = path.relative(ownedTemp, parent);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("OWNED_TRAINING_TEMP_SCOPE_REQUIRED");
  const directory = prefix + crypto.randomUUID();
  fs.mkdirSync(directory);
  return directory;
}
