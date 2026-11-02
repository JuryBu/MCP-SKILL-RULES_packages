ALTER TABLE budgets ADD COLUMN record_json TEXT;
ALTER TABLE budgets ADD COLUMN quota_limit_id TEXT;
CREATE INDEX budgets_quota_limit ON budgets (quota_limit_id);
ALTER TABLE reservations ADD COLUMN action_id TEXT;
ALTER TABLE reservations ADD COLUMN quota_scope_id TEXT;
ALTER TABLE reservations ADD COLUMN execution_key TEXT;
ALTER TABLE reservations ADD COLUMN record_json TEXT;
CREATE INDEX reservations_quota_execution ON reservations (quota_scope_id, execution_key);
ALTER TABLE charges ADD COLUMN root_budget_id TEXT REFERENCES budgets (root_budget_id);
ALTER TABLE charges ADD COLUMN record_json TEXT;
CREATE INDEX charges_root_budget ON charges (root_budget_id);
CREATE TABLE provider_budget_bindings (
    root_budget_id TEXT NOT NULL REFERENCES budgets (root_budget_id),
    cid TEXT NOT NULL REFERENCES conversations (cid),
    root_run_id TEXT NOT NULL,
    PRIMARY KEY (root_budget_id, cid, root_run_id)
);
CREATE TABLE provider_attempt_journal (
    attempt_id TEXT PRIMARY KEY REFERENCES attempts (attempt_id),
    root_budget_id TEXT NOT NULL REFERENCES budgets (root_budget_id),
    intent_hash TEXT NOT NULL,
    attempt_object_hash TEXT NOT NULL REFERENCES objects (hash),
    snapshot_object_hash TEXT NOT NULL REFERENCES objects (hash),
    upper_bound_json TEXT NOT NULL CHECK (length(CAST(upper_bound_json AS BLOB)) <= 65536),
    state TEXT NOT NULL CHECK (state IN ('dispatching', 'unknown', 'committed', 'rejected')),
    dispatch_granted INTEGER NOT NULL CHECK (dispatch_granted IN (0, 1)),
    response_object_hash TEXT REFERENCES objects (hash),
    raw_object_hash TEXT REFERENCES objects (hash),
    failure_object_hash TEXT REFERENCES objects (hash),
    tools_authorized INTEGER NOT NULL DEFAULT 0 CHECK (tools_authorized IN (0, 1)),
    late_response INTEGER NOT NULL DEFAULT 0 CHECK (late_response IN (0, 1)),
    updated_at TEXT NOT NULL
);
CREATE INDEX provider_attempt_budget ON provider_attempt_journal (root_budget_id, state);
CREATE TABLE provider_tool_intents (
    attempt_id TEXT NOT NULL REFERENCES provider_attempt_journal (attempt_id),
    tool_index INTEGER NOT NULL,
    call_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs (run_id),
    run_epoch INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('authorized', 'blocked')),
    object_hash TEXT NOT NULL REFERENCES objects (hash),
    PRIMARY KEY (attempt_id, tool_index)
);
CREATE INDEX provider_tool_intents_run ON provider_tool_intents (run_id, run_epoch, state);
CREATE TABLE provider_tool_batches (
    attempt_id TEXT PRIMARY KEY REFERENCES provider_attempt_journal (attempt_id),
    object_hash TEXT NOT NULL REFERENCES objects (hash),
    call_count INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('authorized', 'blocked'))
);
