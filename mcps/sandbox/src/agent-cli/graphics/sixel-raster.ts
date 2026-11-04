export interface RasterFrame { width: number; height: number; pixels: Int32Array }

export function fitRaster(frame: RasterFrame, width: number, height: number): RasterFrame {
    width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
    if (width * height > 1024 * 1024) throw new Error('角色显示尺寸超出范围');
    const scale = Math.min(width / frame.width, height / frame.height);
    const scaledWidth = Math.max(1, Math.floor(frame.width * scale));
    const scaledHeight = Math.max(1, Math.floor(frame.height * scale));
    const left = Math.floor((width - scaledWidth) / 2);
    const top = Math.floor((height - scaledHeight) / 2);
    const pixels = new Int32Array(width * height).fill(-1);
    for (let row = 0; row < scaledHeight; row += 1) for (let column = 0; column < scaledWidth; column += 1) {
        pixels[(top + row) * width + left + column] = frame.pixels[Math.min(frame.height - 1, Math.floor(row / scale)) * frame.width + Math.min(frame.width - 1, Math.floor(column / scale))];
    }
    return { width, height, pixels };
}

export function encodeSixel(frame: RasterFrame): string {
    const palette = [...new Set(frame.pixels)].filter(color => color >= 0);
    let output = `\x1bP0;1;0q"1;1;${frame.width};${frame.height}`;
    palette.forEach((color, index) => { output += `#${index};2;${[color >> 16 & 255, color >> 8 & 255, color & 255].map(channel => Math.round(channel * 100 / 255)).join(';')}`; });
    for (let row = 0; row < frame.height; row += 6) {
        palette.forEach((color, index) => {
            let band = '';
            for (let column = 0; column < frame.width; column += 1) {
                let bits = 0;
                for (let bit = 0; bit < 6 && row + bit < frame.height; bit += 1) if (frame.pixels[(row + bit) * frame.width + column] === color) bits |= 1 << bit;
                band += String.fromCharCode(63 + bits);
            }
            band = band.replace(/\?+$/, '');
            if (band) output += `#${index}` + band.replace(/([?-~])\1{3,}/g, run => `!${run.length}${run[0]}`) + '$';
        });
        if (row + 6 < frame.height) output += '-';
    }
    return output + '\x1b\\';
}

export function decodeSixel(source: string): RasterFrame {
    const header = /^\x1bP[\d;]*q"1;1;(\d+);(\d+)/.exec(source);
    if (!header) throw new Error('角色图片缺少方形像素尺寸');
    const width = Number(header[1]);
    const height = Number(header[2]);
    if (width < 1 || height < 1 || width * height > 1024 * 1024) throw new Error('角色图片尺寸无效');
    const pixels = new Int32Array(width * height).fill(-1);
    const palette = new Map<number, number>();
    let color = -1;
    let column = 0;
    let row = 0;
    let position = header[0].length;
    const numbers = (): number[] => {
        const start = position;
        while (/[\d;]/.test(source[position] ?? '')) position += 1;
        return source.slice(start, position).split(';').map(Number);
    };
    const paint = (symbol: string, count: number) => {
        const bits = symbol.charCodeAt(0) - 63;
        if (bits < 0 || bits > 63 || count < 1 || count > 1024 * 1024) throw new Error('角色图片像素编码无效');
        for (let repeat = 0; repeat < count; repeat += 1) {
            if (column < width) for (let bit = 0; bit < 6; bit += 1) {
                if (bits & (1 << bit) && row + bit < height) pixels[(row + bit) * width + column] = color;
            }
            column += 1;
        }
    };
    while (position < source.length && source[position] !== '\x1b') {
        const symbol = source[position++];
        if (symbol === '#') {
            const values = numbers();
            if (values.length === 5 && values[1] === 2) {
                const channels = values.slice(2).map(value => Math.round(value * 255 / 100));
                palette.set(values[0], (channels[0] << 16) | (channels[1] << 8) | channels[2]);
            }
            color = palette.get(values[0]) ?? -1;
        } else if (symbol === '!') {
            const count = numbers()[0];
            paint(source[position++], count);
        }
        else if (symbol === '$') column = 0;
        else if (symbol === '-') { column = 0; row += 6; }
        else paint(symbol, 1);
    }
    return { width, height, pixels };
}
