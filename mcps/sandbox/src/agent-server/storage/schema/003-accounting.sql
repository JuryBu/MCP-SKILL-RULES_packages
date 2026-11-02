CREATE TABLE budgets (
    root_budget_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('hard', 'estimated')),
    currency TEXT,
    limit_micros INTEGER CHECK (limit_micros IS NULL OR limit_micros >= 0),
    max_model_calls INTEGER NOT NULL CHECK (max_model_calls > 0),
    spent_calls INTEGER NOT NULL DEFAULT 0 CHECK (spent_calls >= 0),
    held_calls INTEGER NOT NULL DEFAULT 0 CHECK (held_calls >= 0),
    spent_micros INTEGER NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
    held_micros INTEGER NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
    deadline_at TEXT NOT NULL,
    version INTEGER NOT NULL
);
CREATE TABLE reservations (
    attempt_id TEXT PRIMARY KEY,
    root_budget_id TEXT NOT NULL REFERENCES budgets (root_budget_id),
    upper_micros INTEGER CHECK (upper_micros IS NULL OR upper_micros >= 0),
    amount_unknown INTEGER NOT NULL CHECK (amount_unknown IN (0, 1)),
    state TEXT NOT NULL,
    version INTEGER NOT NULL
);
CREATE INDEX reservations_budget_state ON reservations (root_budget_id, state);
CREATE TABLE charges (
    quota_scope_id TEXT NOT NULL,
    execution_key TEXT NOT NULL,
    component TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    usage_revision INTEGER NOT NULL,
    amount_micros INTEGER CHECK (amount_micros IS NULL OR amount_micros >= 0),
    usage_json TEXT NOT NULL CHECK (length(CAST(usage_json AS BLOB)) <= 65536),
    PRIMARY KEY (quota_scope_id, execution_key, component)
);
CREATE INDEX charges_attempt ON charges (attempt_id);
