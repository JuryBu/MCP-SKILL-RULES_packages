CREATE TABLE server_state (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    value_json TEXT NOT NULL CHECK (length(CAST(value_json AS BLOB)) <= 65536),
    PRIMARY KEY (kind, id)
);
CREATE TABLE server_receipts (
    principal_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    operation_hash TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (length(CAST(result_json AS BLOB)) <= 65536),
    PRIMARY KEY (principal_id, client_id, command_id)
);
