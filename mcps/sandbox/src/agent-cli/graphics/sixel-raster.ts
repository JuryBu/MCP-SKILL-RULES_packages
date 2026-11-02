export interface RasterFrame { width: number; height: number; pixels: Int32Array }

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
