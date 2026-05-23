import { randomUUID } from "crypto";

export const GLOBAL_OWNER_ID = "global";

export function newUuid(): string {
    return randomUUID();
}

export function normalizeOwnerId(ownerId: unknown): string {
    if (typeof ownerId !== "string") return GLOBAL_OWNER_ID;
    const trimmed = ownerId.trim();
    return trimmed.length > 0 ? trimmed : GLOBAL_OWNER_ID;
}

export function resourceOwnerId(ownerId: string | undefined): string {
    return ownerId && ownerId.trim() ? ownerId : GLOBAL_OWNER_ID;
}

export function hasOwnerAccess(resourceOwner: string | undefined, requestOwner: string): boolean {
    return resourceOwnerId(resourceOwner) === requestOwner;
}

export function ownerMismatchText(kind: string, id: string): string {
    return `❌ ${kind} ${id} 不属于当前 owner，拒绝访问`;
}
