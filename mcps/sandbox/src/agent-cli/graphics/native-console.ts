import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RasterFrame } from './sixel-raster.js';

export interface NativeImageRectangle { column: number; row: number; columns: number; rows: number }
export interface NativeGraphicsEvent { type: string; [key: string]: unknown }

export function encodeNativeFrame(frame: RasterFrame, rectangle: NativeImageRectangle, reanchor = false): string {
    if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1
        || frame.width > 1024 || frame.height > 1024 || frame.pixels.length !== frame.width * frame.height
        || !Object.values(rectangle).every(Number.isInteger) || rectangle.column < 0 || rectangle.row < 0
        || rectangle.columns < 1 || rectangle.rows < 1) throw new Error('Invalid native graphics frame or rectangle');
    const bytes = Buffer.alloc(frame.pixels.length * 4);
    frame.pixels.forEach((pixel, index) => bytes.writeUInt32LE(pixel < 0 ? 0 : (0xff000000 | pixel) >>> 0, index * 4));
    return JSON.stringify({ type: 'frame', width: frame.width, height: frame.height, ...rectangle, reanchor, pixels: bytes.toString('base64') }) + '\n';
}

export class NativeConsoleGraphics {
    private child?: ChildProcessWithoutNullStreams;
    private ready = false;
    private closing = false;
    private pending?: string;
    private output = '';
    constructor(private readonly onEvent: (event: NativeGraphicsEvent) => void = () => {},
        private readonly executable = fileURLToPath(new URL('../../native/agent-graphics.exe', import.meta.url))) {}

    start(): boolean {
        if (this.child) return !this.closing;
        if (this.closing || process.platform !== 'win32' || !existsSync(this.executable)) return false;
        const child = spawn(this.executable, ['--parent-pid', String(process.pid)], { stdio: 'pipe', windowsHide: true });
        this.child = child;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            this.output += chunk;
            if (this.output.length > 64 * 1024) { this.close(); return; }
            let newline: number;
            while ((newline = this.output.indexOf('\n')) >= 0) {
                const line = this.output.slice(0, newline); this.output = this.output.slice(newline + 1);
                try { const event = JSON.parse(line) as NativeGraphicsEvent;
                    if (event.type === 'ready') { this.ready = true; if (this.pending) { const pending = this.pending; this.pending = undefined; this.write(pending); } }
                    this.onEvent(event);
                    if (event.type === 'unavailable') this.close();
                } catch { this.close(); }
            }
        });
        child.stdin.on('error', () => this.close());
        child.stderr.resume();
        child.on('error', error => { this.onEvent({ type: 'unavailable', message: error.message }); this.close(); });
        child.on('exit', (code, signal) => { this.ready = false; this.closing = true; this.child = undefined; this.onEvent({ type: 'exit', code, signal }); });
        return true;
    }

    frame(frame: RasterFrame, rectangle: NativeImageRectangle, reanchor = false): boolean {
        if (this.closing || (!this.child && !this.start())) return false;
        const message = encodeNativeFrame(frame, rectangle, reanchor);
        if (!this.ready) { this.pending = message; return true; }
        return this.write(message);
    }

    hide(): void { this.pending = undefined; if (this.ready) this.write('{"type":"hide"}\n'); }

    close(): void {
        if (this.closing) return;
        this.closing = true; this.pending = undefined;
        const child = this.child;
        if (!child) return;
        if (!child.stdin.destroyed) child.stdin.end('{"type":"close"}\n');
        const deadline = setTimeout(() => { if (this.child === child && child.exitCode === null) child.kill(); }, 1000);
        deadline.unref();
    }

    private write(message: string): boolean {
        if (!this.child || this.child.stdin.destroyed || this.closing) return false;
        if (this.child.stdin.writableLength > 6 * 1024 * 1024) return false;
        this.child.stdin.write(message);
        return true;
    }
}
