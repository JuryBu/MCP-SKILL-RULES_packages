import { subagentModels } from "../src/tools.js";

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

const summary = parseResult(await subagentModels({ refresh: true }));
if (!summary.ok) {
  throw new Error(`subagent_models summary failed: ${JSON.stringify(summary)}`);
}
if (Array.isArray(summary.available)) {
  throw new Error("summary view should not include full available model list");
}
if (!summary.available_count || !summary.profiles?.explore?.first_available) {
  throw new Error(`summary missing counts/profile first_available: ${JSON.stringify(summary).slice(0, 1000)}`);
}
if (JSON.stringify(summary).length > 20000) {
  throw new Error(`summary output too large: ${JSON.stringify(summary).length}`);
}

const detail = parseResult(await subagentModels({ purpose: "explore", detail: "detail" }));
if (!detail.ok || Array.isArray(detail.available)) {
  throw new Error(`detail profile should not include full available list: ${JSON.stringify(detail).slice(0, 1000)}`);
}
if (!detail.profiles?.explore?.candidates?.length) {
  throw new Error(`explore profile missing candidates: ${JSON.stringify(detail.profiles?.explore)}`);
}
const availableCandidate = detail.profiles.explore.candidates.find((candidate) => candidate.available !== false);
if (!availableCandidate?.uid || !availableCandidate?.label || !availableCandidate?.source) {
  throw new Error(`explore profile did not expose an available candidate with uid/label/source: ${JSON.stringify(detail.profiles.explore.candidates)}`);
}
if (detail.profiles.explore.candidates.some((candidate) => candidate.source === "unverified" && candidate.available !== false)) {
  throw new Error(`unverified candidate was exposed as available: ${JSON.stringify(detail.profiles.explore.candidates)}`);
}

const full = parseResult(await subagentModels({ detail: "full" }));
if (!full.ok || !Array.isArray(full.available) || !full.available.length) {
  throw new Error(`full view missing available list: ${JSON.stringify(full).slice(0, 1000)}`);
}
console.log(`models ok summary_len=${JSON.stringify(summary).length} available=${full.available.length} cached=${full.sources.cached?.count || 0} explore=${availableCandidate.uid}`);
