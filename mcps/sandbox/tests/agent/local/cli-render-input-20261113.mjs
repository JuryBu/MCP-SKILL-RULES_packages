import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { TerminalSession } from '../../../src/agent-cli/terminal.ts';
import { TerminalRenderer, theme } from '../../../src/agent-cli/renderer.ts';
import { DraftBuffer } from '../../../src/agent-cli/input.ts';
import { appendTranscriptLines, markdownDisplayLines } from '../../../src/agent-cli/history-view.ts';
import { compatibleEmojiText } from '../../../src/agent-cli/presentation.ts';
import { encodeNativeFrame, NativeConsoleGraphics, validNativeViewport } from '../../../src/agent-cli/graphics/native-console.ts';

function terminalFixture() {
    const input = new PassThrough();
    const writes = [], raw = [];
    input.setRawMode = value => { input.isRaw = value; raw.push(value); };
    const output = new Writable({ write(bytes, encoding, done) { writes.push(bytes.toString()); done(); } });
    output.columns = 100; output.rows = 32;
    return { input, output, writes, raw, terminal: new TerminalSession(input, output) };
}

function view(draft = new DraftBuffer()) {
    return { inline: true, state: 'idle', status: '准备输入', connection: '已连接', details: ['本地重放'], logs: [], draft,
        hint: 'PgUp/PgDn翻阅', stateStartedAt: Date.now() };
}

const viewport = { top: 120, left: 0, columns: 100, rows: 32, bufferColumns: 100, bufferRows: 9001 };

test('opening clears the viewport once without scrolling shell history or switching buffers', async () => {
    const current = terminalFixture();
    try {
        await current.terminal.open();
        assert.equal(current.writes.length, 1);
        assert.match(current.writes[0], /\x1b\[H\x1b\[0J$/);
        assert.match(current.writes[0], /\x1b\[\?1000h\x1b\[\?1006h/);
        assert.doesNotMatch(current.writes[0], /[\r\n]|\x1b\[\?1049/);
        await current.terminal.dispose();
        assert.match(current.writes.at(-1), /\x1b\[\?1006l\x1b\[\?1000l/);
        assert.deepEqual(current.raw, [true, false]);
        assert.equal(current.input.listenerCount('data'), 0);
        assert.equal(current.output.listenerCount('resize'), 0);
    } finally { await current.terminal.dispose(); current.input.destroy(); current.output.destroy(); }
});

test('fragmented SGR and X10 wheels become application paging; mouse payload never enters Chinese drafts', async () => {
    const current = terminalFixture(), keys = [];
    current.terminal.on('key', key => keys.push(key));
    try {
        await current.terminal.open();
        const chinese = Buffer.from('中文🙂');
        current.input.write(chinese.subarray(0, 4)); current.input.write(chinese.subarray(4));
        current.input.write('\x1b[<64;10;'); current.input.write('8M');
        current.input.write('\x1b[<65;10;8M\x1b[<0;10;8M\x1b[<64;10;8m');
        current.input.write('\x1b[M'); current.input.write(String.fromCharCode(97, 42, 40));
        current.input.write('\x1bOA\x1bOF');
        assert.equal(keys.filter(key => key.name === 'text').map(key => key.text).join(''), '中文🙂');
        assert.deepEqual(keys.filter(key => key.source === 'mouse').map(key => [key.name, key.scrollRows]), [['pageup', -3], ['pagedown', 3], ['pagedown', 3]]);
        assert.deepEqual(keys.filter(key => key.source === 'mouse')[0], { name: 'pageup', source: 'mouse', scrollRows: -3, column: 9, row: 7 });
        assert.deepEqual(keys.slice(-2).map(key => key.name), ['up', 'end']);
        keys.length = 0;
        current.input.write('\x1b[200~中文\x1b[<64;10;8M\x1b[201~');
        assert.deepEqual(keys, [{ name: 'text', text: '中文\x1b[<64;10;8M', paste: true }]);
    } finally { await current.terminal.dispose(); current.input.destroy(); current.output.destroy(); }
});

test('queued writes reject an old viewport generation even when dimensions have not changed', async () => {
    const input = new PassThrough(), writes = [];
    let release;
    const output = new Writable({ write(bytes, encoding, done) { writes.push(bytes.toString()); if (writes.length === 1) release = done; else done(); } });
    output.columns = 100; output.rows = 32;
    const terminal = new TerminalSession(input, output);
    const first = terminal.write('earlier write');
    const geometry = terminal.frameGeometry();
    const stale = terminal.write('stale frame', geometry);
    await new Promise(resolveTurn => setImmediate(resolveTurn));
    terminal.updateViewport(viewport);
    assert.equal(terminal.isCurrentGeometry(geometry), false);
    assert.equal(terminal.isCurrentGeometry(terminal.frameGeometry()), true);
    release(); await Promise.all([first, stale]);
    assert.deepEqual(writes, ['earlier write']);
    await terminal.write('current frame', terminal.frameGeometry());
    assert.deepEqual(writes, ['earlier write', 'current frame']);
    await terminal.dispose(); input.destroy(); output.destroy();
});

test('native viewport invalidates one ANSI frame and leaves subsequent frames incremental', () => {
    const renderer = new TerminalRenderer({ color: true, graphics: 'native', reducedMotion: true });
    try {
        const page = view();
        const initial = renderer.render(page, 100, 32);
        assert.match(initial, /48;2;25;24;22m\x1b\[H\x1b\[0J/);
        assert.equal(renderer.lastRenderChanged, true);
        const unchanged = renderer.render(page, 100, 32);
        assert.match(unchanged, /^\x1b\[29;5H\x1b\[\?25h$/);
        assert.equal(renderer.lastRenderChanged, false);
        assert.equal(renderer.setViewport(viewport), true);
        assert.match(renderer.render(page, 100, 32), /\x1b\[H\x1b\[0J/);
        assert.equal(renderer.setViewport(viewport), false);
        assert.doesNotMatch(renderer.render(page, 100, 32), /\x1b\[0?J/);
        renderer.setViewport({ ...viewport, top: 117 });
        const scrolled = renderer.render(page, 100, 32);
        assert.equal(scrolled.split('sandbox_agent').length - 1, 1);
        assert.match(scrolled, /\x1b\[H\x1b\[0J/);
        assert.match(renderer.clearFrame(), /48;2;25;24;22m/);
        assert.equal(theme.background, '#191816');
    } finally { renderer.dispose(); }
});

test('Chinese committed text, newlines and moved caret finish at the actual input cursor', () => {
    const cases = [
        ['12345566输入', 10, 100, 32, 29, 17],
        ['12345566输入\n甲', 12, 100, 32, 30, 7],
        ['ab中🙂', 2, 100, 32, 29, 7],
        ['中文输入文本', 6, 20, 12, 10, 5],
        ['甲\n乙\n丙', 1, 100, 32, 29, 7],
    ];
    for (const [text, cursor, columns, rows, row, column] of cases) {
        const renderer = new TerminalRenderer({ color: false, graphics: 'none', reducedMotion: true });
        const draft = new DraftBuffer(); draft.replace(text); draft.cursorGrapheme = cursor;
        try {
            const expected = `\x1b[${row};${column}H\x1b[?25h`;
            assert.ok(renderer.render(view(draft), columns, rows).endsWith(expected));
            assert.ok(renderer.render(view(draft), columns, rows).endsWith(expected));
            assert.equal(draft.text, text);
        } finally { renderer.dispose(); }
    }
});

test('appearance is independent of the execution state and reuses the approved source rasters', () => {
    const renderer = new TerminalRenderer({ color: true, graphics: 'native', reducedMotion: true });
    try {
        const page = view();
        const human = renderer.nativeImage({ ...page, appearance: 'human' }, 100, 32);
        assert.equal(human.key, 'human-regular.sixel');
        assert.deepEqual(human.frame.pixels, renderer.assets.raster('human-regular.sixel').pixels);
        assert.equal(renderer.nativeImage({ ...page, appearance: 'cat' }, 100, 32).key, renderer.assets.frameKey('idle', false, 0, true));
        assert.notEqual(renderer.nativeImage({ ...page, state: 'thinking', appearance: 'human' }, 100, 32).key, human.key);
    } finally { renderer.dispose(); }
});

test('readable Markdown and classic emoji fallback preserve the exact transcript source and code contents', () => {
    const original = '助手：## 欢迎 👋\n**中文粗体**与`file_name`\n[文档](https://example.test/doc)\n```js\nconst literal = "**保留**";\n```\n- 完成 ✅';
    const stored = appendTranscriptLines([], original);
    const displayed = markdownDisplayLines(stored, { emojiFallback: true });
    assert.deepEqual(displayed, ['助手：欢迎 [挥手]', '中文粗体与file_name', '文档 (https://example.test/doc)', '[代码 js]', 'const literal = "**保留**";', '[代码结束]', '- 完成 [完成]']);
    assert.equal(stored.join('\n'), original);
    assert.equal(markdownDisplayLines(['原样🙂'])[0], '原样🙂');
    assert.equal(compatibleEmojiText('中文👩🏽‍💻1️⃣'), '中文[表情][1]');
    assert.equal(compatibleEmojiText('© 2026 → 原文 ™'), '© 2026 → 原文 ™');
    assert.equal(markdownDisplayLines(['\x1b]52;c;secret\x07**安全**'])[0], '安全');
});

test('native text-frame brackets preserve protocol order without opening a helper process', () => {
    const graphics = new NativeConsoleGraphics();
    assert.equal(graphics.beginFrame(), false);
    const input = new PassThrough(), messages = [];
    input.on('data', bytes => messages.push(...bytes.toString().trim().split('\n').map(line => JSON.parse(line))));
    graphics.child = { stdin: input, exitCode: 0 };
    graphics.ready = true;
    assert.equal(graphics.beginFrame(), false);
    graphics.frameBoundaries = true;
    assert.equal(graphics.beginFrame(), true);
    assert.equal(graphics.frame({ width: 1, height: 1, pixels: new Int32Array([0x123456]) }, { column: 3, row: 3, columns: 30, rows: 17 }, true), true);
    assert.equal(graphics.endFrame(), true);
    graphics.hide(); graphics.close();
    assert.deepEqual(messages.map(message => message.type), ['paint-begin', 'frame', 'paint-end', 'hide', 'close']);
    assert.equal(graphics.diagnostics().closing, true);
    assert.equal(graphics.frame({ width: 1, height: 1, pixels: new Int32Array(1) }, { column: 3, row: 3, columns: 30, rows: 17 }), false);
    input.destroy();
});

test('native protocol validates the viewport and retains exact transparent image bytes', () => {
    assert.equal(validNativeViewport(viewport), true);
    assert.equal(validNativeViewport({ ...viewport, top: 9000 }), false);
    assert.equal(validNativeViewport({ ...viewport, columns: 100.5 }), false);
    const frame = JSON.parse(encodeNativeFrame({ width: 2, height: 1, pixels: new Int32Array([0x123456, -1]) }, { column: 3, row: 3, columns: 30, rows: 17 }, true));
    assert.deepEqual([...Buffer.from(frame.pixels, 'base64')], [0x56, 0x34, 0x12, 0xff, 0, 0, 0, 0]);
    assert.equal(frame.reanchor, true);
    const source = readFileSync(new URL('../../../native/agent-graphics.cs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /cursor-inside-image/);
    assert.match(source, /if \(paintDirty\)/);
    assert.match(source, /if \(!visible\)/);
    assert.match(source, /type = "viewport"/);
});
