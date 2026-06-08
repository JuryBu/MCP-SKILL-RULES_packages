import fs from "node:fs";

const schema = JSON.parse(fs.readFileSync("schemas/registry.schema.json", "utf8"));
const spec = fs.readFileSync("Plan/Stage_B0_Spec.md", "utf8");

const requiredSchemaStates = [
  "creating",
  "running",
  "done",
  "collecting",
  "collected",
  "collect_failed",
  "timeout",
  "archived",
  "deleted",
  "missing",
  "orphan",
  "stale_queue",
];

const enumStates = schema.$defs.jobState.enum;
for (const state of requiredSchemaStates) {
  if (!enumStates.includes(state)) {
    throw new Error(`missing registry state ${state}`);
  }
}

const requiredSpecTerms = [
  "main_id",
  "RemoveFromQueue",
  "jobs.lock",
  "missing",
  "orphan",
  "timeout",
  "archived",
  "stale_queue",
  "dry-run",
  "rollback",
  "best-effort",
];

for (const term of requiredSpecTerms) {
  if (!spec.includes(term)) {
    throw new Error(`Stage_B0_Spec missing ${term}`);
  }
}

console.log("b0 ok: schema states and spec terms verified");
