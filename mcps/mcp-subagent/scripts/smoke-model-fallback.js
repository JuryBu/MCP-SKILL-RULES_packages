import { getModelProfiles, resolveModelSelection } from "../src/modelCatalog.js";

const exact = await resolveModelSelection({ model: "kimi-k2-6", model_profile: "cowork", refresh: true });
if (exact.model_resolved !== "kimi-k2-6") {
  throw new Error(`exact model did not win: ${JSON.stringify(exact).slice(0, 1000)}`);
}
if (!exact.model_fallback_chain?.[0]?.available) {
  throw new Error(`exact model chain did not mark availability: ${JSON.stringify(exact.model_fallback_chain)}`);
}

const fallback = await resolveModelSelection({ model: "definitely-not-a-real-wsf-model", model_profile: "explore" });
if (fallback.model_resolved === "definitely-not-a-real-wsf-model") {
  throw new Error(`unavailable exact model was not replaced: ${JSON.stringify(fallback)}`);
}
if (!String(fallback.model_note || "").includes("fell back")) {
  throw new Error(`fallback note missing: ${JSON.stringify(fallback)}`);
}
if (!fallback.model_fallback_chain?.some((candidate) => candidate.uid === "definitely-not-a-real-wsf-model" && candidate.available === false)) {
  throw new Error(`fallback chain missing unavailable exact model: ${JSON.stringify(fallback.model_fallback_chain)}`);
}

const review = await getModelProfiles({ purpose: "review", include_unverified: true });
const reviewCandidates = review.profiles.review.candidates;
const codex = reviewCandidates.find((candidate) => candidate.uid === "gpt-5-3-codex");
const deepseek = reviewCandidates.find((candidate) => candidate.uid === "deepseek-v4-pro");
if (!codex || codex.available !== false || codex.source !== "unverified") {
  throw new Error(`GPT-5.3-Codex was not marked unverified/unavailable: ${JSON.stringify(codex)}`);
}
if (!deepseek || deepseek.available !== false || deepseek.source !== "unverified") {
  throw new Error(`DeepSeek V4 Pro was not marked unverified/unavailable: ${JSON.stringify(deepseek)}`);
}

console.log(`model fallback ok exact=${exact.model_resolved} fallback=${fallback.model_resolved} review_unverified=${reviewCandidates.filter((candidate) => candidate.source === "unverified").length}`);
