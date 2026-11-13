import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAntigravityAgentModel } from '../src/antigravity-cli.ts';

const flash = { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' };
const argon = { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' };
const carbon = { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' };
const hydrogen = { modelId: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' };
const hydrogenXHigh = { modelId: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' };
const claude = { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 High' };

test('ordinary material follows shared Hydrogen XHigh/High/Carbon ranking and visual review chooses Carbon', () => {
    const models = [claude, carbon, flash, argon, hydrogen, hydrogenXHigh];
    assert.equal(selectAntigravityAgentModel(models, {}).modelId, hydrogenXHigh.modelId);
    assert.equal(selectAntigravityAgentModel(models, { purpose: 'material' }).modelId, hydrogenXHigh.modelId);
    assert.equal(selectAntigravityAgentModel(models, { purpose: 'visual-review' }).modelId, carbon.modelId);
    assert.equal(selectAntigravityAgentModel([carbon, hydrogen], {}).modelId, hydrogen.modelId);
    assert.equal(selectAntigravityAgentModel([carbon, flash], {}).modelId, carbon.modelId);
});

test('unavailable Argon selects eligible Carbon without invoking unavailable models', () => {
    assert.equal(selectAntigravityAgentModel([{ ...argon, disabled: true }, carbon, flash], { purpose: 'visual-review' }).modelId, carbon.modelId);
    assert.equal(selectAntigravityAgentModel([{ ...argon, quotaInfo: { remainingFraction: 0 } }, carbon], { purpose: 'visual-review' }).modelId, carbon.modelId);
});

test('visual review refuses silent Flash or Claude substitution', () => {
    assert.equal(selectAntigravityAgentModel([flash, claude], { purpose: 'visual-review' }), undefined);
    assert.equal(selectAntigravityAgentModel([{ ...argon, disabled: true }, { ...carbon, quotaInfo: { remainingFraction: 0 } }, flash], { purpose: 'visual-review' }), undefined);
});

test('explicit model lookup stays exact and is never replaced by automatic preference', () => {
    const models = [flash, argon, carbon, claude];
    assert.equal(selectAntigravityAgentModel(models, { model: claude.modelId, purpose: 'visual-review' }).modelId, claude.modelId);
    assert.equal(selectAntigravityAgentModel(models, { model: 'missing', purpose: 'visual-review' }), undefined);
    assert.equal(selectAntigravityAgentModel([{ ...argon, disabled: true }, carbon], { model: argon.modelId }), undefined);
});
