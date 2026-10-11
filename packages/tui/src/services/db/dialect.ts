import { closeSqliteDb, openSqliteDb } from "./sqlite/client.js";

/** 支持的方言（今天只有 sqlite 真能开，另两档先占名，见 {@link openDb}） */
export const DB_DIALECTS = ["sqlite", "mysql", "pgsql"] as const;

export type DbDialect = (typeof DB_DIALECTS)[number];

/** 不写 `dialect` 时生效的档 */
export const DEFAULT_DB_DIALECT: DbDialect = "sqlite";

/** 开库配置；sqlite 给文件路径，mysql / pgsql（都还没实现）给连接串与凭据散格 */
export type DbConfig =
  | { /** 缺省档 */ readonly dialect?: "sqlite"; /** 库文件路径 */ readonly path: string }
  | {
      readonly dialect: "mysql" | "pgsql";
      /** 连接串：`mysql://host[:port]/库名`；凭据可内嵌在串里 */
      readonly url: string;
      /** 账号（预留：不想把凭据写进连接串时用；mysql / pgsql 实现时接线） */
      readonly user?: string;
      /** 口令（预留） */
      readonly password?: string;
    };

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Assert<T extends true> = T;

/** 编译期断言：`DbConfig` 写出的方言集合与 {@link DB_DIALECTS} 逐字相等 */
export type DbDialectsMatchConfig = Assert<Exact<NonNullable<DbConfig["dialect"]>, DbDialect>>;

/** 打开的库句柄（drizzle 实例；今天是 sqlite 那一档） */
export type Db = ReturnType<typeof openSqliteDb>;

/** 按方言开库；sqlite（或缺省）开文件库，mysql / pgsql 今天**抛** */
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

/** 关库（幂等由驱动档保证） */
export function closeDb(db: Db): void {
  closeSqliteDb(db);
}
