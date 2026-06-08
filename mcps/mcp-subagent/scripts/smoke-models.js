import { subagentModels } from "../src/tools.js";

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

const data = parseResult(await subagentModels({ purpose: "explore", refresh: true }));
if (!data.ok) {
  throw new Error(`subagent_models failed: ${JSON.stringify(data)}`);
}
if (!data.updated_at || !data.sources || !Array.isArray(data.available)) {
  throw new Error(`subagent_models missing top-level fields: ${JSON.stringify(data).slice(0, 1000)}`);
}
if (!data.profiles?.explore?.candidates?.length) {
  throw new Error(`explore profile missing candidates: ${JSON.stringify(data.profiles?.explore)}`);
}
const availableCandidate = data.profiles.explore.candidates.find((candidate) => candidate.available !== false);
if (!availableCandidate?.uid || !availableCandidate?.label || !availableCandidate?.source) {
  throw new Error(`explore profile did not expose an available candidate with uid/label/source: ${JSON.stringify(data.profiles.explore.candidates)}`);
}
if (data.profiles.explore.candidates.some((candidate) => candidate.source === "unverified" && candidate.available !== false)) {
  throw new Error(`unverified candidate was exposed as available: ${JSON.stringify(data.profiles.explore.candidates)}`);
}
console.log(`models ok available=${data.available.length} cached=${data.sources.cached?.count || 0} explore=${availableCandidate.uid}`);
