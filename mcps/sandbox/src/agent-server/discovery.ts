import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { AgentFault, PROTOCOL_VERSION, type ServerDescriptor } from './protocol.js';

export interface RuntimeAuthority {
    dataDir: string;
    runtimeDir: string;
    principalId: string;
    credentialRef: string;
    secret: Buffer;
    endpoint: string;
}

export interface EnsureServerOptions {
    dataDir?: string;
    serverEntry?: string;
    startupTimeoutMs?: number;
    deadlineAt?: string;
}

export function defaultDataDir(): string {
    return resolve(process.env.SANDBOX_AGENT_HOME || join(homedir(), '.local', 'share', 'sandbox-agent'));
}

export function endpointFor(dataDir: string): string {
    const normalized = process.platform === 'win32' ? resolve(dataDir).toLowerCase() : resolve(dataDir);
    const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 32);
    return process.platform === 'win32' ? `\\\\.\\pipe\\sandbox-agent-${digest}` : join(tmpdir(), `sandbox-agent-${digest}.sock`);
}

async function privateDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const marker = join(directory, '.sandbox-agent-runtime');
    const names = await fs.readdir(directory);
    if (!names.includes('.sandbox-agent-runtime') && names.length > 0) {
        throw new AgentFault('RUNTIME_DIRECTORY_NOT_OWNED', '运行目录已有未知文件，保留现场并选择独立dataDir');
    }
    if (process.platform === 'win32') {
        const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
        const sid = identity.match(/S-1-5-\d+(?:-\d+)+/)?.[0];
        if (!sid) throw new AgentFault('RUNTIME_ACL_UNAVAILABLE', '无法确定当前用户，未创建控制凭据');
        execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], {
            windowsHide: true, timeout: 10_000, stdio: 'pipe' });
    } else {
        await fs.chmod(directory, 0o700);
    }
    const handle = await fs.open(marker, 'a', 0o600);
    await handle.close();
}

async function readOrCreate(path: string, create: () => string): Promise<string> {
    let handle;
    try {
        handle = await fs.open(path, 'wx', 0o600);
        const content = create();
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        return content;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const stat = await fs.stat(path);
            if (stat.size > 0 && stat.size <= 1024) return fs.readFile(path, 'utf8');
            await new Promise(resolveWait => setTimeout(resolveWait, 25));
        }
        throw new AgentFault('RUNTIME_IDENTITY_INCOMPLETE', '控制身份文件未完整写入，请保留原文件后检查');
    } finally {
        await handle?.close();
    }
}

export async function initializeRuntime(dataDir = defaultDataDir()): Promise<RuntimeAuthority> {
    const resolved = resolve(dataDir);
    const runtimeDir = join(resolved, 'runtime');
    await privateDirectory(runtimeDir);
    const identityText = await readOrCreate(join(runtimeDir, 'identity.json'), () => JSON.stringify({ schemaVersion: 1, principalId: randomUUID() }));
    const identity = JSON.parse(identityText) as { schemaVersion: number; principalId: string };
    if (identity.schemaVersion !== 1 || typeof identity.principalId !== 'string' || !identity.principalId) {
        throw new AgentFault('RUNTIME_IDENTITY_INVALID', '控制身份文件格式不受支持');
    }
    const credentialRef = join(runtimeDir, 'control.key');
    const keyText = await readOrCreate(credentialRef, () => randomBytes(32).toString('base64'));
    const secret = Buffer.from(keyText.trim(), 'base64');
    if (secret.length !== 32) throw new AgentFault('RUNTIME_CREDENTIAL_INVALID', '控制凭据格式无效，未覆盖原件');
    return { dataDir: resolved, runtimeDir, principalId: identity.principalId, credentialRef, secret, endpoint: endpointFor(resolved) };
}

export async function readServerDescriptor(dataDir = defaultDataDir()): Promise<ServerDescriptor | null> {
    try {
        const path = join(resolve(dataDir), 'runtime', 'server.json');
        const stat = await fs.stat(path);
        if (stat.size > 8192) throw new AgentFault('SERVER_DESCRIPTOR_INVALID', '核心描述文件超出大小限制');
        const value = JSON.parse(await fs.readFile(path, 'utf8')) as ServerDescriptor;
        if (value.protocolVersion !== PROTOCOL_VERSION || value.endpoint !== endpointFor(dataDir)
            || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.serverInstanceId !== 'string') {
            throw new AgentFault('SERVER_DESCRIPTOR_INVALID', '核心描述文件与本dataDir不匹配');
        }
        return value;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

export async function publishDescriptor(authority: RuntimeAuthority, descriptor: ServerDescriptor): Promise<void> {
    const pending = join(authority.runtimeDir, `server.${descriptor.serverInstanceId}.pending`);
    const handle = await fs.open(pending, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify(descriptor), 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
    await fs.rename(pending, join(authority.runtimeDir, 'server.json'));
}

export function processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function endpointAlive(endpoint: string): Promise<boolean> {
    return new Promise(resolveProbe => {
        const socket = connect(endpoint);
        const finish = (alive: boolean) => { socket.destroy(); resolveProbe(alive); };
        socket.setTimeout(250, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

export async function ensureAgentServer(options: EnsureServerOptions = {}): Promise<ServerDescriptor> {
    const dataDir = resolve(options.dataDir ?? defaultDataDir());
    const deadline = Date.now() + (options.startupTimeoutMs ?? 10_000);
    let descriptor = await readServerDescriptor(dataDir);
    if (descriptor && await endpointAlive(descriptor.endpoint)) return descriptor;
    if (descriptor && processAlive(descriptor.pid)) {
        throw new AgentFault('SERVER_UNAVAILABLE', '原核心进程仍在，保留它并核对连接状态', { pid: descriptor.pid }, false, true);
    }
    const serverEntry = resolve(options.serverEntry ?? fileURLToPath(new URL('./main.js', import.meta.url)));
    try { await fs.access(serverEntry); }
    catch { throw new AgentFault('AGENT_BUILD_REQUIRED', 'Agent Server尚未构建，请先构建本安装包'); }
    await fs.mkdir(join(dataDir, 'runtime'), { recursive: true, mode: 0o700 });
    const args = ['--max-semi-space-size=8', serverEntry, '--data-dir', dataDir];
    if (options.deadlineAt) args.push('--deadline-at', options.deadlineAt);
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore', cwd: dirname(serverEntry) });
    const startupState: { error?: Error } = {};
    child.once('error', error => { startupState.error = error; });
    child.unref();
    while (Date.now() < deadline) {
        if (startupState.error) throw new AgentFault('SERVER_START_FAILED', '无法启动本包核心进程', { cause: startupState.error.message });
        descriptor = await readServerDescriptor(dataDir);
        if (descriptor && await endpointAlive(descriptor.endpoint)) return descriptor;
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    throw new AgentFault('SERVER_START_TIMEOUT', '核心启动尚未确认，保留原PID后查询，未重复启动', { pid: child.pid ?? null }, true, true);
}
