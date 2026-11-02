import type { RasterFrame } from './sixel-raster.js';

export type RasterSampling = 'nearest' | 'palette-medoid' | 'detail-preserving';

function luminance(color: number): number {
    return (color >> 16 & 255) * 0.2126 + (color >> 8 & 255) * 0.7152 + (color & 255) * 0.0722;
}

export function sampleRaster(frame: RasterFrame, columns: number, rows: number, method: RasterSampling = 'detail-preserving'): RasterFrame {
    const pixels = new Int32Array(columns * rows).fill(-1);
    for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
        const firstRow = Math.floor(row * frame.height / rows);
        const lastRow = Math.max(firstRow + 1, Math.floor((row + 1) * frame.height / rows));
        const firstColumn = Math.floor(column * frame.width / columns);
        const lastColumn = Math.max(firstColumn + 1, Math.floor((column + 1) * frame.width / columns));
        const center = frame.pixels[Math.floor((firstRow + lastRow - 1) / 2) * frame.width + Math.floor((firstColumn + lastColumn - 1) / 2)];
        if (method === 'nearest') { pixels[row * columns + column] = center; continue; }
        const histogram = new Map<number, number>();
        let occupied = 0;
        for (let pixelRow = firstRow; pixelRow < lastRow; pixelRow += 1) for (let pixelColumn = firstColumn; pixelColumn < lastColumn; pixelColumn += 1) {
            const color = frame.pixels[pixelRow * frame.width + pixelColumn];
            if (color >= 0) { histogram.set(color, (histogram.get(color) ?? 0) + 1); occupied += 1; }
        }
        if (occupied < (lastRow - firstRow) * (lastColumn - firstColumn) / 2) continue;
        let colors = [...histogram].map(([color, count]) => ({ color, count, light: luminance(color) }));
        if (method === 'detail-preserving') {
            colors.sort((left, right) => left.light - right.light);
            let accumulated = 0;
            const quantile = (fraction: number): number => {
                accumulated = 0;
                for (const entry of colors) { accumulated += entry.count; if (accumulated >= occupied * fraction) return entry.light; }
                return colors.at(-1)!.light;
            };
            const dark = quantile(0.15);
            const light = quantile(0.85);
            if (light - dark >= 60) colors = colors.filter(entry => entry.light <= dark + 16);
        }
        const count = colors.reduce((sum, entry) => sum + entry.count, 0);
        const channels = [16, 8, 0].map(shift => colors.reduce((sum, entry) => sum + (entry.color >> shift & 255) * entry.count, 0) / count);
        let selected = colors[0].color;
        let distance = Infinity;
        for (const entry of colors) {
            const next = [16, 8, 0].reduce((sum, shift, index) => sum + ((entry.color >> shift & 255) - channels[index]) ** 2, 0);
            if (next < distance || next === distance && entry.color === center) { distance = next; selected = entry.color; }
        }
        pixels[row * columns + column] = selected;
    }
    return { width: columns, height: rows, pixels };
}
