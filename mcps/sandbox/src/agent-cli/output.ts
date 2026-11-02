import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentFault } from '../agent-server/protocol.js';

export async function saveVerifiedArtifact(path: string, bytes: Buffer, force = false): Promise<string> {
    const destination = resolve(path);
    const temporary = join(dirname(destination), '.sandbox-agent-export-' + randomUUID() + '.tmp');
    try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        if (force) await fs.rename(temporary, destination);
        else { await fs.link(temporary, destination); await fs.unlink(temporary); }
        return destination;
    } catch (error) {
        throw new AgentFault('E_CLI_OUTPUT', '产物保存未完成，目标已有文件时需要明确--force', { path: destination, reason: error instanceof Error ? error.message : String(error) });
    } finally { await fs.unlink(temporary).catch(() => {}); }
}
