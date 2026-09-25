/**
 * 层内共享：把泛型配置对象收窄成可按 `ConfigKey` 索引的 record。
 *
 * 泛型 `T extends object` 不能直接用 `ConfigKey` 索引，也不一定能安全断言成
 * `Record<string, unknown>`；本目录三个文件都需要这一步，故收在一处，避免各写各的强转。
 */

/** 把配置对象视图化为可索引 record（不复制、不修改原对象）。 */
export function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}
