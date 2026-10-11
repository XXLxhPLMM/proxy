/**
 * @fileoverview 驱动层的类型契约（零运行时值）：两档驱动与 client 共用
 * @description
 * 只声明「drizzle `node-sqlite` session 真正调用到的那一小块客户面」——内置档由
 * `DatabaseSync` 满足，降级档由 wasm 适配层满足。单独成文件是为了让驱动实现与
 * `client.ts` 只引类型、零运行时代价，也不成环。
 */

/** 可绑到占位符的值（TUI 只写文本/整数，JSON 也以文本进） */
export type SqlValue = string | number | null;

/** drizzle `node-sqlite` session 真正调用到的客户面（两档共同满足） */
export interface SqliteClient {
  /** 预备一条 SQL（`?` 占位符），交出语句面 */
  prepare(sql: string): SqliteStatement;
  /** 关底层连接（幂等：两档各自保证，见 `builtin.ts` / `wasm.ts` 的 close） */
  close(): void;
}

/** `DatabaseSync#prepare` / WASM 适配层共同满足的语句面（方法签名按 drizzle session 的调用方式收窄） */
export interface SqliteStatement {
  /** drizzle 的 `mode: "arrays"`：置位后 `all` / `get` 必须按列序返回数组（降级档在这里做行列序护栏） */
  setReturnArrays(flag: boolean): void;
  /** 按 `?` 顺序绑定 `params` 并取回**全部行**；行形按 `setReturnArrays` 的档（数组或对象行） */
  all(...params: SqlValue[]): unknown[];
  /** 绑定并取**第一行**；一行都没有时给 `undefined`（两档同行为） */
  get(...params: SqlValue[]): unknown;
  /** 绑定并执行写语句（不取行）；运行结果的形状由各档决定，本包原样交给 drizzle */
  run(...params: SqlValue[]): unknown;
}
