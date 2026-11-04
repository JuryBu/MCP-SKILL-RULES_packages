PRAGMA defer_foreign_keys = ON;
CREATE TABLE budgets_before_metered AS SELECT * FROM budgets;
DROP TABLE budgets;
CREATE TABLE budgets (
    root_budget_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('hard', 'estimated', 'metered')),
    currency TEXT,
    limit_micros INTEGER CHECK (limit_micros IS NULL OR limit_micros >= 0),
    max_model_calls INTEGER NOT NULL CHECK (max_model_calls > 0),
    spent_calls INTEGER NOT NULL DEFAULT 0 CHECK (spent_calls >= 0),
    held_calls INTEGER NOT NULL DEFAULT 0 CHECK (held_calls >= 0),
    spent_micros INTEGER NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
    held_micros INTEGER NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
    deadline_at TEXT NOT NULL,
    version INTEGER NOT NULL,
    record_json TEXT,
    quota_limit_id TEXT
);
INSERT INTO budgets SELECT * FROM budgets_before_metered;
DROP TABLE budgets_before_metered;
CREATE INDEX budgets_quota_limit ON budgets (quota_limit_id);
