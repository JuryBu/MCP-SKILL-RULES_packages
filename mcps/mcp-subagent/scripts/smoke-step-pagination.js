import { getSteps, getSummary } from "../src/cascadeOps.js";

const mainId = process.argv[2];
const marker = process.argv[3];

if (!mainId || !marker) {
  console.error("usage: node scripts/smoke-step-pagination.js <main_id> <marker>");
  process.exit(2);
}

const summary = await getSummary(mainId, mainId);
const total = Number(summary?.stepCount || 0);
const offsets = new Set([0]);
for (let offset = 50; offset <= Math.max(total + 80, 120); offset += 50) offsets.add(offset);
for (const near of [total - 80, total - 50, total - 30, total - 20, total - 10, total]) {
  if (near > 0) offsets.add(near);
}

let foundAt = null;
let firstPageHas = false;
for (const offset of [...offsets].sort((left, right) => left - right)) {
  const body = await getSteps(mainId, mainId, offset);
  const text = JSON.stringify(body || {});
  if (offset === 0) firstPageHas = text.includes(marker);
  if (text.includes(marker)) {
    foundAt = offset;
    break;
  }
}

if (!foundAt && foundAt !== 0) {
  throw new Error(`marker not found by paginated scan: ${marker}`);
}

console.log(`step pagination ok marker_offset=${foundAt} first_page_has=${firstPageHas} step_count=${total}`);
