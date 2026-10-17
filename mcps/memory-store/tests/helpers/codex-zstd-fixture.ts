export function encodeCodexArchiveFixture(value: Buffer): Buffer {
    const header = Buffer.alloc(9);
    header.writeUInt32LE(0xfd2fb528);
    header[4] = 0xa0;
    header.writeUInt32LE(value.length, 5);
    const blocks = [header];
    for (let position = 0; position < value.length || position === 0;) {
        const count = Math.min(128 * 1024, value.length - position);
        const last = position + count === value.length;
        const block = Buffer.alloc(3);
        block.writeUIntLE(count * 8 + Number(last), 0, 3);
        blocks.push(block, value.subarray(position, position + count));
        position += count;
        if (last) break;
    }
    return Buffer.concat(blocks);
}
