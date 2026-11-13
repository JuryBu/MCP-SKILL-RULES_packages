import assert from 'node:assert/strict';
import test from 'node:test';
import {
  legacyAntigravityCatalog,
  parseAntigravityCatalog,
  selectAntigravityModel,
} from '../src/antigravity-models.ts';

const currentModels = [
  ['Gemini 4 Carbon (Medium)', 'gemini-4-carbon-medium', 'M437'],
  ['Gemini 4 Carbon (High)', 'gemini-4-carbon-high', 'M427'],
  ['Gemini 4 Carbon (Low)', 'gemini-4-carbon-low', 'M438'],
  ['Gemini 4 Argon (Medium)', 'gemini-4-argon-medium', 'M418'],
  ['Gemini 4 Argon (High)', 'gemini-4-argon-high', 'M417'],
  ['Gemini 4 Argon (Low)', 'gemini-4-argon-low', 'M419'],
  ['Gemini 4 Hydrogen (High)', 'gemini-4-hydrogen-high', 'M525'],
  ['Gemini 4 Hydrogen (XHigh)', 'gemini-4-hydrogen-xhigh', 'M528'],
  ['Gemini 4 Hydrogen (Medium)', 'gemini-4-hydrogen-medium', 'M526'],
  ['Gemini 4 Hydrogen (Low)', 'gemini-4-hydrogen-low', 'M527'],
  ['Orchestrator (Carbon)', 'gemini-pro-orchestrator', 'M667'],
  ['Orchestrator (Argon)', 'gemini-pro-orchestrator-argon', 'M681'],
  ['Gemini 3.8 Flash (High)', 'gemini-3.8-flash-high', 'M318'],
  ['Gemini 3.8 Flash (Medium)', 'gemini-3.8-flash-medium', 'M319'],
  ['Gemini 3.8 Flash (Low)', 'gemini-3.8-flash-low', 'M320'],
  ['Claude Opus 5.5 (Low)', 'claude-opus-5-5-low', 'M400'],
  ['Claude Opus 5.5 (Medium)', 'claude-opus-5-5-medium', 'M401'],
  ['Claude Opus 5.5 (High)', 'claude-opus-5-5-high', 'M402'],
  ['Claude Sonnet 5.5 (Low)', 'claude-sonnet-5-5-low', 'M403'],
  ['Claude Sonnet 5.5 (Medium)', 'claude-sonnet-5-5-medium', 'M404'],
  ['Claude Sonnet 5.5 (High)', 'claude-sonnet-5-5-high', 'M405'],
  ['GPT-OSS 120B (Medium)', 'gpt-oss-120b-medium', 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM'],
];

function modelEntry([label, modelId, model], overrides = {}) {
  return {
    label,
    modelId,
    modelOrAlias: { model: model.startsWith('MODEL_') ? model : `MODEL_PLACEHOLDER_${model}` },
    disabled: false,
    supportsImages: true,
    allowedTiers: ['TEAMS_TIER_PRO', 'TEAMS_TIER_PRO_ULTIMATE'],
    quotaInfo: { remainingFraction: 0.9675812, resetTime: '2026-11-13T08:00:00Z' },
    ...overrides,
  };
}

function statusFixture(entries = currentModels.map(entry => modelEntry(entry)), overrides = {}) {
  return {
    userStatus: {
      email: 'fixture-account-a@example.invalid',
      userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO_ULTIMATE', planName: 'Ultra' } },
      cascadeModelConfigData: { clientModelConfigs: entries },
      ...overrides,
    },
  };
}

function assertFailure(selection, outcome, model = null) {
  assert.equal(selection.model, undefined);
  assert.equal(selection.error?.outcome, outcome);
  assert.equal(selection.error?.model, model);
  assert.equal(selection.error?.text, null);
  assert.equal(selection.error?.transport, null);
  assert.equal(selection.error?.submitted, false);
  assert.equal(selection.error?.safeToFallback, false);
  assert.ok(selection.error?.error);
}

test('22-model current status maps aliases to RPC enums and defaults to Flash 3.8 High', () => {
  const raw = statusFixture();
  const snapshot = structuredClone(raw);
  const catalog = parseAntigravityCatalog(raw);
  assert.equal(catalog.modern, true);
  assert.equal(catalog.models.length, 22);
  assert.equal(catalog.tier, 'Google AI Ultra');
  assert.equal(selectAntigravityModel(catalog).model?.id, 'MODEL_PLACEHOLDER_M318');
  assert.equal(catalog.models.find(model => model.id === 'MODEL_PLACEHOLDER_M318')?.quotaRemaining, 0.9675812);
  assert.equal(catalog.models.at(-1)?.id, 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
  assert.equal(catalog.models.every(model => model.supportsImages), true);
  assert.deepEqual(raw, snapshot);
});

test('21-model current status preserves the same default after GPT-OSS removal', () => {
  const catalog = parseAntigravityCatalog(statusFixture(currentModels.slice(0, 21).map(entry => modelEntry(entry))));
  assert.equal(catalog.modern, true);
  assert.equal(catalog.models.length, 21);
  assert.equal(selectAntigravityModel(catalog).model?.id, 'MODEL_PLACEHOLDER_M318');
});

test('explicit shorthand, RPC enum and actual labels match exactly without fuzzy substitution', () => {
  const catalog = parseAntigravityCatalog(statusFixture());
  for (const explicit of ['M402', 'MODEL_PLACEHOLDER_M402', 'Claude Opus 5.5 (High)']) {
    assert.equal(selectAntigravityModel(catalog, explicit).model?.id, 'MODEL_PLACEHOLDER_M402');
  }
  assert.equal(selectAntigravityModel(catalog, 'GPT-OSS 120B (Medium)').model?.id, 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
  for (const explicit of ['M99999', 'Opus', 'Claude Opus 5.5', 'claude opus 5.5 (high)', 'gemini-3.8-flash-high', '']) {
    assertFailure(selectAntigravityModel(catalog, explicit), 'rejected');
  }
});

test('disabled explicit requests are rejected and an unavailable High default selects authorized Medium', () => {
  const entries = currentModels.map(entry => modelEntry(entry, entry[2] === 'M318' ? { disabled: true } : {}));
  const catalog = parseAntigravityCatalog(statusFixture(entries));
  assertFailure(selectAntigravityModel(catalog, 'M318'), 'rejected', 'MODEL_PLACEHOLDER_M318');
  assertFailure(selectAntigravityModel(catalog, 'Gemini 3.8 Flash (High)'), 'rejected', 'MODEL_PLACEHOLDER_M318');
  assert.equal(selectAntigravityModel(catalog).model?.id, 'MODEL_PLACEHOLDER_M319');
});

test('duplicate labels are ambiguous and an enum-looking label never shadows an actual enum', () => {
  const entries = [
    modelEntry(currentModels[12]),
    modelEntry(['Gemini 3.8 Flash (High)', 'alternate-flash', 'M999']),
    modelEntry(['M318', 'misleading-label', 'M998']),
  ];
  const catalog = parseAntigravityCatalog(statusFixture(entries));
  assertFailure(selectAntigravityModel(catalog, 'Gemini 3.8 Flash (High)'), 'invalid-response');
  assert.equal(selectAntigravityModel(catalog, 'M318').model?.id, 'MODEL_PLACEHOLDER_M318');
  assert.equal(selectAntigravityModel(catalog).model?.id, 'MODEL_PLACEHOLDER_M318');
});

test('missing default chooses only returned Flash 3.8 siblings and never Claude, Hydrogen or Orchestrator', () => {
  const withoutHigh = currentModels.filter(entry => entry[2] !== 'M318').map(entry => modelEntry(entry));
  assert.equal(selectAntigravityModel(parseAntigravityCatalog(statusFixture(withoutHigh))).model?.id, 'MODEL_PLACEHOLDER_M319');
  const onlyLow = currentModels.filter(entry => !['M318', 'M319'].includes(entry[2])).map(entry => modelEntry(entry));
  assert.equal(selectAntigravityModel(parseAntigravityCatalog(statusFixture(onlyLow))).model?.id, 'MODEL_PLACEHOLDER_M320');
  const noFlash = currentModels.filter(entry => !['M318', 'M319', 'M320'].includes(entry[2])).map(entry => modelEntry(entry));
  assertFailure(selectAntigravityModel(parseAntigravityCatalog(statusFixture(noFlash))), 'rejected');
  const misleadingEnum = [modelEntry(['Gemini 4 Hydrogen (High)', 'gemini-4-hydrogen-high', 'M318'])];
  assertFailure(selectAntigravityModel(parseAntigravityCatalog(statusFixture(misleadingEnum))), 'rejected');
});

test('all Flash models disabled fail explicitly without selecting another family', () => {
  const entries = currentModels.map(entry => modelEntry(entry, entry[0].includes('Flash') ? { disabled: true } : {}));
  assertFailure(selectAntigravityModel(parseAntigravityCatalog(statusFixture(entries))), 'rejected', 'MODEL_PLACEHOLDER_M318');
});

test('zero quota is preserved for explicit and default selection without changing models', () => {
  for (const quotaInfo of [{ remainingFraction: 0 }, { remainingFraction: '0' }, { remaining: 0 }]) {
    const entries = currentModels.map(entry => modelEntry(entry, entry[2] === 'M318' ? { quotaInfo } : {}));
    const catalog = parseAntigravityCatalog(statusFixture(entries));
    assert.equal(catalog.models.find(model => model.id === 'MODEL_PLACEHOLDER_M318')?.quotaRemaining, 0);
    assertFailure(selectAntigravityModel(catalog, 'M318'), 'quota-exhausted', 'MODEL_PLACEHOLDER_M318');
    assertFailure(selectAntigravityModel(catalog), 'quota-exhausted', 'MODEL_PLACEHOLDER_M318');
  }
});

test('empty quota information stays unknown, while legacy numeric quota and account quota zero are honored', () => {
  const entry = modelEntry(currentModels[12], { quotaInfo: {} });
  const unknown = parseAntigravityCatalog(statusFixture([entry]));
  assert.equal(unknown.models[0].quotaRemaining, undefined);
  assert.ok(selectAntigravityModel(unknown).model);
  const numeric = parseAntigravityCatalog(statusFixture([{ ...entry, quota: 0 }]));
  assertFailure(selectAntigravityModel(numeric), 'quota-exhausted', 'MODEL_PLACEHOLDER_M318');
  const accountQuota = parseAntigravityCatalog(statusFixture([entry], { quotaInfo: { remainingFraction: 0 } }));
  assertFailure(selectAntigravityModel(accountQuota), 'quota-exhausted', 'MODEL_PLACEHOLDER_M318');
});

test('known account tier restrictions and explicit admission flags are rejected', () => {
  const restricted = modelEntry(currentModels[12], { allowedTiers: ['TEAMS_TIER_ENTERPRISE_SAAS'] });
  const catalog = parseAntigravityCatalog(statusFixture([restricted]));
  assert.equal(catalog.models[0].disabled, true);
  assert.match(catalog.models[0].description, /账号套餐/);
  assertFailure(selectAntigravityModel(catalog, 'M318'), 'rejected', 'MODEL_PLACEHOLDER_M318');
  for (const denied of [{ enabled: false }, { available: false }, { canUse: false }, { accessDenied: true }]) {
    const deniedCatalog = parseAntigravityCatalog(statusFixture([modelEntry(currentModels[12], denied)]));
    assertFailure(selectAntigravityModel(deniedCatalog, 'M318'), 'rejected', 'MODEL_PLACEHOLDER_M318');
  }
});

test('account identity is hashed and reparsing the same model ID refreshes quota and account', () => {
  const first = parseAntigravityCatalog(statusFixture([modelEntry(currentModels[12])]));
  const second = parseAntigravityCatalog(statusFixture([modelEntry(currentModels[12], { quotaInfo: { remainingFraction: 0 } })], {
    email: 'fixture-account-b@example.invalid',
  }));
  assert.match(first.accountKey, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(first.accountKey, second.accountKey);
  assert.ok(!JSON.stringify(first).includes('fixture-account-a'));
  assert.ok(selectAntigravityModel(first).model);
  assertFailure(selectAntigravityModel(second), 'quota-exhausted', 'MODEL_PLACEHOLDER_M318');
  assert.equal(first.accountKey, parseAntigravityCatalog(statusFixture([modelEntry(currentModels[12])])).accountKey);
});

test('nested account IDs are hashed and names or credentials are not account identities', () => {
  const entries = [modelEntry(currentModels[12])];
  const first = parseAntigravityCatalog(statusFixture(entries, { email: undefined, account: { id: 'synthetic-account-a' } }));
  const second = parseAntigravityCatalog(statusFixture(entries, { email: undefined, account: { id: 'synthetic-account-b' } }));
  assert.notEqual(first.accountKey, second.accountKey);
  assert.ok(!JSON.stringify(first).includes('synthetic-account-a'));
  const anonymous = parseAntigravityCatalog(statusFixture(entries, { email: undefined, name: 'display only', token: 'fixture secret' }));
  assert.equal(anonymous.accountKey, undefined);
  assert.ok(!JSON.stringify(anonymous).includes('fixture secret'));
  const numeric = parseAntigravityCatalog(statusFixture(entries, { email: undefined, userId: 123456 }));
  assert.match(numeric.accountKey, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!numeric.accountKey.includes('123456'));
});

test('older keyed objects and nested modelConfig wrappers remain dynamic rather than legacy', () => {
  const variants = [
    { modelConfigs: { MODEL_PLACEHOLDER_M318: { label: 'Gemini 3.8 Flash (High)', supportsImages: true } } },
    { userStatus: { modelConfigs: { M318: { modelConfig: { label: 'Gemini 3.8 Flash (High)', quota: 0.5 } } } } },
    { userStatus: { cascadeModelConfigData: { clientModelConfigs: { models: { M318: 'Gemini 3.8 Flash (High)' } } } } },
    { data: statusFixture([modelEntry(currentModels[12])]) },
    { result: statusFixture([modelEntry(currentModels[12])]) },
    { userStatus: { modelConfigs: [{ model: { model: 'MODEL_PLACEHOLDER_M318' }, label: 'Gemini 3.8 Flash (High)' }] } },
  ];
  for (const raw of variants) {
    const catalog = parseAntigravityCatalog(raw);
    assert.equal(catalog.modern, true);
    assert.equal(catalog.models.length, 1);
    assert.equal(selectAntigravityModel(catalog).model?.id, 'MODEL_PLACEHOLDER_M318');
  }
});

test('unavailable, summary-only and malformed structures never synthesize the legacy table', () => {
  for (const raw of [undefined, null, false, 'status', [], {}, { userStatus: null },
    { error: { code: 'unimplemented' } }, { models: [{ model: 'MODEL_PLACEHOLDER_M318', label: 'Gemini 3.8 Flash (High)' }] },
    { userStatus: { modelConfigs: 'broken' } }, { userStatus: { modelConfigs: [{ modelId: 'gemini-3.8-flash-high' }] } },
    { userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'invalid', model: 318 }] } } },
  ]) {
    const catalog = parseAntigravityCatalog(raw);
    assert.equal(catalog.modern, false);
    assert.deepEqual(catalog.models, []);
    assertFailure(selectAntigravityModel(catalog), 'invalid-response');
  }
});

test('a recognized empty directory is modern but cannot choose a default', () => {
  const catalog = parseAntigravityCatalog(statusFixture([]));
  assert.equal(catalog.modern, true);
  assert.deepEqual(catalog.models, []);
  assertFailure(selectAntigravityModel(catalog), 'invalid-response');
});

test('future enum fields survive only under recognized configs and future families stay explicit', () => {
  const future = modelEntry(['Gemini 5 Future (High)', 'future-slug', 'MODEL_FUTURE_ABC'], {
    futureObject: { model: 'MODEL_PLACEHOLDER_M318' },
    futureFlag: true,
  });
  const raw = statusFixture([future]);
  raw.userStatus.unrelated = { modelConfigs: [modelEntry(currentModels[12])] };
  const catalog = parseAntigravityCatalog(raw);
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].id, 'MODEL_FUTURE_ABC');
  assert.equal(selectAntigravityModel(catalog, 'Gemini 5 Future (High)').model?.id, 'MODEL_FUTURE_ABC');
  assertFailure(selectAntigravityModel(catalog), 'rejected');
});

test('duplicate IDs preserve stricter availability and quota rather than the first permissive entry', () => {
  const available = modelEntry(currentModels[12]);
  const disabled = modelEntry(currentModels[12], { disabled: true, quotaInfo: { remainingFraction: 0 } });
  for (const entries of [[available, disabled], [disabled, available]]) {
    const catalog = parseAntigravityCatalog(statusFixture(entries));
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].disabled, true);
    assert.equal(catalog.models[0].quotaRemaining, 0);
    assertFailure(selectAntigravityModel(catalog, 'M318'), 'rejected', 'MODEL_PLACEHOLDER_M318');
  }
});

test('image declaration is separate from direct transport and explicit false remains false', () => {
  for (const supportsImages of [undefined, false]) {
    const raw = statusFixture([modelEntry(currentModels[12], { supportsImages, supportedMimeTypes: { 'image/png': true } })]);
    assert.equal(parseAntigravityCatalog(raw).models[0].supportsImages, supportsImages === undefined);
  }
});

test('legacy table is explicit, fresh per call and preserves original fallback order', () => {
  const catalog = legacyAntigravityCatalog();
  assert.equal(catalog.modern, false);
  assert.deepEqual(catalog.models.map(model => model.id), [
    'MODEL_PLACEHOLDER_M132', 'MODEL_PLACEHOLDER_M20', 'MODEL_PLACEHOLDER_M18',
    'MODEL_PLACEHOLDER_M16', 'MODEL_PLACEHOLDER_M36',
  ]);
  assert.equal(selectAntigravityModel(catalog).model?.id, 'MODEL_PLACEHOLDER_M132');
  assert.equal(selectAntigravityModel(catalog, 'M16').model?.id, 'MODEL_PLACEHOLDER_M16');
  catalog.models[0].disabled = true;
  assert.equal(selectAntigravityModel(catalog).model?.id, 'MODEL_PLACEHOLDER_M20');
  assert.equal(legacyAntigravityCatalog().models[0].disabled, false);
  assertFailure(selectAntigravityModel(catalog, 'M999'), 'rejected');
});

test('cyclic or excessively nested config wrappers terminate without choosing a model', () => {
  const cycle = {};
  cycle.modelConfigs = cycle;
  const deep = { modelConfigs: { configs: { models: { configs: { models: { configs: { models: { M318: modelEntry(currentModels[12]) } } } } } } } };
  for (const modelConfigs of [cycle, deep]) {
    const catalog = parseAntigravityCatalog({ userStatus: { modelConfigs } });
    assert.equal(catalog.modern, false);
    assertFailure(selectAntigravityModel(catalog), 'invalid-response');
  }
});
