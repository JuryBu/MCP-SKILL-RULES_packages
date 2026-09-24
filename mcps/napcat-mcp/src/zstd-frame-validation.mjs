const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC = 0x184d2a50;
const DICTIONARY_ID_BYTES = [0, 1, 2, 4];
const CONTENT_SIZE_BYTES = [0, 2, 4, 8];

export function visitZstdFrames(body, onFrame) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  let offset = 0;
  if (bytes.length === 0) return false;
  const hasBytes = count => count <= bytes.length - offset;

  while (offset < bytes.length) {
    if (!hasBytes(4)) return false;
    const frameStart = offset;
    const magic = bytes.readUInt32LE(offset);
    if ((magic & 0xfffffff0) === SKIPPABLE_MAGIC) {
      if (!hasBytes(8)) return false;
      const frameSize = bytes.readUInt32LE(offset + 4);
      offset += 8;
      if (!hasBytes(frameSize)) return false;
      offset += frameSize;
      continue;
    }
    if (magic !== ZSTD_MAGIC) return false;
    offset += 4;
    if (!hasBytes(1)) return false;
    const descriptor = bytes[offset++];
    const singleSegment = (descriptor & 0x20) !== 0;
    const dictionaryIdBytes = DICTIONARY_ID_BYTES[descriptor & 0x03];
    const contentSizeFlag = descriptor >>> 6;
    const contentSizeBytes = contentSizeFlag === 0 && singleSegment ? 1 : CONTENT_SIZE_BYTES[contentSizeFlag];
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryIdBytes + contentSizeBytes;
    if (!hasBytes(remainingHeaderBytes)) return false;
    offset += remainingHeaderBytes;

    let lastBlock = false;
    while (!lastBlock) {
      if (!hasBytes(3)) return false;
      const blockHeader = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
      offset += 3;
      lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      if (blockType === 3) return false;
      const blockSize = blockHeader >>> 3;
      const contentBytes = blockType === 1 ? 1 : blockSize;
      if (!hasBytes(contentBytes)) return false;
      offset += contentBytes;
    }
    if ((descriptor & 0x04) !== 0) {
      if (!hasBytes(4)) return false;
      offset += 4;
    }
    if (onFrame?.(bytes.subarray(frameStart, offset)) === false) return false;
  }
  return true;
}

export function isCompleteZstdFrameSequence(body) {
  return visitZstdFrames(body);
}
