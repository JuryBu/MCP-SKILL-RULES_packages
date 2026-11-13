import { AgentFault, canonicalJson } from '../protocol.js';
import type { ProfileSpend } from '../profiles/dispatch-policy.js';
import type { ProviderAttempt } from '../providers/types.js';
import type { SqlDatabase } from './internal.js';
import type { ObjectFiles } from './objects.js';
import type { TemporaryFinancialIntent } from './temporary-finance.js';

const OWNER_KIND = 'providerAttemptProfile';
const LEGACY_ATTEMPTS = 64;
const LEGACY_OBJECT_BYTES = 64 * 1024;
const LEGACY_TOTAL_BYTES = 1024 * 1024;

export interface ProfileSpendSummary extends ProfileSpend {
    costs: { currency: string; amountMicros: number }[];
    heldCosts: { currency: string; amountMicros: number }[];
    pendingAttempts: number;
    unknownCharges: number;
    unattributedAttempts: number;
    legacyObjectsRead: number;
    legacyBytesRead: number;
}

export function indexProfileAttempt(database: SqlDatabase, attempt: ProviderAttempt, currency: string | null): void {
    database.prepare('INSERT INTO server_state (kind,id,revision,value_json) VALUES (?,?,1,?)').run(OWNER_KIND,
        attempt.attemptId, canonicalJson({ profileId: attempt.snapshot.profile.profileId,
            snapshotHash: attempt.snapshot.snapshotHash, quotaScopeId: attempt.snapshot.profile.quotaScopeId,
            currency, observedAt: attempt.createdAt }));
}

export function indexTemporaryProfileAttempt(database: SqlDatabase, intent: TemporaryFinancialIntent, currency: string | null): void {
    if (!intent.profileId) return;
    database.prepare('INSERT INTO server_state (kind,id,revision,value_json) VALUES (?,?,1,?)').run(OWNER_KIND,
        intent.attemptId, canonicalJson({ profileId: intent.profileId, financialIntentId: intent.financialIntentId,
            quotaScopeId: intent.quotaScopeId, currency, observedAt: new Date().toISOString() }));
}

export function readProfileSpend(database: SqlDatabase, files: ObjectFiles, profileId: string, requestedCurrency?: string): ProfileSpendSummary {
    if (typeof profileId !== 'string' || !profileId || profileId.length > 512
        || requestedCurrency !== undefined && !/^[A-Z]{3}$/.test(requestedCurrency)) {
        throw new AgentFault('INVALID_PARAMS', 'Profile费用读取参数无效');
    }
    const legacy = database.prepare(`WITH financial AS (
        SELECT attempt_id FROM charges UNION SELECT attempt_id FROM reservations WHERE state <> 'rejected'
    ) SELECT financial.attempt_id,journal.snapshot_object_hash,objects.raw_bytes,objects.codec,
        json_extract(reservations.record_json,'$.snapshotHash') AS snapshot_hash,budgets.currency
        FROM financial LEFT JOIN server_state owner ON owner.kind = ? AND owner.id = financial.attempt_id
        LEFT JOIN provider_attempt_journal journal ON journal.attempt_id = financial.attempt_id
        LEFT JOIN objects ON objects.hash = journal.snapshot_object_hash
        LEFT JOIN reservations ON reservations.attempt_id = financial.attempt_id
        LEFT JOIN budgets ON budgets.root_budget_id = reservations.root_budget_id
        WHERE owner.id IS NULL ORDER BY financial.attempt_id LIMIT ?`).all(OWNER_KIND, LEGACY_ATTEMPTS);
    const legacyOwners: { attemptId: string; profileId: string; currency: string | null }[] = [];
    let legacyBytesRead = 0;
    let legacyObjectsRead = 0;
    for (const row of legacy) {
        const bytes = Number(row.raw_bytes);
        if (!row.snapshot_object_hash || row.codec !== 'identity' || !Number.isSafeInteger(bytes) || bytes < 1
            || bytes > LEGACY_OBJECT_BYTES || legacyBytesRead + bytes > LEGACY_TOTAL_BYTES) continue;
        legacyBytesRead += bytes;
        legacyObjectsRead++;
        try {
            const snapshot = files.read(database, String(row.snapshot_object_hash)) as ProviderAttempt['snapshot'];
            if (typeof snapshot?.profile?.profileId !== 'string' || !snapshot.profile.profileId
                || !row.snapshot_hash || snapshot.snapshotHash !== row.snapshot_hash) continue;
            legacyOwners.push({ attemptId: String(row.attempt_id), profileId: snapshot.profile.profileId,
                currency: row.currency === null ? null : String(row.currency) });
        } catch (error) {
            if (!(error instanceof AgentFault)) throw error;
        }
    }
    const ownership = `WITH ownership AS (
        SELECT id AS attempt_id,json_extract(value_json,'$.profileId') AS profile_id,
            json_extract(value_json,'$.currency') AS currency FROM server_state WHERE kind = ?
        UNION ALL SELECT json_extract(value,'$.attemptId'),json_extract(value,'$.profileId'),
            json_extract(value,'$.currency') FROM json_each(?)
    )`;
    const ownershipParams = [OWNER_KIND, JSON.stringify(legacyOwners)];
    const amounts = database.prepare(`${ownership} SELECT json_extract(charges.record_json,'$.currency') AS currency,
        TOTAL(charges.amount_micros) AS amount,COUNT(*) AS count FROM charges JOIN ownership USING(attempt_id)
        WHERE ownership.profile_id = ? AND charges.amount_micros IS NOT NULL
        GROUP BY json_extract(charges.record_json,'$.currency') LIMIT 513`).all(...ownershipParams, profileId);
    const unknown = database.prepare(`${ownership} SELECT COUNT(*) AS count FROM charges JOIN ownership USING(attempt_id)
        WHERE ownership.profile_id = ? AND charges.amount_micros IS NULL`).get(...ownershipParams, profileId);
    const pending = database.prepare(`${ownership} SELECT COUNT(*) AS count FROM reservations JOIN ownership USING(attempt_id)
        WHERE ownership.profile_id = ? AND reservations.state IN ('reserved','dispatched','unknown','unsettled')`)
        .get(...ownershipParams, profileId);
    const held = database.prepare(`${ownership} SELECT budgets.currency,TOTAL(json_extract(reservations.record_json,'$.heldMicros')) AS amount
        FROM reservations JOIN ownership USING(attempt_id) JOIN budgets USING(root_budget_id)
        WHERE ownership.profile_id = ? AND reservations.state IN ('reserved','dispatched','unknown','unsettled')
        GROUP BY budgets.currency LIMIT 513`).all(...ownershipParams, profileId);
    const unattributed = database.prepare(`${ownership}, financial AS (
        SELECT attempt_id FROM charges UNION SELECT attempt_id FROM reservations WHERE state <> 'rejected'
    ) SELECT COUNT(*) AS count FROM financial LEFT JOIN ownership USING(attempt_id) WHERE ownership.profile_id IS NULL`)
        .get(...ownershipParams);
    const configured = database.prepare(`SELECT json_extract(value_json,'$.dispatchPolicy.maxCumulativeCost.currency') AS currency
        FROM server_state WHERE kind = 'profileVersion' AND json_extract(value_json,'$.profileId') = ?
        ORDER BY revision DESC LIMIT 1`).get(profileId);
    const observedCurrencies = database.prepare(`${ownership} SELECT DISTINCT currency FROM ownership
        WHERE profile_id = ? AND currency IS NOT NULL LIMIT 2`).all(...ownershipParams, profileId);
    const costs = amounts.map(row => ({ currency: String(row.currency ?? 'XXX'), amountMicros: Number(row.amount) }));
    const heldCosts = held.map(row => ({ currency: String(row.currency ?? 'XXX'), amountMicros: Number(row.amount) }));
    const expectedCurrency = requestedCurrency ?? (configured?.currency ? String(configured.currency) : undefined);
    const currency = expectedCurrency ?? (costs.length === 1 ? costs[0].currency
        : observedCurrencies.length === 1 ? String(observedCurrencies[0].currency) : 'XXX');
    const invalidAmounts = amounts.length > 512 || held.length > 512 || [...costs, ...heldCosts].some(cost =>
        !Number.isSafeInteger(cost.amountMicros) || cost.amountMicros < 0 || !/^[A-Z]{3}$/.test(cost.currency));
    const mixedCurrency = costs.some(cost => cost.currency !== currency) || heldCosts.some(cost => cost.currency !== currency)
        || observedCurrencies.some(row => row.currency !== currency);
    const pendingAttempts = Number(pending?.count ?? 0);
    const unknownCharges = Number(unknown?.count ?? 0);
    const unattributedAttempts = Number(unattributed?.count ?? 0);
    const unresolved = pendingAttempts + unknownCharges + unattributedAttempts > 0;
    return { amountMicros: invalidAmounts || mixedCurrency ? null : costs[0]?.amountMicros ?? (unresolved ? null : 0),
        currency, status: invalidAmounts || mixedCurrency ? 'unknown' : unresolved ? costs.length ? 'partial' : 'unknown' : 'known',
        sourceRef: `sqlite:profile-spend:v1:${encodeURIComponent(profileId)}`, observedAt: new Date().toISOString(),
        costs, heldCosts, pendingAttempts, unknownCharges, unattributedAttempts, legacyObjectsRead, legacyBytesRead };
}
