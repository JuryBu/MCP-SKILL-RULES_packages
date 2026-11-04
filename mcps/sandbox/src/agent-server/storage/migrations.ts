import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AgentFault } from '../protocol.js';
import type { SqlDatabase } from './internal.js';

const migrationNames = ['001.sql', '002-runtime.sql', '003-accounting.sql', '004-config.sql', '005-tools-workspace.sql', '006-history.sql', '007-provider-journal.sql', '008-global-metadata.sql', '009-object-dependencies.sql', '010-temporary-finance.sql', '011-metered-budget.sql'];
export const STORAGE_SCHEMA_VERSION = migrationNames.length;

export interface StorageMigration {
    version: number;
    name: string;
    sql: string;
    hash: string;
}

export function loadMigrations(): StorageMigration[] {
    return migrationNames.map((name, index) => {
        let sql: string;
        try {
            sql = readFileSync(new URL(`./schema/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
        } catch {
            throw new AgentFault('STORAGE_SCHEMA_UNSUPPORTED', '存储迁移文件缺失，持久存储未启动', { migration: name });
        }
        return { version: index + 1, name, sql, hash: createHash('sha256').update(sql).digest('hex') };
    });
}

export function validateDatabaseVersion(database: SqlDatabase, migrations: StorageMigration[], newDatabase: boolean): number {
    const historyExists = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    const version = database.prepare('PRAGMA user_version').get();
    if (!historyExists) {
        if (!newDatabase || Number(version?.user_version) !== 0) {
            throw new AgentFault('STORAGE_SCHEMA_UNSUPPORTED', '现有数据库没有可核验的迁移来源，未修改原库');
        }
        return 0;
    }
    const applied = database.prepare('SELECT version, name, sha256 FROM schema_migrations ORDER BY version LIMIT ?').all(migrations.length + 1);
    if (applied.length > migrations.length || applied.some((row, index) => Number(row.version) !== index + 1
        || row.name !== migrations[index]?.name || row.sha256 !== migrations[index]?.hash)
        || Number(version?.user_version) !== applied.length) {
        throw new AgentFault('STORAGE_SCHEMA_UNSUPPORTED', '存储版本或迁移校验与当前程序不符，持久写入已停止');
    }
    return applied.length;
}

export function migrateDatabase(database: SqlDatabase, migrations: StorageMigration[], newDatabase = false): void {
    const applied = validateDatabaseVersion(database, migrations, newDatabase);
    for (const migration of migrations.slice(applied)) {
        database.exec('BEGIN IMMEDIATE');
        try {
            if (migration.version === 1) database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)');
            database.exec(migration.sql);
            database.prepare('INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)')
                .run(migration.version, migration.name, migration.hash, new Date().toISOString());
            database.exec(`PRAGMA user_version=${migration.version}`);
            database.exec('COMMIT');
        } catch {
            database.exec('ROLLBACK');
            throw new AgentFault('STORAGE_SCHEMA_UNSUPPORTED', '存储迁移未提交，持久写入已停止', { migration: migration.name });
        }
    }
    const version = database.prepare('PRAGMA user_version').get();
    if (Number(version?.user_version) !== migrations.length) {
        throw new AgentFault('STORAGE_SCHEMA_UNSUPPORTED', '存储版本标记与迁移记录不一致');
    }
}
