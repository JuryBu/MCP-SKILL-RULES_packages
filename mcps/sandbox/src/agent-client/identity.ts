import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentFault } from '../agent-server/protocol.js';

export async function getOrCreateClientId(dataDir: string, name = 'cli'): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new AgentFault('INVALID_PARAMS', '客户端名称须为1至64个字母、数字、下划线或连字符');
    const directory = join(dataDir, 'runtime', 'clients');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${name}.json`);
    try {
        const file = await open(path, 'wx', 0o600);
        try {
            const clientId = randomUUID();
            await file.writeFile(JSON.stringify({ schemaVersion: 1, clientId }) + '\n', 'utf8');
            await file.sync();
            return clientId;
        } finally {
            await file.close();
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new AgentFault('CLIENT_STATE_UNAVAILABLE', '无法建立客户端身份文件');
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const file = await open(path, 'r');
            let raw: string;
            try {
                const buffer = Buffer.alloc(2049);
                const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
                if (bytesRead === buffer.length) throw new Error('身份文件过大');
                raw = buffer.subarray(0, bytesRead).toString('utf8');
            } finally { await file.close(); }
            const identity: unknown = JSON.parse(raw);
            if (identity && typeof identity === 'object' && !Array.isArray(identity)) {
                const record = identity as Record<string, unknown>;
                if (record.schemaVersion === 1 && typeof record.clientId === 'string' && record.clientId.length > 0 && record.clientId.length <= 256) return record.clientId;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentFault('CLIENT_STATE_UNAVAILABLE', '客户端身份文件已消失，请重试连接');
        }
        if (attempt < 4) await delay(20);
    }
    throw new AgentFault('CLIENT_STATE_INVALID', '客户端身份文件无效，请保留原件后检查该数据目录');
}
