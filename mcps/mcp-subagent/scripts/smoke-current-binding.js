import { subagentCurrent, subagentSpawn } from "../src/tools.js";
import { getSummary } from "../src/cascadeOps.js";

const realMainId = process.argv[2];
const fakeMainId = process.argv[3] || "cascade-main-test-001";
const missingUuidMainId = process.argv[4] || "00000000-0000-4000-8000-000000000000";

if (!realMainId) {
  console.error("usage: node scripts/smoke-current-binding.js <real_main_id> [fake_main_id] [missing_uuid_main_id]");
  process.exit(2);
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

const current = parseResult(await subagentCurrent({ limit: 12 }));
console.log(`current ok=${current.ok} candidates=${current.candidates?.length || 0} best=${current.current_best_effort?.main_id || ""}`);
if (!current.ok || !Array.isArray(current.candidates) || !current.candidates.length) {
  throw new Error(`subagent_current did not return candidates: ${JSON.stringify(current)}`);
}

const realSummary = await getSummary(realMainId, realMainId);
console.log(`real main ${realMainId} status=${realSummary?.status || "missing"}`);
if (!realSummary) {
  throw new Error(`real main id not resolvable: ${realMainId}`);
}

let missingUuidError = "";
try {
  await getSummary(missingUuidMainId, missingUuidMainId);
} catch (error) {
  missingUuidError = error.message || "";
}
console.log(`missing uuid main error=${JSON.stringify(missingUuidError)}`);
if (!missingUuidError.includes("No Windsurf/Devin LS contains main_id=") || !missingUuidError.includes("subagent_current")) {
  throw new Error(`missing UUID main_id did not produce LS-not-containing error with current hint: ${missingUuidError}`);
}

const fakeSpawn = parseResult(await subagentSpawn({
  prompt: "This should not spawn because main_id is fake.",
  main_id: fakeMainId,
  label: "fake-main-id-guard",
  mode: "ask",
}));
console.log(`fake spawn ok=${fakeSpawn.ok} error=${JSON.stringify(fakeSpawn.error || "")}`);
if (fakeSpawn.ok || !String(fakeSpawn.error || "").includes("subagent_current")) {
  throw new Error(`fake main id was not rejected with current hint: ${JSON.stringify(fakeSpawn)}`);
}

const missingMain = parseResult(await subagentSpawn({
  prompt: "This should not spawn because main_id is missing.",
  label: "missing-main-id-guard",
  mode: "ask",
}));
console.log(`missing main ok=${missingMain.ok} error=${JSON.stringify(missingMain.error || "")}`);
if (missingMain.ok || !String(missingMain.error || "").includes("subagent_current")) {
  throw new Error(`missing main_id was not rejected with current hint: ${JSON.stringify(missingMain)}`);
}

console.log("current binding smoke ok");
