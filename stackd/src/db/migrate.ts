import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@exos/common";
import type { Db } from "./connection.ts";

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("../../migrations", import.meta.url));
}

interface Migration {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

function loadMigrations(dir: string): Migration[] {
  const found: Migration[] = [];
  for (const file of readdirSync(dir)) {
    const m = file.match(/^(\d{4})_([a-z0-9_]+)\.sql$/);
    if (!m) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    found.push({ version: Number(m[1]), name: m[2]!, file, sql, checksum: sha256Hex(sql) });
  }
  found.sort((a, b) => a.version - b.version);
  for (let i = 0; i < found.length; i++) {
    const m = found[i]!;
    if (i > 0 && found[i - 1]!.version === m.version) {
      throw new Error(
        `duplicate migration version ${m.version} (${found[i - 1]!.file}, ${m.file})`,
      );
    }
    if (m.version !== i + 1) {
      throw new Error(`migration gap: expected version ${i + 1}, found ${m.version} (${m.file})`);
    }
  }
  return found;
}

/**
 * Applies pending numbered migrations in order, each in its own transaction, and returns the
 * versions applied. Applied migrations are checksummed; editing one is an error (add a new one).
 */
export function migrate(db: Db, dir: string): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const migrations = loadMigrations(dir);
  const applied = new Map(
    (
      db.prepare("SELECT version, checksum FROM schema_migrations").all() as {
        version: number;
        checksum: string;
      }[]
    ).map((r) => [r.version, r.checksum]),
  );

  const done: number[] = [];
  for (const m of migrations) {
    const recorded = applied.get(m.version);
    if (recorded !== undefined) {
      if (recorded !== m.checksum) {
        throw new Error(
          `migration ${m.file}: checksum differs from the applied version; add a new migration instead of editing it`,
        );
      }
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(m.version, m.name, m.checksum, new Date().toISOString());
    }).immediate();
    done.push(m.version);
  }
  return done;
}
