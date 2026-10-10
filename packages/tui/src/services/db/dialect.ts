import { closeSqliteDb, openSqliteDb } from "./sqlite/client.js";

export const DB_DIALECTS = ["sqlite", "mysql", "pgsql"] as const;

export type DbDialect = (typeof DB_DIALECTS)[number];

export const DEFAULT_DB_DIALECT: DbDialect = "sqlite";

export type DbConfig =
  | { readonly dialect?: "sqlite"; readonly path: string }
  | { readonly dialect: "mysql" | "pgsql"; readonly url: string };

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Assert<T extends true> = T;

export type DbDialectsMatchConfig = Assert<Exact<NonNullable<DbConfig["dialect"]>, DbDialect>>;

export type Db = ReturnType<typeof openSqliteDb>;

export function openDb(config: DbConfig): Db {
  switch (config.dialect) {
    case "sqlite":
    case undefined:
      return openSqliteDb(config.path);

    case "mysql":
    case "pgsql":
      throw new Error(`${config.dialect} 还没实现：今天只有 sqlite 那一格`);

    default:

      throw new Error(`认不出的 dialect：只有 ${DB_DIALECTS.join(" / ")} 这三种`);
  }
}

export function closeDb(db: Db): void {
  closeSqliteDb(db);
}
