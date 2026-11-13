import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { ProviderProfile } from './types.js';

const packageVersion: unknown = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version;
if (typeof packageVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(packageVersion)) {
    throw new AgentFault('E_CLIENT_IDENTITY', 'Sandbox Agent发布版本缺失或无效');
}
export const SANDBOX_AGENT_USER_AGENT = `Sandbox-Agent/${packageVersion}`;

export interface ProviderRequestIdentity {
    purpose: 'generation' | 'lookup' | 'catalog' | 'count' | 'balance';
    conversationId?: string;
}

export function isOpenCodeGo(baseUrl: string): boolean {
    try {
        const endpoint = new URL(baseUrl);
        return endpoint.protocol === 'https:' && endpoint.hostname === 'opencode.ai' && !endpoint.port
            && !endpoint.username && !endpoint.password && /^\/(?:inference|zen)\/go(?:\/|$)/.test(endpoint.pathname);
    } catch { return false; }
}

export function providerConversationSession(profile: ProviderProfile, conversationId: string): string {
    if (!conversationId || conversationId.length > 512) throw new AgentFault('E_CLIENT_IDENTITY', '供应商会话需要有效的本地对话引用');
    const endpoint = new URL(profile.baseUrl);
    const account = profile.quotaScopeId.startsWith('unverified-provider:') ? profile.profileId : profile.quotaScopeId;
    const digest = createHash('sha256').update(canonicalJson(['sandbox-agent-session-v1', endpoint.origin,
        isOpenCodeGo(profile.baseUrl) ? 'opencode-go' : endpoint.pathname.replace(/\/+$/, ''), account, conversationId])).digest('hex');
    return `ses_${digest}`;
}

export function providerRequestHeaders(profile: ProviderProfile, headers: Record<string, string>, identity: ProviderRequestIdentity): Record<string, string> {
    const result = Object.fromEntries(Object.entries(headers).filter(([name]) => !['user-agent', 'x-opencode-session'].includes(name.toLowerCase())));
    result['User-Agent'] = SANDBOX_AGENT_USER_AGENT;
    if (isOpenCodeGo(profile.baseUrl) && identity.conversationId) {
        result['x-opencode-session'] = providerConversationSession(profile, identity.conversationId);
    }
    return result;
}

export function geminiCredentialHeaders(profile: ProviderProfile, credential?: string): Record<string, string> {
    if (credential === undefined) return {};
    if (!credential || /[\r\n\0]/.test(credential)) throw new AgentFault('E_AUTH', '凭据内容无效');
    return isOpenCodeGo(profile.baseUrl) ? { Authorization: `Bearer ${credential}` } : { 'x-goog-api-key': credential };
}
