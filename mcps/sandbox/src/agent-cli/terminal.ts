import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

export type TerminalKey = { name: string; text?: string; paste?: boolean };
type InputStream = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => unknown };
type OutputStream = Writable & { columns?: number; rows?: number; isTTY?: boolean };

export function terminalGraphicsHost(environment: NodeJS.ProcessEnv = process.env): { kitty: boolean; queries: boolean } {
    const program = environment.TERM_PROGRAM?.toLowerCase();
    const term = environment.TERM?.toLowerCase() ?? '';
    const kitty = !environment.TMUX && !environment.STY && (term === 'xterm-kitty' || program === 'wezterm' || Boolean(environment.KITTY_WINDOW_ID));
    const queries = kitty || Boolean(environment.WT_SESSION) || ['vscode', 'iterm.app', 'apple_terminal'].includes(program ?? '') || /^(?:xterm|foot|rxvt)/.test(term);
    return { kitty, queries };
}

export class TerminalSession extends EventEmitter {
    private readonly decoder = new StringDecoder('utf8');
    private buffer = '';
    private pasting = false;
    private pasted = '';
    private pasteRejected = false;
    private escapeTimer: NodeJS.Timeout | null = null;
    private readonly originalRaw: boolean;
    private readonly originalFlow: boolean | null;
    private opened = false;
    private disposed = false;
    private editorChordUntil = 0;
    private chain = Promise.resolve();
    private readonly dataListener = (chunk: Buffer | string) => { this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk); this.parse(); };
    private readonly resizeListener = () => this.emit('resize');

    constructor(readonly input: InputStream, readonly output: OutputStream, readonly linear = false) {
        super();
        this.originalRaw = input.isRaw === true;
        this.originalFlow = input.readableFlowing;
    }

    get width(): number { return this.output.columns ?? 100; }
    get height(): number { return this.output.rows ?? 32; }

    async open(): Promise<void> {
        if (this.disposed) throw new Error('终端会话已经关闭');
        if (this.opened) return;
        this.opened = true;
        this.input.setRawMode?.(true);
        this.input.on('data', this.dataListener);
        this.input.once('end', this.endListener);
        this.input.resume();
        this.output.on('resize', this.resizeListener);
        if (!this.linear) await this.write('\x1b[?25l\x1b[?2004h' + '\r\n'.repeat(this.height));
    }

    write(text: string, geometry?: { width: number; height: number }): Promise<void> {
        const writing = this.chain.then(() => new Promise<void>((resolveWrite, rejectWrite) => {
            if (this.output.destroyed) { resolveWrite(); return; }
            if (geometry && (geometry.width !== this.width || geometry.height !== this.height)) {
                this.emit('resize'); resolveWrite(); return;
            }
            this.output.write(text, error => error ? rejectWrite(error) : resolveWrite());
        }));
        this.chain = writing.catch(() => {});
        return writing;
    }

    async suspend(): Promise<void> {
        if (!this.opened) return;
        this.opened = false;
        if (this.escapeTimer) clearTimeout(this.escapeTimer);
        this.escapeTimer = null;
        this.input.removeListener('data', this.dataListener);
        this.input.removeListener('end', this.endListener);
        this.output.removeListener('resize', this.resizeListener);
        this.input.setRawMode?.(this.originalRaw);
        if (this.originalFlow === false || this.originalFlow === null) this.input.pause();
        else this.input.resume();
        if (!this.linear) await this.write('\x1b[0m\x1b[?2004l\x1b[?7h\x1b[?25h\r\n');
        await this.chain;
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        try { await this.suspend(); }
        finally { this.removeAllListeners(); }
    }

    private readonly endListener = () => this.emit('key', { name: 'eof' });

    private parse(): void {
        if (this.escapeTimer) { clearTimeout(this.escapeTimer); this.escapeTimer = null; }
        while (this.buffer.length) {
            if (this.pasting) {
                const end = this.buffer.indexOf('\x1b[201~');
                if (end < 0) {
                    const safeLength = Math.max(0, this.buffer.length - 5);
                    if (!this.pasteRejected) this.pasted += this.buffer.slice(0, safeLength);
                    this.buffer = this.buffer.slice(safeLength);
                    if (Buffer.byteLength(this.pasted, 'utf8') > 1024 * 1024) { this.pasted = ''; this.pasteRejected = true; this.emit('inputError', '粘贴超过1MiB，原草稿仍保留'); }
                    return;
                }
                if (!this.pasteRejected) this.pasted += this.buffer.slice(0, end);
                if (!this.pasteRejected && Buffer.byteLength(this.pasted, 'utf8') > 1024 * 1024) { this.pasteRejected = true; this.emit('inputError', '粘贴超过1MiB，原草稿仍保留'); }
                this.buffer = this.buffer.slice(end + 6);
                const text = this.pasted.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                this.pasted = ''; this.pasting = false;
                if (!this.pasteRejected) this.emit('key', { name: 'text', text, paste: true });
                this.pasteRejected = false;
                continue;
            }
            if (this.buffer.startsWith('\x1b[200~')) { this.buffer = this.buffer.slice(6); this.pasting = true; this.pasteRejected = false; continue; }
            if (this.buffer.startsWith('\x1b')) {
                if (this.buffer.startsWith('\x1b\r')) { this.buffer = this.buffer.slice(2); this.emit('key', { name: 'alt-enter' }); continue; }
                if (/^\x1b[mwsnrMWSNR]/.test(this.buffer)) { const name = 'alt-' + this.buffer[1].toLowerCase(); this.buffer = this.buffer.slice(2); this.emit('key', { name }); continue; }
                const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.buffer)?.[0];
                if (csi) {
                    this.buffer = this.buffer.slice(csi.length);
                    const key = ({ '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'delete', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[13;2u': 'newline', '\x1b[27;2;13~': 'newline', '\x1b[Z': 'backtab' } as Record<string, string>)[csi];
                    if (key) this.emit('key', { name: key });
                    else this.emit('reply', csi);
                    continue;
                }
                const end = this.buffer.indexOf('\x1b\\', 2);
                if (this.buffer.startsWith('\x1b_G') && end >= 0) {
                    this.emit('reply', this.buffer.slice(0, end + 2)); this.buffer = this.buffer.slice(end + 2); continue;
                }
                if (this.buffer.length > 4096) { this.buffer = ''; this.emit('inputError', '终端应答超出上限'); return; }
                this.escapeTimer = setTimeout(() => {
                    this.escapeTimer = null;
                    if (this.buffer.startsWith('\x1b[') || this.buffer.startsWith('\x1b_G')) { this.buffer = ''; return; }
                    this.buffer = this.buffer.slice(1); this.emit('key', { name: 'escape' }); this.parse();
                }, 60);
                return;
            }
            const character = this.buffer[0];
            if (character === '\x18') { this.buffer = this.buffer.slice(1); this.editorChordUntil = Date.now() + 1000; continue; }
            if (character === '\x05' && this.editorChordUntil >= Date.now()) { this.buffer = this.buffer.slice(1); this.editorChordUntil = 0; this.emit('key', { name: 'editor' }); continue; }
            this.editorChordUntil = 0;
            const control = ({ '\r': 'enter', '\n': 'newline', '\t': 'tab', '\x03': 'interrupt', '\x04': 'eof', '\x07': 'menu', '\x08': 'backspace', '\x7f': 'backspace', '\x01': 'home', '\x05': 'end', '\x15': 'clear-line', '\x1a': 'undo', '\x19': 'redo', '\x12': 'history', '\x18': 'editor-chord' } as Record<string, string>)[character];
            if (control) { this.buffer = this.buffer.slice(1); this.emit('key', { name: control }); continue; }
            const match = /^[^\x00-\x1f\x7f]+/.exec(this.buffer)?.[0];
            if (match) { this.buffer = this.buffer.slice(match.length); this.emit('key', { name: 'text', text: match }); }
            else this.buffer = this.buffer.slice(1);
        }
    }
}
