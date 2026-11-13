import type { DraftBuffer } from './input.js';
import { CharacterAssets, type MascotState } from './graphics/assets.js';
import type { AmbiguousWidth } from './configuration-width.js';
import { characterCellWidth, type TerminalTextMetrics, type TerminalTextWidth } from './terminal-text.js';
import { sampleRaster } from './graphics/raster-sampling.js';
import type { NativeConsoleViewport, NativeImageRectangle } from './graphics/native-console.js';
import type { RasterFrame } from './graphics/sixel-raster.js';

export const theme = { background: '#191816', foreground: '#e8dccb', accent: '#dda76f', muted: '#a39889', border: '#5a4b3d', green: '#b9c89d', input: '#211e1a' };
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
export function graphemes(text: string): string[] { return Array.from(segmenter.segment(text), entry => entry.segment); }
export function terminalSafeText(text: unknown): string {
    return String(text ?? '').replace(/\x1b[\]P_^][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function cleanText(text: unknown): string { return terminalSafeText(text).replace(/[\n\t]/g, ' '); }
export function characterWidth(text: string, ambiguousWidth: TerminalTextWidth = 'narrow'): number { return characterCellWidth(text, ambiguousWidth); }
export function visibleWidth(text: string, ambiguousWidth: TerminalTextWidth = 'narrow'): number { return graphemes(cleanText(text)).reduce((sum, value) => sum + characterWidth(value, ambiguousWidth), 0); }
export function fitText(text: unknown, width: number, ambiguousWidth: TerminalTextWidth = 'narrow'): string {
    let result = '';
    let size = 0;
    const value = cleanText(text);
    for (const part of graphemes(value)) {
        const next = characterWidth(part, ambiguousWidth);
        if (size + next > width) break;
        result += part; size += next;
    }
    return result;
}
export function wrapText(text: unknown, width: number, ambiguousWidth: TerminalTextWidth = 'narrow'): string[] {
    const lines: string[] = [];
    let line = '';
    let used = 0;
    for (const part of graphemes(cleanText(text))) {
        const size = characterWidth(part, ambiguousWidth);
        if (used + size > width && line) { lines.push(line); line = ''; used = 0; }
        line += part; used += size;
    }
    lines.push(line);
    return lines;
}
export function layoutDraftInput(text: string, cursorGrapheme: number, width: number, marker: string, ambiguousWidth: TerminalTextWidth = 'narrow'): { lines: string[]; cursor: { row: number; column: number } } {
    const parts = graphemes(text);
    const cursor = Math.max(0, Math.min(parts.length, cursorGrapheme));
    const columns = Math.max(2, Math.floor(width));
    const lines = [''];
    let used = 0;
    let cursorRow = 0;
    let cursorColumn = 0;
    const append = (value: string, caret = false) => {
        const size = characterWidth(value, ambiguousWidth);
        if (!size) return;
        if (used + size > columns) { lines.push(''); used = 0; }
        if (caret) { cursorRow = lines.length - 1; cursorColumn = used; }
        lines[lines.length - 1] += value;
        used += size;
    };
    for (let index = 0; index <= parts.length; index += 1) {
        if (index === cursor) append(marker, true);
        if (index === parts.length) break;
        const part = parts[index];
        if (part === '\n' || part === '\r' || part === '\r\n') { lines.push(''); used = 0; }
        else {
            const value = cleanText(part);
            if (value === part) append(part);
            else for (const printable of graphemes(value)) append(printable);
        }
    }
    const firstLine = Math.max(0, cursorRow - 1);
    return { lines: lines.slice(firstLine, firstLine + 2), cursor: { row: cursorRow - firstLine, column: cursorColumn } };
}
function style(foreground: string, background: string, bold = false): string {
    const rgb = (hex: string) => [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(';');
    return `\x1b[${bold ? 1 : 22};38;2;${rgb(foreground)};48;2;${rgb(background)}m`;
}

export interface TerminalView {
    inline?: boolean;
    state: MascotState;
    appearance?: 'human' | 'cat';
    appearanceStartedAt?: number;
    status: string;
    connection: string;
    details: string[];
    logs: string[];
    metrics?: string[];
    draft: DraftBuffer;
    hidden?: boolean;
    inputLabel?: string;
    heading?: string;
    hint: string;
    stateStartedAt: number;
}
interface Cell { text: string; foreground: string; background: string; bold?: boolean; continuation?: boolean }

export interface TerminalRendererOptions {
    color: boolean;
    graphics: 'none' | 'blocks' | 'sixel' | 'kitty' | 'native';
    reducedMotion: boolean;
    ambiguousWidth?: AmbiguousWidth;
    fullRedraw?: boolean;
    cacheEnabled?: boolean;
    cellSize?: { width: number; height: number };
}

export interface TerminalGeometry { compact: boolean; bodyRows: number; canDraw: boolean; graphicColumns: number }

export class TerminalRenderer {
    lastRenderChanged = false;
    private frameTop = 0;
    private frameRows = 0;
    private readonly imageId = 100_000 + Math.floor(Math.random() * 1_000_000);
    private previous: string[] = [];
    private previousImage = '';
    private previousGeometry = '';
    private viewportKey = '';
    private viewportChanged = false;
    private measuredCharacterWidths: Readonly<Record<string, number>> = {};
    readonly assets: CharacterAssets;
    readonly options: TerminalRendererOptions;
    constructor(options: TerminalRendererOptions) {
        this.options = { ...options };
        this.assets = new CharacterAssets(options.cacheEnabled);
    }

    reset(): void { this.previous = []; this.previousImage = ''; this.previousGeometry = ''; }
    dispose(): void { this.assets.clear(); this.reset(); }

    get textMetrics(): TerminalTextMetrics { return { ambiguousWidth: this.options.ambiguousWidth, characterWidths: this.measuredCharacterWidths }; }

    setCharacterWidths(widths: Readonly<Record<string, number>>): boolean {
        const next = Object.fromEntries(Object.entries(widths).filter(([character, width]) => graphemes(character).length === 1 && (width === 1 || width === 2)));
        if (JSON.stringify(next) === JSON.stringify(this.measuredCharacterWidths)) return false;
        this.measuredCharacterWidths = Object.freeze(next);
        this.reset();
        return true;
    }

    setViewport(viewport: NativeConsoleViewport): boolean {
        const key = JSON.stringify(viewport);
        if (key === this.viewportKey) return false;
        this.viewportKey = key;
        this.viewportChanged = true;
        this.reset();
        return true;
    }

    private background(): string { return this.options.color ? style(theme.foreground, theme.background) : '\x1b[0m'; }

    private frameKey(view: TerminalView, compact: boolean): string {
        if (view.appearance === 'human' && view.state === 'idle') return `human-${compact ? 'compact' : 'regular'}.sixel`;
        const startedAt = view.state === 'idle' ? view.appearanceStartedAt ?? view.stateStartedAt : view.stateStartedAt;
        return this.assets.frameKey(view.appearance === 'cat' ? 'idle' : view.state, compact, Math.max(0, Date.now() - startedAt), this.options.reducedMotion);
    }

    graphicColumns(compact: boolean): number {
        const size = this.assets.dimensions[compact ? 'compact' : 'regular'];
        const cell = this.cellSize();
        if (['sixel', 'kitty', 'native'].includes(this.options.graphics) && this.options.color) return compact ? 15 : 30;
        return Math.max(1, Math.min(compact ? 15 : 30, Math.floor((compact ? 9 : 17) * size.width * cell.height / (size.height * cell.width))));
    }

    private cellSize(): { width: number; height: number } {
        const cell = this.options.cellSize;
        return cell && Number.isFinite(cell.width) && Number.isFinite(cell.height) && cell.width > 0 && cell.height > 0 ? cell : { width: 10, height: 20 };
    }

    frameHeight(height: number, _inline = false): number { return Math.max(10, Math.min(100, Math.floor(height))); }

    clearFrame(): string {
        if (!this.frameRows) return '';
        return this.background() + `\x1b[${this.frameTop + 1};1H\x1b[J\x1b[0m` + (this.options.graphics === 'kitty' ? `\x1b_Ga=d,d=I,i=${this.imageId},q=2\x1b\\` : '');
    }

    releaseFrame(_height: number): string {
        if (!this.frameRows) return '';
        const row = 0;
        const output = `\x1b[0m\x1b[${row + 1};1H\x1b[J` + (this.options.graphics === 'kitty' ? `\x1b_Ga=d,d=I,i=${this.imageId},q=2\x1b\\` : '') + `\x1b[${row + 1};1H\x1b[?25h`;
        this.frameRows = 0; this.frameTop = 0; this.reset();
        return output;
    }

    appendTranscript(text: string, height: number): string {
        const rows = this.frameHeight(height, true);
        const output = this.clearFrame() + terminalSafeText(text).replace(/\n/g, '\r\n') + '\r\n'.repeat(rows + 1);
        this.reset(); this.frameRows = rows; this.frameTop = Math.max(0, height - rows);
        return output;
    }

    geometry(width: number, height: number, inline = false): TerminalGeometry {
        const columns = Math.max(20, Math.min(300, Math.floor(width)));
        const rows = this.frameHeight(height, inline);
        const measure = (compact: boolean): TerminalGeometry => {
            const bodyRows = compact ? 9 : 17;
            const graphicColumns = this.graphicColumns(compact);
            const reservedRows = ['sixel', 'kitty', 'native'].includes(this.options.graphics) && this.options.color ? 12 : 13;
            return { compact, bodyRows, graphicColumns, canDraw: rows >= bodyRows + reservedRows && columns >= graphicColumns + 40 };
        };
        const regular = measure(columns < 90 || rows < 29);
        return regular.canDraw || regular.compact ? regular : measure(true);
    }

    nativeImage(view: TerminalView, width: number, height: number): { key: string; frame: RasterFrame; rectangle: NativeImageRectangle } | undefined {
        if (this.options.graphics !== 'native' || !this.options.color || !this.assets.sprites) return;
        const geometry = this.geometry(width, height, view.inline);
        if (!geometry.canDraw) return;
        const rows = this.frameHeight(height, view.inline);
        const origin = view.inline ? Math.max(0, height - rows) : 0;
        const key = this.frameKey(view, false);
        return { key, frame: this.assets.raster(key), rectangle: { column: 3, row: origin + 3, columns: geometry.graphicColumns, rows: geometry.bodyRows } };
    }

    render(view: TerminalView, width: number, height: number): string {
        const columns = Math.max(20, Math.min(300, Math.floor(width)));
        const rows = this.frameHeight(height, view.inline);
        const origin = view.inline ? Math.max(0, height - rows) : 0;
        const moved = this.frameRows > 0 && origin !== this.frameTop;
        const clearViewport = this.viewportChanged || !this.previousGeometry ? this.background() + '\x1b[H\x1b[0J' : '';
        this.viewportChanged = false;
        const clearPrevious = moved ? this.background() + `\x1b[${Math.min(origin, this.frameTop) + 1};1H\x1b[J` : '';
        this.frameTop = origin; this.frameRows = rows;
        const { compact, bodyRows, canDraw, graphicColumns } = this.geometry(columns, rows);
        const image = canDraw && this.options.color && ['sixel', 'kitty', 'native'].includes(this.options.graphics) && Boolean(this.assets.sprites);
        const asciiDecorations = !image;
        const geometry = JSON.stringify([columns, rows, origin, compact, bodyRows, graphicColumns, this.options.graphics, this.options.color, this.cellSize()]);
        if (geometry !== this.previousGeometry) { this.previous = []; this.previousImage = ''; this.previousGeometry = geometry; }
        const elapsed = Math.max(0, Date.now() - view.stateStartedAt);
        const frameKey = this.frameKey(view, compact);
        const textMetrics = this.textMetrics;
        const cells: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({ text: ' ', foreground: theme.foreground, background: theme.background })));
        const put = (column: number, row: number, value: unknown, tone = theme.foreground, background = theme.background, bold = false, limit = columns - column - 1) => {
            if (row < 0 || row >= rows || column < 0 || column >= columns) return;
            let position = column;
            for (const text of graphemes(fitText(value, Math.max(0, limit), textMetrics))) {
                const size = characterWidth(text, textMetrics);
                if (!size || position + size >= columns) break;
                cells[row][position] = { text, foreground: tone, background, bold };
                for (let extra = 1; extra < size; extra += 1) cells[row][position + extra] = { text: '', foreground: tone, background, continuation: true };
                position += size;
            }
        };
        put(2, 0, 'sandbox_agent' + (view.heading ? ' · ' + view.heading : ''), theme.accent, theme.background, true);
        put(2, 1, view.logs.at(-1) || view.connection, theme.muted);
        put(2, 2, (asciiDecorations ? '-' : '─').repeat(Math.floor((columns - 4) / characterWidth(asciiDecorations ? '-' : '─', textMetrics))), theme.border);
        let spriteWidth = 0;
        if (canDraw && this.options.graphics !== 'none' && this.assets.sprites) {
            spriteWidth = graphicColumns;
            if (!image) {
                const frame = this.assets.raster(frameKey);
                const cell = this.cellSize();
                const pixelRows = Math.max(1, Math.min(bodyRows, Math.round(frame.height * spriteWidth * cell.width / (frame.width * cell.height))));
                const topRow = 3 + Math.floor((bodyRows - pixelRows) / 2);
                const background = Number.parseInt(theme.background.slice(1), 16);
                const sampled = sampleRaster(frame, spriteWidth, pixelRows);
                for (let row = 0; row < pixelRows; row += 1) for (let column = 0; column < spriteWidth; column += 1) {
                    const pixel = sampled.pixels[row * spriteWidth + column];
                    const value = pixel < 0 ? background : pixel;
                    const rgb = [value >> 16 & 255, value >> 8 & 255, value & 255];
                    const color = '#' + value.toString(16).padStart(6, '0');
                    const shade = pixel >= 0 ? '@%#*+=-:.'[Math.min(8, Math.floor((rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 256 * 9))] : ' ';
                    put(3 + column, topRow + row, this.options.color ? ' ' : shade, theme.foreground, color);
                }
            }
        }
        const suppliedCell = this.options.cellSize;
        const measuredCell = suppliedCell && Number.isFinite(suppliedCell.width) && Number.isFinite(suppliedCell.height) && suppliedCell.width > 0 && suppliedCell.height > 0;
        const action = ({ idle: '休息', thinking: '思考', searching: '查阅', typing: '写入', approval: '等待批准', compact: '整理上下文', complete: '完成' } as const)[view.state];
        const motion = this.options.reducedMotion ? '' : ['·  ', '·· ', '···'][Math.floor(elapsed / 350) % 3];
        const graphicsNotice = !canDraw ? `${action} ${motion} · 窗口空间不足，角色暂时隐藏` : !image
            ? `${action} ${motion} · ` + (this.options.color ? '字格兼容画面' : '文字兼容画面') + (measuredCell ? '' : ' · 字格按10x20估计') : `${action} ${motion}`;
        if (this.options.graphics !== 'none' && !(image && this.options.graphics === 'native')) put(2, rows - 10, this.assets.reason ?? graphicsNotice, theme.muted);
        const detailColumn = spriteWidth ? 3 + spriteWidth + 4 : 2;
        view.details.slice(0, canDraw ? bodyRows : Math.max(1, rows - (this.options.graphics === 'none' ? 12 : 13))).forEach((line, index) => put(detailColumn, 3 + index, line, index === 0 ? theme.accent : theme.foreground, theme.background, index === 0, columns - detailColumn - 2));
        put(2, rows - 9, view.status, theme.accent);
        const metrics = view.metrics ?? view.logs.slice(-2);
        metrics.slice(0, 3).forEach((line, index) => put(2, rows - 8 + index, line, theme.muted));
        const horizontal = asciiDecorations ? '-' : '─';
        const corners = asciiDecorations ? ['+', '+', '+', '+'] : ['╭', '╮', '╰', '╯'];
        const borderLength = Math.max(0, Math.floor((columns - 4 - visibleWidth(corners[0] + corners[1], textMetrics)) / characterWidth(horizontal, textMetrics)));
        const border = horizontal.repeat(borderLength);
        put(2, rows - 5, corners[0] + border + corners[1], theme.border);
        const input = view.hidden ? (asciiDecorations ? '*' : '•').repeat(Math.min(40, view.draft.cursorGrapheme)) : view.draft.text;
        const draftLayout = layoutDraftInput(input, view.draft.cursorGrapheme, columns - 8, asciiDecorations ? '|' : '▏', textMetrics);
        draftLayout.lines.forEach((line, index) => put(4, rows - 4 + index, line || ' ', theme.foreground, theme.input, false, columns - 8));
        put(2, rows - 2, corners[2] + border + corners[3], theme.border);
        put(2, rows - 1, view.inputLabel ? `${view.inputLabel}${asciiDecorations ? ' | ' : ' · '}${view.hint}` : view.hint, theme.muted);
        const output = cells.map(line => {
            let previousStyle = '';
            let result = '';
            let end = line.length;
            while (end && line[end - 1].text === ' ' && line[end - 1].background === theme.background) end -= 1;
            for (const cell of line.slice(0, end)) {
                if (cell.continuation) continue;
                const nextStyle = this.options.color ? style(cell.foreground, cell.background, cell.bold) : '';
                if (nextStyle !== previousStyle) { result += nextStyle; previousStyle = nextStyle; }
                result += cell.text;
            }
            return result + (this.options.color ? style(theme.foreground, theme.background) : '') + '\x1b[K' + (this.options.color ? '\x1b[0m' : '');
        });
        const dirty = output.map((line, index) => this.options.fullRedraw || line !== this.previous[index]);
        let result = clearViewport + clearPrevious + output.map((line, index) => dirty[index] ? `\x1b[${origin + index + 1};1H${line}` : '').join('');
        this.previous = output;
        if (image && this.options.graphics !== 'native') {
            const key = frameKey;
            if (key !== this.previousImage || dirty.slice(3, 3 + bodyRows).some(Boolean)) {
                const clear = Array.from({ length: bodyRows }, (_, row) => `\x1b[${origin + row + 4};4H${style(theme.foreground, theme.background)}${' '.repeat(spriteWidth)}`).join('');
                const cell = this.cellSize();
                const pixelWidth = Math.max(1, Math.round(spriteWidth * cell.width));
                const pixelHeight = Math.max(1, Math.round(bodyRows * cell.height));
                const graphic = this.options.graphics === 'kitty' ? this.assets.kitty(key, pixelWidth, pixelHeight, spriteWidth, bodyRows, this.imageId) : this.assets.scaledSixel(key, pixelWidth, pixelHeight);
                result += `\x1b7${clear}\x1b[${origin + 4};4H${graphic}\x1b8`;
                this.previousImage = key;
            }
        }
        this.lastRenderChanged = Boolean(result);
        return (result ? '\x1b[?25l' + result : '') + `\x1b[${origin + rows - 3 + draftLayout.cursor.row};${5 + draftLayout.cursor.column}H\x1b[?25h`;
    }
}
