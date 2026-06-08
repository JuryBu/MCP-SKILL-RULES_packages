import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./registry.js";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function redactValue(value) {
  if (typeof value !== "string") return value;
  if (value.length <= 160) return value;
  return `${value.slice(0, 160)}...`;
}

export async function writeAudit(event) {
  try {
    const auditDir = path.join(getDataDir(), "audit");
    await fs.mkdir(auditDir, { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      pid: process.pid,
      ...Object.fromEntries(Object.entries(event).map(([key, value]) => [key, redactValue(value)])),
    };
    await fs.appendFile(path.join(auditDir, `${today()}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  } catch {}
}
