CREATE TABLE resources (
    resource_id TEXT PRIMARY KEY,
    cid TEXT NOT NULL REFERENCES conversations (cid),
    run_id TEXT NOT NULL,
    run_epoch INTEGER NOT NULL,
    action_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    external_id TEXT,
    state TEXT NOT NULL,
    generation INTEGER NOT NULL,
    expires_at TEXT,
    version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL CHECK (length(CAST(snapshot_json AS BLOB)) <= 65536)
);
CREATE INDEX resources_run_state ON resources (run_id, state);
CREATE TABLE workspace_changes (
    action_id TEXT PRIMARY KEY,
    cid TEXT NOT NULL REFERENCES conversations (cid),
    run_id TEXT NOT NULL,
    round_id TEXT,
    attempt_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    workspace_revision_before INTEGER NOT NULL,
    workspace_revision_after INTEGER,
    state TEXT NOT NULL,
    content_hash TEXT NOT NULL REFERENCES objects (hash),
    version INTEGER NOT NULL
);
CREATE INDEX workspace_changes_round ON workspace_changes (cid, round_id);
CREATE TABLE restore_plans (
    restore_plan_id TEXT PRIMARY KEY,
    cid TEXT NOT NULL REFERENCES conversations (cid),
    mode TEXT NOT NULL CHECK (mode IN ('files_only', 'round_restart')),
    history_epoch INTEGER NOT NULL,
    workspace_revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    content_hash TEXT NOT NULL REFERENCES objects (hash),
    version INTEGER NOT NULL
);
