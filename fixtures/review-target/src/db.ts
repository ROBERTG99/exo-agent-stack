export interface Db {
  query(sql: string, params?: unknown[]): unknown[];
}

export function findUser(db: Db, name: string) {
  return db.query("SELECT * FROM users WHERE name = '" + name + "'");
}
