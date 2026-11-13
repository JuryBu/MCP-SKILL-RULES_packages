import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RasterFrame } from './sixel-raster.js';

export interface NativeImageRectangle { column: number; row: number; columns: number; rows: number }
export interface NativeConsoleViewport { top: number; left: number; columns: number; rows: number; bufferColumns: number; bufferRows: number }
export interface NativeGraphicsEvent { type: string; viewport?: NativeConsoleViewport; [key: string]: unknown }

export function validNativeViewport(value: unknown): value is NativeConsoleViewport {
    if (!value || typeof value !== 'object') return false;
    const viewport = value as NativeConsoleViewport;
    return ['top', 'left', 'columns', 'rows', 'bufferColumns', 'bufferRows'].every(key => Number.isInteger(viewport[key as keyof NativeConsoleViewport]))
        && viewport.top >= 0 && viewport.left >= 0 && viewport.columns > 0 && viewport.rows > 0
        && viewport.left + viewport.columns <= viewport.bufferColumns && viewport.top + viewport.rows <= viewport.bufferRows;
}

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
    private frameBoundaries = false;
    private textMetricsReady = false;
    private pendingText?: string;
    private measuredText = '';
    private measurementId = 0;
    private measurementPending = false;
    private measurementTimer?: NodeJS.Timeout;
    private closing = false;
    private pending?: string;
    private output = '';
    private readonly eventCounts = new Map<string, number>();
    private lastEvent?: NativeGraphicsEvent;
    private lastEventAt?: number;
    private viewport?: NativeConsoleViewport;
    private visible?: boolean;
    private hiddenReason?: string;
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
                    if (event.type === 'ready') { this.ready = true; this.frameBoundaries = Array.isArray(event.capabilities) && event.capabilities.includes('text-frame'); this.textMetricsReady = Array.isArray(event.capabilities) && event.capabilities.includes('text-metrics'); if (this.pendingText !== undefined) { const text = this.pendingText; this.pendingText = undefined; this.measureText(text); } if (this.pending) { const pending = this.pending; this.pending = undefined; this.write(pending); } }
                    if (event.type === 'text-metrics' && (!event.characterWidths || typeof event.characterWidths !== 'object' || Array.isArray(event.characterWidths) || Object.keys(event.characterWidths).length > 4096 || Object.values(event.characterWidths).some(width => width !== 1 && width !== 2))) throw new Error('Invalid native character widths');
                    if (event.type === 'text-metrics' && event.requestId === this.measurementId) { this.measurementPending = false; if (this.measurementTimer) clearTimeout(this.measurementTimer); this.measurementTimer = undefined; event.measurementCompleted = true; }
                    if (event.viewport !== undefined && !validNativeViewport(event.viewport)) throw new Error('Invalid native console viewport');
                    if (event.viewport) {
                        if (this.viewport && event.viewport.columns === this.viewport.columns && event.viewport.rows === this.viewport.rows
                            && event.viewport.bufferColumns === this.viewport.bufferColumns && event.viewport.bufferRows === this.viewport.bufferRows) event.scrollRows = event.viewport.top - this.viewport.top;
                        this.viewport = { ...event.viewport };
                    }
                    if (event.type === 'hidden') { this.visible = false; this.hiddenReason = String(event.reason ?? 'unknown'); }
                    if (event.type === 'visible') { this.visible = true; this.hiddenReason = undefined; }
                    const diagnostic = event.type + (typeof event.reason === 'string' ? ':' + event.reason : '');
                    if (this.eventCounts.has(diagnostic) || this.eventCounts.size < 32) this.eventCounts.set(diagnostic, (this.eventCounts.get(diagnostic) ?? 0) + 1);
                    this.lastEvent = event; this.lastEventAt = Date.now();
                    this.onEvent(event);
                    if (event.type === 'unavailable') this.close();
                } catch { this.close(); }
            }
        });
        child.stdin.on('error', () => this.close());
        child.stderr.resume();
        child.on('error', error => { this.onEvent({ type: 'unavailable', message: error.message }); this.close(); });
        child.on('exit', (code, signal) => { this.ready = false; this.visible = false; this.closing = true; this.child = undefined; this.onEvent({ type: 'exit', code, signal }); });
        return true;
    }

    frame(frame: RasterFrame, rectangle: NativeImageRectangle, reanchor = false): boolean {
        if (this.closing || (!this.child && !this.start())) return false;
        const message = encodeNativeFrame(frame, rectangle, reanchor);
        if (!this.ready) { this.pending = message; return true; }
        return this.write(message);
    }

    hide(): void { this.pending = undefined; if (this.ready) this.write('{"type":"hide"}\n'); }

    measureText(text: string): boolean {
        if (this.closing) return false;
        const value = text.slice(0, 16384);
        if (!this.ready) { this.pendingText = value; return false; }
        if (!this.textMetricsReady) return true;
        if (value === this.measuredText) return !this.measurementPending;
        const requestId = this.measurementId + 1;
        if (!this.write(JSON.stringify({ type: 'measure-text', text: value, requestId }) + '\n')) return false;
        this.measurementId = requestId; this.measurementPending = true;
        if (!this.measurementTimer) {
            this.measurementTimer = setTimeout(() => {
                this.measurementTimer = undefined;
                if (!this.measurementPending || this.closing) return;
                this.measurementPending = false;
                this.onEvent({ type: 'unavailable', message: '原生字格测量回执超时，恢复字符画面' });
                this.close();
            }, 1500);
            this.measurementTimer.unref();
        }
        this.measuredText = value;
        return false;
    }

    beginFrame(): boolean { return this.ready && this.frameBoundaries && this.write('{"type":"paint-begin"}\n'); }
    endFrame(): boolean { return this.ready && this.frameBoundaries && this.write('{"type":"paint-end"}\n'); }
    diagnostics(): { ready: boolean; closing: boolean; frameBoundaries: boolean; visible?: boolean; hiddenReason?: string; viewport?: NativeConsoleViewport; lastEvent?: NativeGraphicsEvent; lastEventAt?: number; counts: Record<string, number> } {
        return { ready: this.ready, closing: this.closing, frameBoundaries: this.frameBoundaries, visible: this.visible, hiddenReason: this.hiddenReason, viewport: this.viewport ? { ...this.viewport } : undefined,
            lastEvent: this.lastEvent ? { ...this.lastEvent } : undefined, lastEventAt: this.lastEventAt, counts: Object.fromEntries(this.eventCounts) };
    }

    close(): void {
        if (this.closing) return;
        if (this.measurementTimer) clearTimeout(this.measurementTimer);
        this.measurementTimer = undefined; this.measurementPending = false;
        this.closing = true; this.pending = undefined; this.pendingText = undefined;
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
