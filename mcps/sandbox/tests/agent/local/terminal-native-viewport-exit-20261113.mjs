import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalRenderer, terminalSafeText } from '../../../src/agent-cli/renderer.ts';
import { DraftBuffer } from '../../../src/agent-cli/input.ts';

const view = { inline: true, state: 'idle', status: '回复完成', connection: '已连接', details: ['中文公式'], logs: [], draft: new DraftBuffer(), hint: 'PgUp/PgDn', stateStartedAt: Date.now() };

test('fallback and native mode transitions use the first row of the same 34-row viewport', () => {
    const renderer = new TerminalRenderer({ color: true, graphics: 'blocks', reducedMotion: true });
    try {
        for (const graphics of ['blocks', 'native', 'blocks', 'none']) {
            renderer.options.graphics = graphics;
            assert.equal(renderer.frameHeight(34, true), 34);
            const output = renderer.render(view, 100, 34);
            const header = output.split('\x1b[1;1H')[1]?.split('\x1b[2;1H')[0];
            assert.equal(terminalSafeText(header).trim(), 'sandbox_agent');
        }
    } finally { renderer.dispose(); }
});

test('native inline rendering starts at the first viewport row and keeps its footer at the bottom', () => {
    const renderer = new TerminalRenderer({ color: true, graphics: 'native', reducedMotion: true });
    try {
        for (const height of [30, 32, 34, 42]) {
            assert.equal(renderer.frameHeight(height, true), height);
            const output = renderer.render(view, 100, height);
            const header = output.split('\x1b[1;1H')[1]?.split('\x1b[2;1H')[0];
            assert.equal(terminalSafeText(header).trim(), 'sandbox_agent');
            assert.ok(output.includes(`\x1b[${height};1H`));
            assert.match(output, new RegExp(`\\x1b\\[${height - 3};5H\\x1b\\[\\?25h$`));
            assert.equal(renderer.nativeImage(view, 100, height)?.rectangle.row, 3);
        }
    } finally { renderer.dispose(); }
});

test('release clears the entire owned viewport with the shell default background, including a former inline prefix', () => {
    for (const graphics of ['native', 'blocks']) {
        const renderer = new TerminalRenderer({ color: true, graphics, reducedMotion: true });
        try {
            renderer.render(view, 100, 34);
            const release = renderer.releaseFrame(34);
            assert.match(release, /^\x1b\[0m\x1b\[1;1H\x1b\[J/);
            assert.doesNotMatch(release, /\x1b\[2J|\x1b\[3J|\x1b\[\?1049|38;2|48;2/);
            assert.equal(renderer.releaseFrame(34), '');
        } finally { renderer.dispose(); }
    }
});
