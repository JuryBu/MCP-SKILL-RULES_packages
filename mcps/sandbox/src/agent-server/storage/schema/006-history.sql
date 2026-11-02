ALTER TABLE items ADD COLUMN content_id TEXT;
ALTER TABLE items ADD COLUMN history_json TEXT;
ALTER TABLE items ADD COLUMN history_view TEXT CHECK (history_view IS NULL OR history_view IN ('raw', 'summary'));
ALTER TABLE items ADD COLUMN history_effective INTEGER NOT NULL DEFAULT 0 CHECK (history_effective IN (0, 1));
ALTER TABLE items ADD COLUMN history_indexed INTEGER NOT NULL DEFAULT 0 CHECK (history_indexed IN (0, 1));
CREATE UNIQUE INDEX items_history_content ON items (cid, content_id) WHERE history_indexed = 1;
CREATE INDEX items_history_page ON items (cid, history_indexed, seq);
CREATE INDEX items_history_view ON items (cid, history_indexed, history_view, history_effective, seq);
CREATE TABLE history_rounds (
    cid TEXT NOT NULL REFERENCES conversations (cid),
    round_id TEXT NOT NULL,
    round_no INTEGER NOT NULL,
    PRIMARY KEY (cid, round_id),
    UNIQUE (cid, round_no)
);
