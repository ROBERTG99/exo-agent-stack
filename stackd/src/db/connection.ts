import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

/** Opens (creating directories as needed) the stack database in WAL mode with FKs and a busy timeout. */
export function openDatabase(file: string): Db {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

/** Read-only handle for tools such as `exos audit verify`; the file must already exist. */
export function openReadonly(file: string): Db {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}
