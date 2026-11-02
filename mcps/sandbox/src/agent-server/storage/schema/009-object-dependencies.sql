CREATE TABLE object_dependencies (
    source_hash TEXT NOT NULL REFERENCES objects (hash) ON DELETE CASCADE,
    payload_hash TEXT NOT NULL REFERENCES objects (hash),
    PRIMARY KEY (source_hash, payload_hash),
    CHECK (source_hash <> payload_hash)
);
CREATE INDEX object_dependencies_payload ON object_dependencies (payload_hash, source_hash);

CREATE TRIGGER refs_attach_object_dependencies AFTER INSERT ON refs
WHEN NEW.target_kind = 'object'
BEGIN
    INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id)
    SELECT NEW.cid,NEW.owner_kind,NEW.owner_id,NEW.slot || ':media:' || payload_hash,'object',payload_hash
    FROM object_dependencies WHERE source_hash = NEW.target_id;
END;

CREATE TRIGGER refs_release_object_dependencies AFTER DELETE ON refs
WHEN OLD.target_kind = 'object'
BEGIN
    DELETE FROM refs
    WHERE cid = OLD.cid AND owner_kind = OLD.owner_kind AND owner_id = OLD.owner_id
        AND target_kind = 'object' AND slot = OLD.slot || ':media:' || target_id
        AND target_id IN (SELECT payload_hash FROM object_dependencies WHERE source_hash = OLD.target_id)
        AND NOT EXISTS (
            SELECT 1 FROM refs AS root JOIN object_dependencies ON source_hash = root.target_id
            WHERE root.cid = OLD.cid AND root.owner_kind = OLD.owner_kind AND root.owner_id = OLD.owner_id
                AND root.slot = OLD.slot AND root.target_kind = 'object' AND payload_hash = refs.target_id
        );
END;

CREATE TRIGGER server_refs_attach_object_dependencies AFTER INSERT ON server_refs
BEGIN
    INSERT OR IGNORE INTO server_refs (owner_kind,owner_id,slot,target_kind,target_id)
    SELECT NEW.owner_kind,NEW.owner_id,NEW.slot || ':media:' || payload_hash,'object',payload_hash
    FROM object_dependencies WHERE source_hash = NEW.target_id;
END;

CREATE TRIGGER server_refs_release_object_dependencies AFTER DELETE ON server_refs
BEGIN
    DELETE FROM server_refs
    WHERE owner_kind = OLD.owner_kind AND owner_id = OLD.owner_id AND target_kind = 'object'
        AND slot = OLD.slot || ':media:' || target_id
        AND target_id IN (SELECT payload_hash FROM object_dependencies WHERE source_hash = OLD.target_id)
        AND NOT EXISTS (
            SELECT 1 FROM server_refs AS root JOIN object_dependencies ON source_hash = root.target_id
            WHERE root.owner_kind = OLD.owner_kind AND root.owner_id = OLD.owner_id AND root.slot = OLD.slot
                AND root.target_kind = 'object' AND payload_hash = server_refs.target_id
        );
END;

CREATE TRIGGER object_dependencies_attach_existing_roots AFTER INSERT ON object_dependencies
BEGIN
    INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id)
    SELECT cid,owner_kind,owner_id,slot || ':media:' || NEW.payload_hash,'object',NEW.payload_hash
    FROM refs WHERE target_kind = 'object' AND target_id = NEW.source_hash;
    INSERT OR IGNORE INTO server_refs (owner_kind,owner_id,slot,target_kind,target_id)
    SELECT owner_kind,owner_id,slot || ':media:' || NEW.payload_hash,'object',NEW.payload_hash
    FROM server_refs WHERE target_kind = 'object' AND target_id = NEW.source_hash;
END;
