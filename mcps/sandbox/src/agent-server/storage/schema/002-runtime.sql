CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    cid TEXT NOT NULL REFERENCES conversations (cid),
    root_run_id TEXT NOT NULL,
    parent_run_id TEXT,
    run_epoch INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'maintenance')),
    state TEXT NOT NULL CHECK (state IN ('accepted', 'queued', 'running', 'waiting', 'stopping',
        'paused', 'recovering', 'outcome_unknown', 'succeeded', 'failed', 'cancelled')),
    phase TEXT CHECK (phase IS NULL OR phase IN ('admitting', 'preparing', 'uploading',
        'awaiting_response', 'streaming', 'executing_tools', 'retry_backoff')),
    active_round_id TEXT,
    active_step_id TEXT,
    deadline_at TEXT,
    effect_state TEXT NOT NULL CHECK (effect_state IN ('none', 'confirmed', 'unknown')),
    cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('not_needed', 'pending', 'running', 'released', 'unconfirmed')),
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK (length(CAST(snapshot_json AS BLOB)) <= 65536)
);
CREATE INDEX runs_conversation_state ON runs (cid, state);
CREATE INDEX runs_root_state ON runs (root_run_id, state);
