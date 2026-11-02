import { z } from 'zod';

const command = z.string().min(1).max(512);
const profileId = z.string().min(1).max(512);
const revision = z.number().int().nonnegative();

export const PROVIDER_RPC_SIGNATURES = {
    'profiles.list': z.object({ cursor: z.string().nullable().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
    'profiles.get': z.object({ profileId, revision: revision.optional() }).strict(),
    'profiles.validate': z.object({ profile: z.unknown() }).strict(),
    'profiles.put': z.object({ profile: z.unknown(), expectedRevision: revision, clientCommandId: command }).strict(),
    'profiles.remove': z.object({ profileId, expectedRevision: revision, clientCommandId: command }).strict(),
    'profiles.setSecret': z.object({ profileId, expectedRevision: revision, secret: z.string().min(1).max(65_536), clientCommandId: command }).strict(),
    'profiles.rotateSecret': z.object({ profileId, expectedRevision: revision, secret: z.string().min(1).max(65_536), clientCommandId: command }).strict(),
    'profiles.importSecret': z.object({ profileId, expectedRevision: revision, sourcePath: z.string().min(1).max(32_768),
        format: z.enum(['plain', 'env', 'json']), field: z.string().min(1).max(256).optional(), clientCommandId: command }).strict(),
    'models.list': z.object({ profileId, cursor: z.string().nullable().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
    'models.get': z.object({ profileId, modelId: z.string().min(1), routeId: z.string().nullable().optional() }).strict(),
    'models.refresh': z.object({ profileId, clientCommandId: command }).strict(),
    'models.declare': z.object({ profileId, expectedCatalogVersion: z.string().min(1).nullable(), entry: z.unknown(), clientCommandId: command }).strict(),
} as const;
