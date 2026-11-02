import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeSixel, type RasterFrame } from './sixel-raster.js';

export type MascotState = 'idle' | 'thinking' | 'searching' | 'typing' | 'approval' | 'compact' | 'complete';
export interface SpriteFrame { width: number; height: number; rows: string[] }
export interface Sprites {
    palette: Record<string, string | null>;
    states: Record<MascotState, SpriteFrame[]>;
    compactStates: Record<MascotState, SpriteFrame[]>;
}
interface FrameEntry { file: string; durationMs: number }

export class CharacterAssets {
    readonly directory: URL | undefined;
    readonly sprites: Sprites | undefined;
    readonly reason?: string;
    private animations: Partial<Record<MascotState, Record<string, FrameEntry[]>>> = {};
    private readonly hashes = new Map<string, string>();
    private readonly cache = new Map<string, Buffer>();
    private cacheBytes = 0;
    private readonly rasters = new Map<string, RasterFrame>();
    readonly dimensions = { regular: { width: 300, height: 340 }, compact: { width: 150, height: 180 } };

    constructor(readonly cacheEnabled = true) {
        const candidates = [new URL('../../assets/agent/', import.meta.url), new URL('../../../assets/agent/', import.meta.url)];
        this.directory = candidates.find(directory => existsSync(new URL('manifest.json', directory)));
        if (!this.directory) { this.reason = '角色素材尚未打包，当前使用纯文字'; return; }
        try {
            const manifest = JSON.parse(readFileSync(new URL('manifest.json', this.directory), 'utf8')) as { files: { path: string; sha256: string }[]; regular?: { width: number; height: number }; compact?: { width: number; height: number } };
            for (const size of ['regular', 'compact'] as const) {
                const dimensions = manifest[size];
                if (dimensions && Number.isInteger(dimensions.width) && Number.isInteger(dimensions.height)
                    && dimensions.width > 0 && dimensions.height > 0 && dimensions.width * dimensions.height <= 1024 * 1024) this.dimensions[size] = dimensions;
            }
            for (const file of manifest.files) this.hashes.set(file.path, file.sha256);
            this.sprites = JSON.parse(this.load('sprites.json').toString('utf8')) as Sprites;
            for (const state of ['idle', 'thinking', 'searching', 'typing', 'approval', 'compact', 'complete'] as MascotState[]) {
                if (!this.sprites.states[state]?.length || !this.sprites.compactStates[state]?.length) throw new Error('角色状态不完整');
            }
            this.animations = JSON.parse(this.load('sixel/animation-index.json').toString('utf8'));
        } catch { this.sprites = undefined; this.reason = '角色素材校验失败，当前使用纯文字'; }
    }

    frameKey(state: MascotState, compact: boolean, elapsedMs: number, reduced: boolean): string {
        const entries = this.animations[state]?.[compact ? 'compact' : 'regular'];
        if (!entries?.length) return `${state === 'idle' ? 'cat' : 'human'}-${compact ? 'compact' : 'regular'}.sixel`;
        if (reduced) return entries[0].file;
        let time = Math.max(0, elapsedMs);
        const duration = entries.reduce((sum, entry) => sum + entry.durationMs, 0);
        if (state === 'idle') {
            time %= 10_000 + duration;
            if (time < 10_000) return entries[0].file;
            time -= 10_000;
        } else time %= duration;
        for (const entry of entries) {
            if (time < entry.durationMs) return entry.file;
            time -= entry.durationMs;
        }
        return entries[0].file;
    }

    sixel(key: string): string {
        return this.load(`sixel/${key}`).toString('ascii');
    }

    nextFrameDelay(state: MascotState, compact: boolean, elapsedMs: number, reduced: boolean): number {
        if (reduced) return 10_000;
        const entries = this.animations[state]?.[compact ? 'compact' : 'regular'];
        if (!entries?.length) return state === 'idle' ? 1000 : 250;
        const duration = entries.reduce((sum, entry) => sum + entry.durationMs, 0);
        let time = Math.max(0, elapsedMs) % (state === 'idle' ? 10_000 + duration : duration);
        if (state === 'idle') {
            if (time < 10_000) return Math.max(16, Math.min(1000, 10_000 - time));
            time -= 10_000;
        }
        for (const entry of entries) {
            if (time < entry.durationMs) return Math.max(16, Math.min(1000, entry.durationMs - time));
            time -= entry.durationMs;
        }
        return 16;
    }

    raster(key: string): RasterFrame {
        const cached = this.rasters.get(key);
        if (cached && this.cacheEnabled) return cached;
        const frame = decodeSixel(this.sixel(key));
        if (this.cacheEnabled) {
            while (this.rasters.size >= 4) this.rasters.delete(this.rasters.keys().next().value!);
            this.rasters.set(key, frame);
        }
        return frame;
    }

    clear(): void { this.cache.clear(); this.rasters.clear(); this.cacheBytes = 0; }

    private load(path: string): Buffer {
        if (!this.directory || !/^[a-zA-Z0-9_./-]+$/.test(path) || path.includes('..')) throw new Error('素材路径无效');
        const cached = this.cache.get(path);
        if (cached && this.cacheEnabled) { this.cache.delete(path); this.cache.set(path, cached); return cached; }
        const location = new URL(path, this.directory);
        if (statSync(fileURLToPath(location)).size > 2 * 1024 * 1024) throw new Error('单帧素材过大');
        const bytes = readFileSync(location);
        if (createHash('sha256').update(bytes).digest('hex') !== this.hashes.get(path)) throw new Error('素材哈希不匹配');
        if (this.cacheEnabled) {
            while (this.cache.size >= 24 || this.cacheBytes + bytes.length > 8 * 1024 * 1024) {
                const oldest = this.cache.keys().next().value;
                if (!oldest) break;
                this.cacheBytes -= this.cache.get(oldest)!.length;
                this.cache.delete(oldest);
            }
            this.cache.set(path, bytes); this.cacheBytes += bytes.length;
        }
        return bytes;
    }
}
