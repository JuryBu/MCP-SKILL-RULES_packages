import assert from 'node:assert/strict';
import { TerminalRenderer, characterWidth, fitText, layoutDraftInput, visibleWidth, wrapText } from '../../../src/agent-cli/renderer.ts';
import { markdownDisplayLines } from '../../../src/agent-cli/presentation.ts';
import { DraftBuffer } from '../../../src/agent-cli/input.ts';

const source = '南区明细：90×180 + 110×170 + 100×160 + **150×200** = 16200+18700+16000+30000 = 80900；80900 ÷ 450 = 179.7777… → 179.78。合计 264600 ÷ 1280 = 206.7187… → 206.72。';
const measured = JSON.parse(process.env.CMD_WIDTH_METRICS_JSON ?? '{"×":2,"÷":2,"…":2,"→":2,"·":2,"─":1,"╭":1,"▏":1,"é":1}');
const plain = markdownDisplayLines(source)[0];
const renderer = new TerminalRenderer({ color: true, graphics: 'native', reducedMotion: true });
try {
    const view = { inline: true, state: 'idle', status: '回复完成', connection: '原生CMD', details: [], logs: [], draft: new DraftBuffer(), hint: 'PgUp/PgDn', stateStartedAt: Date.now() };
    const baselineLines = wrapText(plain, 61);
    const baseline = renderer.render({ ...view, details: baselineLines }, 100, 34);
    assert.equal(renderer.setCharacterWidths(measured), true);
    assert.equal(renderer.setCharacterWidths(measured), false);
    const metrics = renderer.textMetrics;
    const lines = wrapText(plain, 61, metrics);
    assert.equal(lines.join(''), plain);
    assert.equal(source.includes('**150×200**'), true);
    assert.equal(characterWidth('×', metrics), 2);
    assert.equal(characterWidth('─', metrics), 1);
    assert.equal(characterWidth('é', metrics), 1);
    assert.equal(characterWidth('e\u0301', metrics), 1);
    assert.equal(characterWidth('🙂', metrics), 2);
    assert.ok(lines.every(line => visibleWidth(line, metrics) <= 61));
    assert.equal(fitText('A×B', 3, metrics), 'A×');
    assert.deepEqual(layoutDraftInput('A×', 2, 3, '|', metrics), { lines: ['A×', '|'], cursor: { row: 1, column: 0 } });
    const candidate = renderer.render({ ...view, details: lines }, 100, 34);
    assert.equal(renderer.setCharacterWidths({ ...measured, bad: 20, '': 2 }), false);
    if (process.argv.includes('--payload')) process.stdout.write(JSON.stringify({ baseline, candidate, baselineLines, lines, plain, detailRow: 34 - renderer.frameHeight(34, true) + 3, release: renderer.releaseFrame(34) }));
    else console.log(JSON.stringify({ passed: true, baselineLines, lines, originalMarkdownPreserved: source.includes('**150×200**') }));
} finally { renderer.dispose(); }
