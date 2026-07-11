import { callResolvedLanguageServer } from "./lsClient.js";
import { createMetadata } from "./metadata.js";
import { DEFAULT_MODEL } from "./cascadeOps.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedCatalog = null;

const COST_ORDER = {
  MODEL_COST_TIER_FREE: 0,
  MODEL_COST_TIER_LOW: 1,
  MODEL_COST_TIER_MEDIUM: 2,
  MODEL_COST_TIER_HIGH: 3,
};

const PROFILE_ALIASES = {
  fronted: "frontend",
  brainstorm: "unblock",
};

const PROFILE_DEFINITIONS = {
  cowork: {
    description: "强协作 / 高质量主力子代理",
    candidates: [
      { uid: "claude-opus-4-8-xhigh", note: "优先强协作，适合复杂实现和长期维护判断" },
      { uid: "glm-5-2-max-1m", label: "GLM 5.2 Max 1M", note: "高质量协作；不支持多模态（supports_images=false）" },
      { uid: "claude-opus-4-6-thinking-1m", label: "Claude Opus 4.6 Thinking 1M", note: "长上下文强协作备用" },
      { uid: "claude-opus-4-8-high", note: "强协作备用" },
      { uid: "claude-opus-4-8-medium", note: "强协作中档备用" },
      { uid: "claude-sonnet-4-6-thinking", note: "高质量代码协作备用" },
      { uid: "gpt-5-4", label: "GPT-5.4", source: "unverified", note: "用户偏好项；一般慎用，当前 WSF 缓存未必存在" },
    ],
  },
  explore: {
    description: "低成本 / 高性价比探索",
    candidates: [
      { uid: "glm-5-2-max-1m", label: "GLM 5.2 Max 1M", note: "高质量探索；不支持多模态（supports_images=false）" },
      { uid: "kimi-k2-7", label: "Kimi K2.7", note: "探索与资料梳理，低成本候选" },
      { uid: "kimi-k2-6", note: "探索备用" },
      { uid: "swe-1-6-fast", note: "快速代码探索" },
      { uid: "swe-1-6", note: "Windsurf 自家探索备用" },
      { uid: "gemini-3-5-flash-medium", note: "长上下文、低成本探索备用" },
      { uid: "gemini-3-5-flash-low", note: "更省的探索备用" },
      { uid: "gemini-3-5-flash-minimal", note: "最轻探索备用" },
    ],
  },
  frontend: {
    description: "前端 / 视觉 / 交互质量",
    candidates: [
      { uid: "claude-opus-4-8-xhigh", note: "前端质量和设计判断优先" },
      { uid: "claude-opus-4-8-high", note: "前端高质量备用" },
      { uid: "claude-opus-4-8-medium", note: "前端中档备用" },
      { uid: "claude-sonnet-4-6-thinking", note: "代码实现备用" },
    ],
  },
  review: {
    description: "审查 / 找风险 / 挑错",
    candidates: [
      { uid: "glm-5-2-max-1m", label: "GLM 5.2 Max 1M", note: "高质量审查；不支持多模态（supports_images=false）" },
      { uid: "gpt-5-3-codex", label: "GPT-5.3-Codex", source: "unverified", note: "Codex 审查偏好项；若 WSF 缓存没有，不伪装成可用" },
      { uid: "deepseek-v4-pro", label: "DeepSeek V4 Pro", source: "unverified", note: "审查偏好项；若 WSF 缓存没有，不伪装成可用" },
      { uid: "claude-opus-4-8-xhigh", note: "WSF 可用时的高质量审查 fallback" },
      { uid: "claude-opus-4-8-high", note: "审查 fallback" },
      { uid: "claude-sonnet-4-6-thinking", note: "代码审查 fallback" },
    ],
  },
  unblock: {
    description: "破局 / 盲点 / 灵感",
    candidates: [
      { uid: "gemini-3-5-flash-high", note: "盲点和破局优先，适合换视角" },
      { uid: "gemini-3-5-flash-medium", note: "破局备用" },
      { uid: "gemini-3-5-flash-low", note: "轻量破局备用" },
      { uid: "gemini-3-5-flash-minimal", note: "最轻破局备用" },
    ],
  },
};

const FALLBACK_MODELS = [
  {
    uid: DEFAULT_MODEL,
    label: "Claude Opus 4.8 XHigh",
    provider: "MODEL_PROVIDER_ANTHROPIC",
    cost: "MODEL_COST_TIER_HIGH",
    source: "fallback",
    note: "静态 fallback；当前 IDE 模型缓存不可读时使用",
  },
  {
    uid: "kimi-k2-6",
    label: "Kimi K2.6",
    provider: "MODEL_PROVIDER_MOONSHOT",
    cost: "MODEL_COST_TIER_LOW",
    source: "fallback",
    note: "静态探索 fallback；使用前仍以 LS 实际接受为准",
  },
  {
    uid: "gemini-3-5-flash-medium",
    label: "Gemini 3.5 Flash Medium",
    provider: "MODEL_PROVIDER_GOOGLE",
    cost: "MODEL_COST_TIER_MEDIUM",
    source: "fallback",
    note: "静态破局 fallback；使用前仍以 LS 实际接受为准",
  },
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeProfileName(profile) {
  const raw = String(profile || "").trim().toLowerCase();
  return PROFILE_ALIASES[raw] || raw || null;
}

function modelUid(raw) {
  return raw?.modelUid || raw?.uid || raw?.id || raw?.modelOrAlias?.model || raw?.modelInfo?.modelUid || null;
}

function modelLabel(raw, uid) {
  return raw?.label || raw?.displayName || raw?.name || raw?.modelFamilyMetadata?.modelFamilyLabel || uid;
}

function modelCost(raw) {
  return raw?.modelCostTier || raw?.cost || raw?.costTier || raw?.pricingTier || null;
}

function normalizeProvider(raw) {
  return raw?.provider || raw?.modelInfo?.provider || null;
}

function normalizeModel(raw, source) {
  const uid = modelUid(raw);
  if (!uid) return null;
  const features = raw?.modelInfo?.modelFeatures || {};
  return {
    uid,
    label: modelLabel(raw, uid),
    provider: normalizeProvider(raw),
    cost: modelCost(raw),
    credit_multiplier: raw?.creditMultiplier ?? null,
    max_tokens: raw?.maxTokens || raw?.modelInfo?.maxTokens || null,
    max_output_tokens: raw?.modelInfo?.maxOutputTokens || null,
    supports_images: Boolean(raw?.supportsImages ?? features.supportsImages),
    supports_tool_calls: Boolean(features.supportsToolCalls ?? raw?.supportsToolCalls),
    supports_thinking: Boolean(features.supportsThinking ?? raw?.supportsThinking),
    recommended: Boolean(raw?.isRecommended || raw?.recommended),
    family: raw?.modelInfo?.modelFamilyUid || raw?.modelFamilyMetadata?.modelFamilyLabel || null,
    source,
  };
}

function uniqueModels(models) {
  const byUid = new Map();
  for (const model of models) {
    if (!model?.uid) continue;
    const key = model.uid.toLowerCase();
    const existing = byUid.get(key);
    if (!existing || existing.source !== "cached") {
      byUid.set(key, model);
    }
  }
  return [...byUid.values()];
}

function sortModels(models) {
  return [...models].sort((left, right) => {
    const recommended = Number(Boolean(right.recommended)) - Number(Boolean(left.recommended));
    if (recommended) return recommended;
    const cost = (COST_ORDER[left.cost] ?? 9) - (COST_ORDER[right.cost] ?? 9);
    if (cost) return cost;
    return String(left.label || left.uid).localeCompare(String(right.label || right.uid));
  });
}

function modelIndex(models) {
  const index = new Map();
  for (const model of models) {
    index.set(model.uid.toLowerCase(), model);
  }
  return index;
}

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function inferFamily(model) {
  const uid = String(model.uid || "").toLowerCase();
  const label = String(model.label || "").toLowerCase();
  const raw = String(model.family || "").trim();
  const text = `${uid} ${label} ${raw}`.toLowerCase();
  if (text.includes("claude") || text.includes("anthropic") || text.includes("opus") || text.includes("sonnet") || text.includes("fable")) return "Claude";
  if (text.includes("gpt") || text.includes("openai")) return "GPT";
  if (text.includes("gemini") || text.includes("google")) return "Gemini";
  if (text.includes("glm") || text.includes("zhipu") || text.includes("zai")) return "GLM";
  if (text.includes("kimi") || text.includes("moonshot")) return "Kimi";
  if (text.includes("deepseek")) return "DeepSeek";
  if (text.includes("minimax")) return "Minimax";
  if (text.includes("adaptive") || text.includes("arena") || text.includes("windsurf")) return "Windsurf";
  if (text.includes("swe")) return "SWE";
  if (text.includes("grok") || text.includes("xai")) return "Grok";
  if (text.includes("qwen")) return "Qwen";
  if (text.includes("llama")) return "Llama";
  return raw || model.provider || "Other";
}

function familyKey(name) {
  return normalizeSearchText(name);
}

function familySummary(familyName, models) {
  const sorted = sortModels(models);
  return {
    family: familyName,
    key: familyKey(familyName),
    count: sorted.length,
    first_available: sorted[0]?.uid || null,
    sample_models: sorted.slice(0, 5).map((model) => ({
      uid: model.uid,
      label: model.label,
      source: model.source,
      supports_images: model.supports_images,
      cost: model.cost,
    })),
  };
}

export function getModelFamilies(catalog, { limit = 5 } = {}) {
  const groups = new Map();
  for (const model of catalog.available || []) {
    const family = inferFamily(model);
    groups.set(family, [...(groups.get(family) || []), model]);
  }
  return [...groups.entries()]
    .map(([family, models]) => familySummary(family, models))
    .map((entry) => ({
      ...entry,
      sample_models: entry.sample_models.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 5),
    }))
    .sort((left, right) => left.family.localeCompare(right.family));
}

function modelMatchesQuery(model, query) {
  const compactQuery = normalizeSearchText(query);
  if (!compactQuery) return true;
  const family = inferFamily(model);
  const searchFields = [
    model.uid,
    model.label,
    model.provider,
    model.family,
    family,
  ];
  return searchFields.some((field) => {
    const raw = String(field || "").toLowerCase();
    return raw.includes(String(query || "").toLowerCase()) || normalizeSearchText(raw).includes(compactQuery);
  });
}

export async function queryModels({ query, refresh = false, limit = 30 } = {}) {
  const catalog = await getModelCatalog({ refresh });
  const max = Number(limit);
  const matches = sortModels((catalog.available || []).filter((model) => modelMatchesQuery(model, query)))
    .slice(0, Number.isFinite(max) && max > 0 ? max : 30)
    .map((model) => ({
      uid: model.uid,
      label: model.label,
      family: inferFamily(model),
      provider: model.provider,
      cost: model.cost,
      source: model.source,
      supports_images: model.supports_images,
      supports_tool_calls: model.supports_tool_calls,
      supports_thinking: model.supports_thinking,
      max_tokens: model.max_tokens,
    }));
  return {
    ...catalog,
    query: String(query || ""),
    matches,
    match_count: matches.length,
  };
}

async function readCachedCascadeModels(errors) {
  try {
    const result = await callResolvedLanguageServer({
      method: "GetUserSettings",
      payload: {},
      retries: 0,
      timeoutMs: 15000,
    });
    const settings = result.body?.userSettings || result.body?.settings || result.body || {};
    const configs = settings.cachedCascadeModelConfigs || result.body?.cachedCascadeModelConfigs || [];
    if (!Array.isArray(configs)) return [];
    return configs.map((item) => normalizeModel(item, "cached")).filter(Boolean);
  } catch (error) {
    errors.push({ source: "cached", method: "GetUserSettings", error: error.message });
    return [];
  }
}

async function readCommandModels(errors) {
  try {
    const result = await callResolvedLanguageServer({
      method: "GetCommandModelConfigs",
      payload: { metadata: await createMetadata() },
      retries: 0,
      timeoutMs: 15000,
    });
    const configs = result.body?.clientModelConfigs || result.body?.modelConfigs || result.body?.commandModelConfigs || result.body?.models || [];
    if (!Array.isArray(configs)) return [];
    return configs.map((item) => normalizeModel(item, "command")).filter(Boolean);
  } catch (error) {
    errors.push({ source: "command", method: "GetCommandModelConfigs", error: error.message });
    return [];
  }
}

export async function getModelCatalog({ refresh = false } = {}) {
  if (!refresh && cachedCatalog && Date.now() - cachedCatalog.loadedAtMs < CACHE_TTL_MS) {
    return cachedCatalog.value;
  }

  const errors = [];
  const cached = await readCachedCascadeModels(errors);
  const command = await readCommandModels(errors);
  const fallback = FALLBACK_MODELS.map((item) => normalizeModel(item, item.source)).filter(Boolean);
  const models = sortModels(uniqueModels([...cached, ...command, ...fallback]));
  const value = {
    updated_at: nowIso(),
    sources: {
      cached: { count: cached.length, method: "GetUserSettings.cachedCascadeModelConfigs" },
      command: { count: command.length, method: "GetCommandModelConfigs.clientModelConfigs" },
      fallback: { count: fallback.length, method: "static-profile-fallback" },
      errors,
    },
    available: models,
  };
  cachedCatalog = { loadedAtMs: Date.now(), value };
  return value;
}

function resolveCandidate(spec, index, includeUnverified) {
  const model = index.get(String(spec.uid || "").toLowerCase());
  if (model) {
    return {
      ...model,
      profile_note: spec.note || null,
      available: true,
    };
  }
  if (!includeUnverified && spec.source === "unverified") return null;
  return {
    uid: spec.uid,
    label: spec.label || spec.uid,
    provider: spec.provider || null,
    cost: null,
    max_tokens: null,
    supports_images: false,
    supports_tool_calls: false,
    supports_thinking: false,
    recommended: false,
    source: spec.source || "unverified",
    profile_note: spec.note || "当前模型缓存未发现该模型",
    available: false,
  };
}

export async function getModelProfiles({ purpose, refresh = false, include_unverified = false } = {}) {
  const catalog = await getModelCatalog({ refresh });
  const index = modelIndex(catalog.available);
  const selected = normalizeProfileName(purpose);
  const entries = Object.entries(PROFILE_DEFINITIONS)
    .filter(([name]) => !selected || name === selected)
    .map(([name, definition]) => {
      const candidates = definition.candidates
        .map((candidate) => resolveCandidate(candidate, index, include_unverified))
        .filter(Boolean);
      const firstAvailable = candidates.find((candidate) => candidate.available !== false) || null;
      return {
        name,
        description: definition.description,
        aliases: Object.entries(PROFILE_ALIASES)
          .filter(([, target]) => target === name)
          .map(([alias]) => alias),
        first_available: firstAvailable?.uid || null,
        candidates,
      };
    });
  return {
    ...catalog,
    profiles: Object.fromEntries(entries.map((entry) => [entry.name, entry])),
    fallback_policy: "Exact model wins when available; otherwise use model_profile first available candidate; otherwise use default model/fallback.",
  };
}

export async function resolveModelSelection({ model, model_profile, refresh = false } = {}) {
  const requestedModel = String(model || "").trim();
  const profile = normalizeProfileName(model_profile);
  const catalog = await getModelCatalog({ refresh });
  const index = modelIndex(catalog.available);
  const fallbackChain = [];

  if (requestedModel) {
    const exact = index.get(requestedModel.toLowerCase());
    fallbackChain.push({ uid: requestedModel, source: exact?.source || "requested", available: Boolean(exact) });
    if (exact) {
      return {
        model_requested: requestedModel,
        model_profile: profile,
        model_resolved: exact.uid,
        model_source: exact.source,
        model_note: "exact model is available",
        model_fallback_chain: fallbackChain,
        catalog,
      };
    }
  }

  if (profile && PROFILE_DEFINITIONS[profile]) {
    const profiles = await getModelProfiles({ purpose: profile, refresh });
    const profileEntry = profiles.profiles[profile];
    const candidates = profileEntry?.candidates || [];
    for (const candidate of candidates) {
      fallbackChain.push({ uid: candidate.uid, source: candidate.source, available: candidate.available !== false });
    }
    const selected = candidates.find((candidate) => candidate.available !== false);
    if (selected) {
      return {
        model_requested: requestedModel || null,
        model_profile: profile,
        model_resolved: selected.uid,
        model_source: selected.source,
        model_note: requestedModel
          ? `requested model was unavailable; fell back to profile ${profile}`
          : `resolved from profile ${profile}`,
        model_fallback_chain: fallbackChain,
        catalog,
      };
    }
  }

  const defaultModel = index.get(DEFAULT_MODEL.toLowerCase()) || FALLBACK_MODELS[0];
  fallbackChain.push({ uid: DEFAULT_MODEL, source: defaultModel.source || "fallback", available: Boolean(index.get(DEFAULT_MODEL.toLowerCase())) });
  return {
    model_requested: requestedModel || null,
    model_profile: profile,
    model_resolved: defaultModel.uid || DEFAULT_MODEL,
    model_source: defaultModel.source || "fallback",
    model_note: requestedModel || profile
      ? "requested model/profile was unavailable; fell back to default model"
      : "default model",
    model_fallback_chain: fallbackChain,
    catalog,
  };
}
