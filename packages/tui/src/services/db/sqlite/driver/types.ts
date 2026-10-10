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
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** `DatabaseSync#prepare` / WASM 适配层共同满足的语句面（方法签名按 drizzle session 的调用方式收窄） */
export interface SqliteStatement {
  setReturnArrays(flag: boolean): void;
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): unknown;
}
