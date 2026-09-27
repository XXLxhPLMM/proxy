/**
 * 泛型 `T extends object` 不能直接用 `ConfigKey` 索引，也不一定能安全断言成
 * `Record<string, unknown>`；本目录三处都需要这一步，故收在一处，避免各写各的强转。
 */

export function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}
