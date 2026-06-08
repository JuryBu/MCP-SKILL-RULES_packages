import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SUBAGENT_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "wsf-subagent-list-smoke-"));

const { subagentList } = await import("../src/tools.js");
const { upsertJob } = await import("../src/registry.js");

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

function baseJob(id, state) {
  return {
    job_id: id,
    sub_cid: `${id}-sub`,
    main_id: "00000000-0000-4000-8000-000000000001",
    owner_conversation_id: "00000000-0000-4000-8000-000000000001",
    root_job_id: id,
    parent_job_id: null,
    depth: 0,
    state,
    label: id,
    mode: "ask",
    model: "test-model",
    collect_mode: "interrupt",
    allow_subagent: false,
    created_at: new Date(Date.now() - Math.random() * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

await upsertJob(baseJob("active-job", "running"));
await upsertJob(baseJob("archived-job", "archived"));
await upsertJob(baseJob("deleted-job", "deleted"));

const active = parseResult(await subagentList({}));
if (!active.jobs.some((job) => job.job_id === "active-job")) {
  throw new Error(`active job missing: ${JSON.stringify(active)}`);
}
if (active.jobs.some((job) => job.state === "deleted" || job.state === "archived")) {
  throw new Error(`default list leaked terminal history: ${JSON.stringify(active)}`);
}

const allSummary = parseResult(await subagentList({ filter: "all" }));
if (allSummary.jobs.some((job) => job.state === "deleted" || job.state === "archived")) {
  throw new Error(`filter=all summary leaked deleted/archived: ${JSON.stringify(allSummary)}`);
}
if (!allSummary.hidden.deleted || !allSummary.hidden.archived) {
  throw new Error(`filter=all summary did not report hidden counts: ${JSON.stringify(allSummary)}`);
}

const allFull = parseResult(await subagentList({ filter: "all", detail: "full" }));
if (!allFull.jobs.some((job) => job.job_id === "deleted-job") || !allFull.jobs.some((job) => job.job_id === "archived-job")) {
  throw new Error(`detail=full did not expose deleted/archived: ${JSON.stringify(allFull)}`);
}

console.log(`list defaults ok active=${active.count} all_summary=${allSummary.count} hidden_deleted=${allSummary.hidden.deleted}`);

