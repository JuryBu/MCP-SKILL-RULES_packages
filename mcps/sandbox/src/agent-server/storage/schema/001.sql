CREATE TABLE conversations (
    cid TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('ttl', 'archive')),
    ttl_ms INTEGER,
    last_run_end TEXT,
    last_close TEXT,
    expires_at TEXT,
    active_runs INTEGER NOT NULL DEFAULT 0 CHECK (active_runs >= 0),
    policy_rev INTEGER NOT NULL DEFAULT 1,
    history_epoch INTEGER NOT NULL DEFAULT 1,
    append_seq INTEGER NOT NULL DEFAULT 0,
    event_seq INTEGER NOT NULL DEFAULT 0,
    view_revision INTEGER NOT NULL DEFAULT 0,
    run_epoch INTEGER NOT NULL DEFAULT 0,
    compression_generation TEXT,
    history_root TEXT,
    view_root TEXT,
    state TEXT NOT NULL,
    version INTEGER NOT NULL,
    CHECK ((mode = 'ttl' AND ttl_ms BETWEEN 60000 AND 31536000000)
        OR (mode = 'archive' AND ttl_ms IS NULL))
);
CREATE INDEX expiry_due ON conversations (state, expires_at);
CREATE TABLE objects (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    mime TEXT,
    raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 0),
    stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
    codec TEXT NOT NULL,
    stored_hash TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    generation INTEGER NOT NULL
);
CREATE TABLE segments (
    segment_id TEXT PRIMARY KEY,
    cid TEXT NOT NULL REFERENCES conversations (cid),
    first_seq INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    raw_bytes INTEGER NOT NULL,
    stored_bytes INTEGER NOT NULL,
    codec TEXT NOT NULL,
    raw_hash TEXT,
    stored_hash TEXT,
    path TEXT NOT NULL UNIQUE,
    committed_offset INTEGER NOT NULL,
    state TEXT NOT NULL,
    generation INTEGER NOT NULL,
    frame_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX segments_range ON segments (cid, first_seq, last_seq);
CREATE TABLE items (
    cid TEXT NOT NULL REFERENCES conversations (cid),
    seq INTEGER NOT NULL,
    item_id TEXT NOT NULL UNIQUE,
    round_id TEXT,
    step_id TEXT,
    kind TEXT NOT NULL,
    segment_id TEXT NOT NULL REFERENCES segments (segment_id),
    frame_no INTEGER NOT NULL,
    frame_offset INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    object_hash TEXT NOT NULL REFERENCES objects (hash),
    PRIMARY KEY (cid, seq)
);
CREATE INDEX items_round ON items (cid, round_id, seq);
CREATE TABLE manifests (
    manifest_id TEXT PRIMARY KEY,
    cid TEXT NOT NULL REFERENCES conversations (cid),
    kind TEXT NOT NULL,
    revision INTEGER NOT NULL,
    parent_id TEXT,
    object_hash TEXT NOT NULL REFERENCES objects (hash),
    source_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    UNIQUE (cid, kind, revision)
);
CREATE TABLE refs (
    cid TEXT NOT NULL REFERENCES conversations (cid),
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('object', 'segment', 'manifest')),
    target_id TEXT NOT NULL,
    PRIMARY KEY (cid, owner_kind, owner_id, slot, target_kind, target_id)
);
CREATE INDEX refs_target ON refs (target_kind, target_id);
CREATE TABLE candidates (
    candidate_id TEXT PRIMARY KEY,
    cid TEXT NOT NULL REFERENCES conversations (cid),
    state TEXT NOT NULL,
    history_epoch INTEGER NOT NULL,
    snapshot_seq INTEGER NOT NULL,
    parent_view INTEGER NOT NULL,
    compression_generation TEXT NOT NULL,
    model_fingerprint TEXT NOT NULL,
    manifest_id TEXT NOT NULL REFERENCES manifests (manifest_id),
    run_id TEXT NOT NULL,
    run_epoch INTEGER NOT NULL,
    error_code TEXT
);
CREATE TABLE attempts (
    attempt_id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL,
    cid TEXT NOT NULL REFERENCES conversations (cid),
    run_id TEXT NOT NULL,
    run_epoch INTEGER NOT NULL,
    state TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    provider_request_id TEXT,
    response_id TEXT,
    snapshot_hash TEXT NOT NULL,
    usage_hash TEXT,
    reservation_id TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX attempts_action ON attempts (action_id, updated_at);
CREATE TABLE state_items (
    cid TEXT NOT NULL REFERENCES conversations (cid),
    kind TEXT NOT NULL,
    state_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    state TEXT NOT NULL,
    content_hash TEXT,
    anchor_id TEXT,
    order_key INTEGER,
    PRIMARY KEY (cid, kind, state_id)
);
CREATE INDEX state_queue ON state_items (cid, kind, state, order_key);
CREATE TABLE receipts (
    cid TEXT NOT NULL REFERENCES conversations (cid),
    principal_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    operation_hash TEXT NOT NULL,
    result_hash TEXT NOT NULL REFERENCES objects (hash),
    state TEXT NOT NULL,
    PRIMARY KEY (principal_id, client_id, cid, command_id)
);
CREATE TABLE events (
    cid TEXT NOT NULL REFERENCES conversations (cid),
    event_seq INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    payload_hash TEXT NOT NULL REFERENCES objects (hash),
    PRIMARY KEY (cid, event_seq)
);
CREATE TABLE leases (
    lease_id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    owner_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX leases_target ON leases (target_kind, target_id, expires_at);
CREATE TABLE store_records (
    record_key TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    cid TEXT REFERENCES conversations (cid),
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    value_json TEXT NOT NULL CHECK (length(CAST(value_json AS BLOB)) <= 65536),
    UNIQUE (scope_id, kind, record_id)
);
CREATE INDEX store_records_page ON store_records (kind, record_key);
CREATE INDEX store_records_conversation ON store_records (cid, kind, record_key);
CREATE TABLE content_items (
    cid TEXT NOT NULL REFERENCES conversations (cid),
    content_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    object_hash TEXT NOT NULL REFERENCES objects (hash),
    PRIMARY KEY (cid, content_id)
);
CREATE TABLE search_chunks (
    cid TEXT NOT NULL REFERENCES conversations (cid),
    item_id TEXT NOT NULL,
    chunk_no INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_byte INTEGER NOT NULL,
    end_byte INTEGER NOT NULL,
    PRIMARY KEY (cid, item_id, chunk_no)
);
