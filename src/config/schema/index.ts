/**
 * schema 层出口：字段元数据 + 解析原语 + 校验。
 *
 * 依赖方向：`parse` ← `fields` ← `validate`（本目录内单向），不反向依赖 `sources`、
 * `normalize` 或任何 IO 模块。
 */

export { FIELDS, keysByPhase, type FieldDef } from "./fields.js";
export { collectIntRangeErrors, resolveFieldEntries, assertAuthConfig } from "./validate.js";
export { toBoolean } from "./parse.js";
