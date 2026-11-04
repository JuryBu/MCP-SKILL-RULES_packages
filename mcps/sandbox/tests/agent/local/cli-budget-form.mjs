import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { InteractiveCli } from '../../../src/agent-cli/ui.ts';

function fixture() {
    let requests = 0;
    const client = Object.assign(new EventEmitter(), { dataDir: process.cwd(), request: async () => { requests += 1; return { ok: true, data: {} }; } });
    const output = new Writable({ write(_bytes, _encoding, done) { done(); } });
    const ui = new InteractiveCli({ words: [], options: { plain: true } }, client,
        { stdin: Readable.from([]), stdout: output, stderr: output, cwd: process.cwd() });
    ui.draft.replace('主人保留的原草稿');
    ui.budgetForm();
    return { ui, requests: () => requests };
}

test('hard budget rejects its missing amount on that field before reaching the last page', async () => {
    const { ui, requests } = fixture();
    try {
        await ui.advanceForm(); await ui.advanceForm(); await ui.advanceForm();
        assert.equal(ui.form.fields[ui.form.index].key, 'cost');
        await ui.advanceForm();
        assert.equal(ui.form.index, 3);
        assert.match(ui.logs.at(-1), /hard模式需填写金额上限/);
        ui.form.draft.replace('错误金额'); await ui.advanceForm();
        assert.equal(ui.form.index, 3);
        ui.form.draft.replace('0'); await ui.advanceForm();
        ui.form.draft.replace('US'); await ui.advanceForm();
        assert.equal(ui.form.index, 4);
        ui.form.draft.replace('CNY'); await ui.advanceForm(); await ui.advanceForm();
        assert.equal(ui.form, undefined);
        assert.equal(ui.budget.maxCostMicros, 0);
        assert.equal(ui.budget.currency, 'CNY');
        assert.equal(ui.draft.text, '主人保留的原草稿');
        assert.equal(requests(), 0);
    } finally { await ui.finish(0); }
});

test('estimated budget may omit its amount while counts and output remain finite positive integers', async () => {
    const { ui, requests } = fixture();
    try {
        ui.form.draft.replace('estimated'); await ui.advanceForm();
        ui.form.draft.replace('Infinity'); await ui.advanceForm();
        assert.equal(ui.form.index, 1);
        ui.form.draft.replace('60000'); await ui.advanceForm();
        ui.form.draft.replace('2.5'); await ui.advanceForm();
        assert.equal(ui.form.index, 2);
        ui.form.draft.replace('2'); await ui.advanceForm(); await ui.advanceForm(); await ui.advanceForm();
        ui.form.draft.replace('0'); await ui.advanceForm();
        assert.equal(ui.form.index, 5);
        ui.form.draft.replace('4096'); await ui.advanceForm();
        assert.equal(ui.budget.costMode, 'estimated');
        assert.equal(ui.budget.maxCostMicros, undefined);
        assert.equal(ui.budget.maxModelCalls, 2);
        assert.equal(requests(), 0);
    } finally { await ui.finish(0); }
});

test('returning to a previous budget field keeps edits instead of replacing them with defaults', async () => {
    const { ui } = fixture();
    try {
        await ui.advanceForm();
        ui.form.draft.replace('120000'); await ui.advanceForm();
        ui.form.draft.replace('7');
        await ui.handleKey({ name: 'backtab' });
        assert.equal(ui.form.draft.text, '120000');
        await ui.advanceForm();
        assert.equal(ui.form.draft.text, '7');
        assert.equal(ui.draft.text, '主人保留的原草稿');
    } finally { await ui.finish(0); }
});
