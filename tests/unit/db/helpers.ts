import { cpSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultMigrationsDir, openDatabase, migrate } from "@exos/stackd/db";

export function tempDir(prefix = "stackdb-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function freshDb() {
  const dir = tempDir();
  const file = join(dir, "stack.db");
  const db = openDatabase(file);
  migrate(db, defaultMigrationsDir());
  return { db, file, dir };
}

/** Copies the real migrations into a temp dir so a test can edit or extend them. */
export function copyMigrations(): string {
  const dir = join(tempDir("migrations-"), "m");
  mkdirSync(dir, { recursive: true });
  cpSync(defaultMigrationsDir(), dir, { recursive: true });
  return dir;
}
