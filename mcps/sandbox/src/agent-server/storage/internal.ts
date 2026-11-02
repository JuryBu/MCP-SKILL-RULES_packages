import type { AgentError, RetainPolicy } from '../protocol.js';
import type { LifecycleCommit, LifecycleFence, LifecycleInventory } from '../conversation-lifecycle/contracts.js';
import type { StoreCommitResult } from './port.js';
export type { LifecycleSnapshotQuery, LifecycleSnapshotResult, LifecycleMigrationCommand, LifecycleMigrationResult } from '../conversation-lifecycle/migration-contracts.js';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, string | number | bigint | null | Uint8Array>;

export interface SqlStatement {
    run(...values: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...values: SqlValue[]): SqlRow | undefined;
    all(...values: SqlValue[]): SqlRow[];
}

export interface SqlDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqlStatement;
    close(): void;
}

export interface StorageOptions {
    dataDir: string;
    maxObjectBytes?: number;
    maxPendingRequests?: number;
}

export interface WorkerRequest {
    id: number;
    method: string;
    params?: unknown;
}

export type LifecycleInspectWorkerParams = { source: LifecycleFence; throughSeq?: number; targetRetention?: RetainPolicy };
export type LifecycleCommitWorkerParams = LifecycleCommit;
export type LifecycleInspectWorkerResult = LifecycleInventory;
export type LifecycleCommitWorkerResult = StoreCommitResult;
export type LifecycleWorkerRequest = { id: number; method: 'lifecycle.inspect'; params: LifecycleInspectWorkerParams }
    | { id: number; method: 'lifecycle.commit'; params: LifecycleCommitWorkerParams };

export type WorkerResponse = { id: number; ok: true; data: unknown }
    | { id: number; ok: false; error: AgentError };

export const MAX_METADATA_BYTES = 64 * 1024;
export const DEFAULT_MAX_OBJECT_BYTES = 32 * 1024 * 1024;
export const MAX_WRITE_BATCH = 100;
export const MAX_PAGE_BYTES = 256 * 1024;
