import type { ClientIdentity, JsonValue, RpcResult } from '../protocol.js';
import type { StorePort } from '../storage/port.js';

export interface InstructionSource {
    sourceId: string;
    name: string;
    description: string;
    path: string;
    priority: number;
    enabled: boolean;
}

export interface InstructionPin {
    kind: 'skill' | 'rule';
    sourceId: string;
    qualifiedName: string;
    name: string;
    ownerId: string;
    sourcePath: string;
    priority: number;
    version: string;
    sha256: string;
    bytes: number;
    contentId: string;
}

export interface InstructionSelection {
    ownerId: string;
    skills: InstructionPin[];
    rules: InstructionPin[];
}

export interface ConfigurationSettings {
    ownerId: string;
    values: Record<string, JsonValue>;
}

export interface ResolvedInstructions {
    schemaVersion: 1;
    conversationId: string;
    revision: number;
    text: string;
    prefixHash: string;
    skillVersions: Record<string, string>;
    ruleVersions: Record<string, string>;
    sources: InstructionPin[];
}

export interface ConfigurationAuthorization {
    authorizeGlobalWrite(client: ClientIdentity, params: Record<string, unknown>): Promise<unknown>;
    authorizeConversationWrite(client: ClientIdentity, params: Record<string, unknown>): Promise<unknown>;
    authorizeConversationRead(client: ClientIdentity, conversationId: string): Promise<unknown>;
}

export interface ConfigurationServiceOptions extends ConfigurationAuthorization {
    store: StorePort;
    sourceRoots: readonly string[];
}

export type ConfigurationDispatch = (method: string, params: Record<string, unknown>, client: ClientIdentity) => Promise<RpcResult | undefined>;
