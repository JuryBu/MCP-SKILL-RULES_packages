CREATE TABLE temporary_provider_fences (
    owner_instance_id TEXT NOT NULL,
    cid TEXT NOT NULL,
    run_id TEXT NOT NULL,
    run_epoch INTEGER NOT NULL CHECK (run_epoch >= 1),
    history_epoch INTEGER NOT NULL CHECK (history_epoch >= 1),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    version INTEGER NOT NULL CHECK (version >= 1),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_instance_id, cid, run_id)
);
CREATE TABLE temporary_provider_attempts (
    attempt_id TEXT PRIMARY KEY,
    root_budget_id TEXT NOT NULL REFERENCES budgets (root_budget_id),
    owner_instance_id TEXT NOT NULL,
    cid TEXT NOT NULL,
    run_id TEXT NOT NULL,
    run_epoch INTEGER NOT NULL CHECK (run_epoch >= 1),
    history_epoch INTEGER NOT NULL CHECK (history_epoch >= 1),
    financial_intent_id TEXT NOT NULL UNIQUE,
    dispatch_nonce TEXT NOT NULL UNIQUE,
    intent_json TEXT NOT NULL CHECK (length(CAST(intent_json AS BLOB)) <= 4096),
    upper_bound_json TEXT NOT NULL CHECK (length(CAST(upper_bound_json AS BLOB)) <= 2048),
    state TEXT NOT NULL CHECK (state IN ('dispatching', 'committed', 'unknown', 'rejected')),
    settlement_hash TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX temporary_provider_owner ON temporary_provider_attempts (owner_instance_id, cid, run_id);
