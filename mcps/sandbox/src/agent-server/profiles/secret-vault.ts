import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import { objectValue } from '../providers/assemble.js';
import type { CredentialAccess } from '../providers/dispatch.js';

export interface ProtectedSecret {
    credentialRef: string;
    generation: number;
    profileId: string;
    purpose: string;
    format: 'dpapi-current-user-v1';
    ciphertextBase64: string;
    createdAt: string;
    revoked: boolean;
}

export interface ProtectedSecretPort {
    get(credentialRef: string, generation: number): Promise<ProtectedSecret | null>;
    put(secret: ProtectedSecret): Promise<void>;
    revoke(credentialRef: string, generation: number): Promise<void>;
}

export interface SecretBackend {
    protect(secret: Uint8Array, purpose: string): Promise<string>;
    unprotect(ciphertextBase64: string, purpose: string): Promise<Uint8Array>;
}

export interface SecretDescriptor {
    credentialRef: string;
    generation: number;
    configured: boolean;
    revoked: boolean;
}

export class MemoryProtectedSecretPort implements ProtectedSecretPort {
    private readonly secrets = new Map<string, ProtectedSecret>();
    async get(credentialRef: string, generation: number): Promise<ProtectedSecret | null> {
        const value = this.secrets.get(canonicalJson([credentialRef, generation]));
        return value ? structuredClone(value) : null;
    }
    async put(secret: ProtectedSecret): Promise<void> {
        const identity = canonicalJson([secret.credentialRef, secret.generation]);
        const current = this.secrets.get(identity);
        if (current && canonicalJson(current) !== canonicalJson(secret)) throw new AgentFault('E_CREDENTIAL_CONFLICT', '该凭据引用已有不同密文');
        this.secrets.set(identity, structuredClone(secret));
    }
    async revoke(credentialRef: string, generation: number): Promise<void> {
        const value = this.secrets.get(canonicalJson([credentialRef, generation]));
        if (!value) throw new AgentFault('E_CREDENTIAL_NOT_FOUND', '凭据引用不存在');
        value.revoked = true;
    }
}

export class SecretVault implements CredentialAccess {
    constructor(readonly port: ProtectedSecretPort, private readonly backend: SecretBackend) {}

    async create(profileId: string, generation: number, input: Uint8Array, reference?: string): Promise<SecretDescriptor> {
        if (!profileId || !Number.isSafeInteger(generation) || generation < 1 || input.byteLength < 1 || input.byteLength > 65_536) {
            throw new AgentFault('E_SECRET_INVALID', '凭据身份、代次或大小无效');
        }
        const credentialRef = reference ?? `credential-${randomUUID()}`;
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(credentialRef)) throw new AgentFault('E_SECRET_INVALID', '凭据引用格式无效');
        const purpose = `agent-api-v1:${profileId}:${credentialRef}:${generation}`;
        if (purpose.length > 512) throw new AgentFault('E_SECRET_INVALID', '凭据保护用途超出上限');
        const secret = Buffer.from(input);
        try {
            const existing = await this.port.get(credentialRef, generation);
            if (existing) {
                if (existing.profileId !== profileId || existing.purpose !== purpose || existing.revoked) throw new AgentFault('E_CREDENTIAL_CONFLICT', '凭据引用已属于其他状态');
                const previous = await this.backend.unprotect(existing.ciphertextBase64, purpose);
                try {
                    if (previous.byteLength !== secret.byteLength || !timingSafeEqual(previous, secret)) throw new AgentFault('E_COMMAND_CONFLICT', '同一凭据命令已经提交不同内容');
                    return { credentialRef, generation, configured: true, revoked: false };
                } finally { previous.fill(0); }
            }
            const ciphertextBase64 = await this.backend.protect(secret, purpose);
            await this.port.put({ credentialRef, generation, profileId, purpose, format: 'dpapi-current-user-v1',
                ciphertextBase64, createdAt: new Date().toISOString(), revoked: false });
            return { credentialRef, generation, configured: true, revoked: false };
        } finally { secret.fill(0); }
    }

    async describe(credentialRef: string, generation: number): Promise<SecretDescriptor> {
        const value = await this.port.get(credentialRef, generation);
        return { credentialRef, generation, configured: value !== null, revoked: value?.revoked ?? false };
    }

    async revoke(credentialRef: string, generation: number): Promise<void> { await this.port.revoke(credentialRef, generation); }

    async withCredential<Value>(credentialRef: string, generation: number, use: (credential: string) => Promise<Value>): Promise<Value> {
        const value = await this.port.get(credentialRef, generation);
        if (!value || value.revoked) throw new AgentFault(value?.revoked ? 'E_CREDENTIAL_REVOKED' : 'E_CREDENTIAL_NOT_FOUND', '冻结请求的凭据引用不可用');
        const decrypted = await this.backend.unprotect(value.ciphertextBase64, value.purpose);
        try {
            if (decrypted.byteLength < 1 || decrypted.byteLength > 65_536) throw new AgentFault('E_SECRET_INVALID', '受保护凭据的解码大小无效');
            const current = await this.port.get(credentialRef, generation);
            if (!current || current.revoked) throw new AgentFault('E_CREDENTIAL_REVOKED', '请求发送前凭据已被撤销');
            let credential: string;
            try { credential = new TextDecoder('utf-8', { fatal: true }).decode(decrypted); }
            catch { throw new AgentFault('E_SECRET_INVALID', 'API凭据不是有效UTF-8文本'); }
            if (!credential || /[\r\n\0]/.test(credential)) throw new AgentFault('E_SECRET_INVALID', 'API凭据包含不适用的字符');
            return await use(credential);
        } finally { decrypted.fill(0); }
    }
}

export interface NativeVaultProgram {
    executablePath: string;
    sha256: string;
    timeoutMs?: number;
}

export function cleanVaultEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const clean: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR']) {
        if (environment[name]) clean[name] = environment[name];
    }
    return clean;
}

export class NativeDpapiBackend implements SecretBackend {
    private readonly timeoutMs: number;
    constructor(private readonly program: NativeVaultProgram) {
        this.timeoutMs = program.timeoutMs ?? 10_000;
        if (!/^[a-f0-9]{64}$/i.test(program.sha256) || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
            throw new AgentFault('E_SECRET_BACKEND', '原生凭据程序缺少有效清单哈希或有界超时');
        }
    }

    private async verifyProgram(): Promise<void> {
        if (process.platform !== 'win32' || process.arch !== 'x64') throw new AgentFault('E_SECRET_BACKEND', '当前平台没有已核实的用户级DPAPI后端');
        let bytes: Buffer;
        try { bytes = await readFile(this.program.executablePath); }
        catch { throw new AgentFault('E_SECRET_BACKEND', '清单指定的原生凭据程序不可读'); }
        if (createHash('sha256').update(bytes).digest('hex').toLowerCase() !== this.program.sha256.toLowerCase()) {
            throw new AgentFault('E_SECRET_BACKEND', '原生凭据程序与清单哈希不同');
        }
    }

    private async invoke(request: JsonObject): Promise<JsonObject> {
        await this.verifyProgram();
        return new Promise((resolve, reject) => {
            const child = spawn(this.program.executablePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
                env: cleanVaultEnvironment(), shell: false });
            const chunks: Buffer[] = [];
            let bytes = 0;
            let failed = false;
            const fail = (): void => { failed = true; child.kill(); };
            const timer = setTimeout(fail, this.timeoutMs);
            child.on('error', () => { clearTimeout(timer); reject(new AgentFault('E_SECRET_BACKEND', '原生凭据程序未能正常启动')); });
            child.stdout.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 196_608) fail();
                else chunks.push(chunk);
            });
            child.stderr.on('data', () => undefined);
            child.stdin.on('error', fail);
            child.on('close', code => {
                clearTimeout(timer);
                try {
                    if (failed || code !== 0) throw new AgentFault('E_SECRET_BACKEND', '原生凭据程序未成功完成，保持受保护状态');
                    const response = objectValue(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    const data = objectValue(response?.data);
                    if (response?.protocolVersion !== 1 || response.ok !== true || !data) throw new AgentFault('E_SECRET_BACKEND', '原生凭据程序回执无效');
                    resolve(data);
                } catch { reject(new AgentFault('E_SECRET_BACKEND', '原生凭据程序未成功完成，保持受保护状态')); }
                finally { for (const chunk of chunks) chunk.fill(0); }
            });
            const input = Buffer.from(canonicalJson(request), 'utf8');
            child.once('close', () => input.fill(0));
            child.stdin.end(input, () => input.fill(0));
        });
    }

    async protect(secret: Uint8Array, purpose: string): Promise<string> {
        const response = await this.invoke({ protocolVersion: 1, operation: 'protect', purpose,
            secretBase64: Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength).toString('base64') });
        if (response.format !== 'dpapi-current-user-v1' || response.scope !== 'CurrentUser' || typeof response.ciphertextBase64 !== 'string') {
            throw new AgentFault('E_SECRET_BACKEND', '原生凭据程序未返回用户级DPAPI密文');
        }
        return response.ciphertextBase64;
    }

    async unprotect(ciphertextBase64: string, purpose: string): Promise<Uint8Array> {
        await this.verifyProgram();
        const pipeName = `sandbox-agent-vault-${randomUUID().replaceAll('-', '')}`;
        const sockets = new Set<Socket>();
        let resolveSecret!: (value: Uint8Array) => void;
        let rejectSecret!: (reason: AgentFault) => void;
        let deliveredSecret: Uint8Array | null = null;
        let completed = false;
        const secretPromise = new Promise<Uint8Array>((resolve, reject) => { resolveSecret = resolve; rejectSecret = reject; });
        void secretPromise.catch(() => undefined);
        const server = createServer(socket => {
            if (sockets.size) { socket.destroy(); return; }
            sockets.add(socket);
            const chunks: Buffer[] = [];
            let length = 0;
            socket.on('data', (chunk: Buffer) => {
                length += chunk.byteLength;
                if (length > 100_000) { socket.destroy(); rejectSecret(new AgentFault('E_SECRET_BACKEND', '受保护凭据回执超过上限')); }
                else chunks.push(chunk);
            });
            socket.on('error', () => rejectSecret(new AgentFault('E_SECRET_BACKEND', '受保护凭据通道未正常完成')));
            socket.on('end', () => {
                try {
                    const response = objectValue(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    const encoded = objectValue(response?.data)?.secretBase64;
                    if (response?.protocolVersion !== 1 || response.ok !== true || typeof encoded !== 'string'
                        || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
                    const bytes = Buffer.from(encoded, 'base64');
                    if (bytes.length < 1 || bytes.length > 65_536) { bytes.fill(0); throw new Error(); }
                    deliveredSecret = bytes;
                    resolveSecret(bytes);
                } catch { rejectSecret(new AgentFault('E_SECRET_BACKEND', '受保护凭据回执无效')); }
                finally { for (const chunk of chunks) chunk.fill(0); }
            });
        });
        const timeout = setTimeout(() => rejectSecret(new AgentFault('E_SECRET_BACKEND', '受保护凭据通道等待超时')), this.timeoutMs);
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', () => reject(new AgentFault('E_SECRET_BACKEND', '无法创建后台专用凭据通道')));
                server.listen(`\\\\.\\pipe\\${pipeName}`, resolve);
            });
            const [response, secret] = await Promise.all([
                this.invoke({ protocolVersion: 1, operation: 'unprotect', purpose, ciphertextBase64, responsePipe: pipeName }), secretPromise,
            ]);
            if (response.delivered !== true || response.channel !== 'parent-owned-named-pipe') { secret.fill(0); throw new AgentFault('E_SECRET_BACKEND', '凭据交付回执未确认'); }
            completed = true;
            return secret;
        } finally {
            if (!completed && deliveredSecret) (deliveredSecret as Uint8Array).fill(0);
            clearTimeout(timeout);
            for (const socket of sockets) socket.destroy();
            await new Promise<void>(resolve => { if (server.listening) server.close(() => resolve()); else resolve(); });
        }
    }
}
