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

function flashRank(label: string): number | undefined {
  const match = /^Gemini\s+3\.8\s+Flash\s*(?:\((High|Medium|Low)\)|(High|Medium|Low))$/i.exec(label);
  if (!match) return undefined;
  return ['high', 'medium', 'low'].indexOf((match[1] ?? match[2]).toLowerCase());
}

function parseModel(
  value: unknown,
  key: string | undefined,
  teamsTier: string | undefined,
  accountQuota: number | undefined,
): AntigravityModel | undefined {
  const outer = objectValue(value);
  const nested = objectValue(outer?.modelConfig) ?? objectValue(outer?.config);
  const entry = outer ? { ...nested, ...outer } : typeof value === 'string' && enumValue(key)
    ? { model: key, label: value } as JsonObject
    : undefined;
  if (!entry) return undefined;
  const alias = objectValue(entry.modelOrAlias);
  const modelObject = objectValue(entry.model);
  const id = [
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
    disabled,
    supportsImages,
    ...(flashRank(label) !== undefined ? { family: 'gemini-3.8-flash' } : {}),
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
      const existing = models.get(model.id);
      if (existing) {
        const quotas = [existing.quotaRemaining, model.quotaRemaining]
          .filter((quota): quota is number => quota !== undefined);
        models.set(model.id, {
          ...existing,
          disabled: existing.disabled || model.disabled || existing.label !== model.label,
          supportsImages: existing.supportsImages && model.supportsImages,
          ...(quotas.length > 0 ? { quotaRemaining: Math.min(...quotas) } : {}),
        });
      } else models.set(model.id, model);
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

export function selectAntigravityModel(catalog: AntigravityCatalog, explicit?: string): AntigravitySelection {
  if (explicit !== undefined) {
    const requested = explicit.trim();
    const id = enumValue(requested);
    const matches = catalog.models.filter(candidate => id !== undefined ? candidate.id === id : candidate.label === requested);
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
  const candidates = catalog.models
    .filter(candidate => flashRank(candidate.label) !== undefined)
    .slice()
    .sort((left, right) => (flashRank(left.label)! - flashRank(right.label)!)
      || Number(right.id === 'MODEL_PLACEHOLDER_M318') - Number(left.id === 'MODEL_PLACEHOLDER_M318'));
  const model = candidates.find(candidate => !candidate.disabled) ?? candidates[0];
  return model
    ? selectedModel(model)
    : { error: antigravityFailure('rejected', '当前目录缺少已授权的 Gemini 3.8 Flash 默认模型及同族备选') };
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
