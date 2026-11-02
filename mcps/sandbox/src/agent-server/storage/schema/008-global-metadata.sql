CREATE TABLE server_refs (
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind = 'object'),
    target_id TEXT NOT NULL REFERENCES objects (hash),
    PRIMARY KEY (owner_kind, owner_id, slot, target_kind, target_id)
);
CREATE INDEX server_refs_target ON server_refs (target_kind, target_id);
