import { createHash } from 'node:crypto';
import {
  antigravityFailure,
  type AntigravityCatalog,
  type AntigravityModel,
  type AntigravitySelection,
} from './antigravity-types.js';

type JsonObject = Record<string, unknown>;

const LEGACY_MODELS = [
  ['MODEL_PLACEHOLDER_M132', 'Gemini 3.5 Flash (High)'],
  ['MODEL_PLACEHOLDER_M20', 'Gemini 3.5 Flash (Medium)'],
  ['MODEL_PLACEHOLDER_M18', 'Gemini 3 Flash'],
  ['MODEL_PLACEHOLDER_M16', 'Gemini 3.1 Pro (High)'],
  ['MODEL_PLACEHOLDER_M36', 'Gemini 3.1 Pro (Low)'],
] as const;

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function enumValue(value: unknown): string | undefined {
  const candidate = textValue(value);
  if (!candidate) return undefined;
  if (/^M\d+$/i.test(candidate)) return `MODEL_PLACEHOLDER_${candidate.toUpperCase()}`;
  return /^MODEL_[A-Z0-9_]+$/.test(candidate)
    && !/^MODEL_(?:UNSPECIFIED|UNKNOWN|UNDEFINED)$/.test(candidate)
    ? candidate
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveFlag(value: unknown): boolean {
  return value === true || value === 1 || value === 'true';
}

function negativeFlag(value: unknown): boolean {
  return value === false || value === 0 || value === 'false';
}

function quotaValue(value: JsonObject): number | undefined {
  const quota = objectValue(value.quotaInfo) ?? objectValue(value.quota);
  for (const candidate of [
    quota?.remainingFraction,
    quota?.remaining,
    quota?.remainingCredits,
    value.quotaRemaining,
    value.remainingFraction,
    value.quota,
  ]) {
    const remaining = numberValue(candidate);
    if (remaining !== undefined) return remaining;
  }
  return undefined;
}

export type AntigravityModelPurpose = 'material' | 'visual-review';

function modelProfile(label: string): { family: string; effort: string; slug: string } | undefined {
  const match = /^Gemini\s+(\d+(?:\.\d+)?)\s+(Hydrogen|Carbon)\s*(?:\((XHigh|High|Medium|Low)\)|(XHigh|High|Medium|Low))(?:\s*\(Limited Time\))?$/iu.exec(label);
  if (!match) return undefined;
  const family = match[2].toLowerCase();
  const effort = (match[3] ?? match[4]).toLowerCase();
  return { family, effort, slug: `gemini-${match[1]}-${family}-${effort}` };
}

export function getAntigravityModelCandidates(
  catalog: AntigravityCatalog,
  purpose: AntigravityModelPurpose = 'material',
): AntigravityModel[] {
  if (!catalog.modern) return catalog.models.slice();
  const preferences = purpose === 'visual-review'
    ? ['carbon-high']
    : ['hydrogen-xhigh', 'hydrogen-high', 'carbon-high'];
  return catalog.models.map(model => {
    const profile = modelProfile(model.label);
    return { model, rank: profile ? preferences.indexOf(`${profile.family}-${profile.effort}`) : -1 };
  }).filter(candidate => candidate.rank >= 0)
    .sort((left, right) => left.rank - right.rank)
    .map(candidate => candidate.model);
}

export function getAntigravityCapacityCandidates(
  catalog: AntigravityCatalog,
  selected: AntigravityModel,
  purpose: AntigravityModelPurpose = 'material',
): AntigravityModel[] {
  const ranked = getAntigravityModelCandidates(catalog, purpose);
  const selectedIndex = ranked.findIndex(model => model.id === selected.id);
  if (selectedIndex < 0) return [selected];
  const candidates = [selected, ...ranked.slice(selectedIndex + 1)
    .filter(model => !model.disabled && (model.quotaRemaining === undefined || model.quotaRemaining > 0))];
  return candidates.filter((model, index) => candidates.findIndex(candidate => candidate.id === model.id) === index);
}

function parseModel(
  value: unknown,
  key: string | undefined,
  teamsTier: string | undefined,
  accountQuota: number | undefined,
  modelFormat: 'rpc' | 'agent' = 'rpc',
): AntigravityModel | undefined {
  const outer = objectValue(value);
  const nested = objectValue(outer?.modelConfig) ?? objectValue(outer?.config);
  const entry = outer ? { ...nested, ...outer } : typeof value === 'string' && enumValue(key)
    ? { model: key, label: value } as JsonObject
    : undefined;
  if (!entry) return undefined;
  const alias = objectValue(entry.modelOrAlias);
  const modelObject = objectValue(entry.model);
  const id = modelFormat === 'agent' ? textValue(entry.modelId) : [
    alias?.model,
    alias?.alias,
    entry.modelOrAlias,
    modelObject?.model,
    modelObject?.id,
    entry.model,
    entry.id,
    entry.modelId,
    key,
  ].map(enumValue).find(candidate => candidate !== undefined);
  if (!id) return undefined;
  const label = textValue(entry.label) ?? textValue(entry.displayName) ?? textValue(entry.name) ?? id;
  const modelId = textValue(entry.modelId);
  const profile = modelProfile(label);
  const allowedTiers = Array.isArray(entry.allowedTiers)
    ? entry.allowedTiers.map(tier => textValue(tier) ?? textValue(objectValue(tier)?.id)).filter(Boolean)
    : [];
  const tierDenied = teamsTier !== undefined && allowedTiers.length > 0 && !allowedTiers.includes(teamsTier);
  const disabled = (entry.disabled !== undefined && !negativeFlag(entry.disabled))
    || ['enabled', 'isEnabled', 'available', 'isAvailable', 'allowed', 'isAllowed', 'canUse']
      .some(field => negativeFlag(entry[field]))
    || positiveFlag(entry.accessDenied)
    || tierDenied;
  const mimeTypes = objectValue(entry.supportedMimeTypes);
  const supportsImages = entry.supportsImages !== undefined
    ? positiveFlag(entry.supportsImages)
    : mimeTypes !== undefined && Object.entries(mimeTypes)
      .some(([mimeType, supported]) => mimeType.startsWith('image/') && positiveFlag(supported));
  const description = tierDenied
    ? '当前账号套餐无权使用此模型'
    : textValue(entry.tagDescription) ?? textValue(entry.description);
  const quotaRemaining = quotaValue(entry) ?? accountQuota;
  return {
    id,
    label,
    ...(modelId !== undefined ? { modelId } : {}),
    disabled,
    supportsImages,
    ...(profile !== undefined ? { family: profile.family } : {}),
    ...(quotaRemaining !== undefined ? { quotaRemaining } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function configEntries(container: unknown, depth = 0, seen = new Set<object>()): Array<[string | undefined, unknown]> {
  if (depth > 5 || container === null || typeof container !== 'object' || seen.has(container)) return [];
  seen.add(container);
  if (Array.isArray(container)) return container.map(value => [undefined, value]);
  const record = container as JsonObject;
  for (const wrapper of ['clientModelConfigs', 'modelConfigs', 'configs', 'models']) {
    if (record[wrapper] !== undefined) return configEntries(record[wrapper], depth + 1, seen);
  }
  if (record.modelOrAlias !== undefined || record.model !== undefined || record.modelConfig !== undefined) {
    return [[undefined, record]];
  }
  return Object.entries(record);
}

function statusValue(raw: unknown): JsonObject | undefined {
  const root = objectValue(raw);
  if (!root) return undefined;
  for (const wrapper of [root, objectValue(root.result), objectValue(root.data)]) {
    if (wrapper?.userStatus !== undefined) return objectValue(wrapper.userStatus);
  }
  return root;
}

function accountKey(status: JsonObject): string | undefined {
  const account = objectValue(status.account);
  const user = objectValue(status.user);
  const identities = [
    status.accountId,
    status.userId,
    status.uid,
    status.email,
    account?.id,
    account?.accountId,
    account?.email,
    user?.id,
    user?.email,
  ].map(value => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : textValue(value))
    .filter((identity): identity is string => identity !== undefined);
  return identities.length > 0
    ? `sha256:${createHash('sha256').update(JSON.stringify(identities)).digest('hex')}`
    : undefined;
}

function addCatalogModel(models: Map<string, AntigravityModel>, model: AntigravityModel): void {
  const existing = models.get(model.id);
  if (!existing) {
    models.set(model.id, model);
    return;
  }
  const quotas = [existing.quotaRemaining, model.quotaRemaining]
    .filter((quota): quota is number => quota !== undefined);
  models.set(model.id, {
    ...existing,
    disabled: existing.disabled || model.disabled || existing.label !== model.label
      || (existing.modelId !== undefined && model.modelId !== undefined && existing.modelId !== model.modelId),
    supportsImages: existing.supportsImages && model.supportsImages,
    ...(existing.modelId === undefined && model.modelId !== undefined ? { modelId: model.modelId } : {}),
    ...(quotas.length > 0 ? { quotaRemaining: Math.min(...quotas) } : {}),
  });
}

export function parseAntigravityAgentCatalog(availableModels: unknown): AntigravityCatalog {
  if (!Array.isArray(availableModels)) return { models: [], modern: false };
  const models = new Map<string, AntigravityModel>();
  for (const entry of availableModels) {
    const model = parseModel(entry, undefined, undefined, undefined, 'agent');
    if (model) addCatalogModel(models, model);
  }
  return { models: [...models.values()], modern: true };
}

export function parseAntigravityCatalog(raw: unknown): AntigravityCatalog {
  const status = statusValue(raw);
  if (!status) return { models: [], modern: false };
  const plan = objectValue(objectValue(status.planStatus)?.planInfo);
  const userTier = objectValue(status.userTier);
  const teamsTier = textValue(plan?.teamsTier) ?? textValue(userTier?.teamsTier) ?? textValue(status.teamsTier);
  const tier = textValue(userTier?.name) ?? textValue(status.userTier) ?? textValue(plan?.planName) ?? teamsTier;
  const configData = objectValue(status.cascadeModelConfigData) ?? objectValue(status.modelConfigData);
  const containers = [
    configData?.clientModelConfigs,
    configData?.modelConfigs,
    status.clientModelConfigs,
    status.modelConfigs,
  ];
  const models = new Map<string, AntigravityModel>();
  let emptyDirectory = false;
  for (const container of containers) {
    if (Array.isArray(container) && container.length === 0) emptyDirectory = true;
    for (const [key, value] of configEntries(container)) {
      const model = parseModel(value, key, teamsTier, quotaValue(status));
      if (!model) continue;
      addCatalogModel(models, model);
    }
  }
  const key = accountKey(status);
  return {
    models: [...models.values()],
    modern: models.size > 0 || emptyDirectory,
    ...(key !== undefined ? { accountKey: key } : {}),
    ...(tier !== undefined ? { tier } : {}),
  };
}

function selectedModel(model: AntigravityModel): AntigravitySelection {
  if (model.disabled) {
    return { error: antigravityFailure('rejected', 'Antigravity 模型已禁用或当前账号无权使用', null, model.id) };
  }
  if (model.quotaRemaining !== undefined && model.quotaRemaining <= 0) {
    return { error: antigravityFailure('quota-exhausted', 'Antigravity 模型额度已耗尽', null, model.id) };
  }
  return { model };
}

export function selectAntigravityModel(
  catalog: AntigravityCatalog,
  explicit?: string,
  purpose: AntigravityModelPurpose = 'material',
): AntigravitySelection {
  if (explicit !== undefined) {
    const requested = explicit.trim();
    const id = enumValue(requested);
    let matches = catalog.models.filter(candidate => id !== undefined
      ? candidate.id === id || enumValue(candidate.id) === id
      : candidate.id === requested || candidate.modelId === requested || candidate.label === requested);
    if (matches.length === 0 && id === undefined) {
      const alias = /^(hydrogen|carbon)(?:-(xhigh|high))?$/u.exec(requested);
      if (alias) {
        const efforts = alias[2] ? [alias[2]] : alias[1] === 'hydrogen' ? ['xhigh', 'high'] : ['high'];
        for (const effort of efforts) {
          matches = catalog.models.filter(candidate => {
            const profile = modelProfile(candidate.label);
            return profile?.family === alias[1] && profile.effort === effort;
          });
          if (matches.length > 0) break;
        }
      } else {
        matches = catalog.models.filter(candidate => modelProfile(candidate.label)?.slug === requested);
      }
    }
    if (matches.length > 1) {
      return { error: antigravityFailure('invalid-response', '显式 Antigravity 模型名称在当前目录中存在歧义') };
    }
    const model = matches[0];
    if (!model) {
      return { error: antigravityFailure('rejected', '显式 Antigravity 模型不在当前目录中') };
    }
    return selectedModel(model);
  }
  if (catalog.models.length === 0) {
    return { error: antigravityFailure('invalid-response', 'Antigravity 未返回可识别的模型目录，无法选择默认模型') };
  }
  if (!catalog.modern) {
    const model = catalog.models.find(candidate => !candidate.disabled) ?? catalog.models[0];
    return selectedModel(model);
  }
  const candidates = getAntigravityModelCandidates(catalog, purpose);
  const model = candidates.find(candidate => !candidate.disabled) ?? candidates[0];
  return model
    ? selectedModel(model)
    : { error: antigravityFailure('rejected', `当前目录缺少已授权的 ${purpose === 'visual-review' ? 'Carbon High' : 'Hydrogen XHigh/High 或 Carbon High'} 模型`) };
}

export function legacyAntigravityCatalog(): AntigravityCatalog {
  return {
    modern: false,
    models: LEGACY_MODELS.map(([id, label]) => ({
      id,
      label,
      disabled: false,
      supportsImages: false,
      family: label.includes('Flash') ? 'legacy-gemini-flash' : 'legacy-gemini-pro',
    })),
  };
}
