/**
 * @fileoverview 单次读取 + 大小上限 + JSON.parse + 结构校验
 * @module utils/json-file/read-validate
 * @description
 * 只负责把「已经确认存在的普通文件」变成一份可信的值：先按 stat 大小挡掉病态大文件，
 * 再 `JSON.parse`，最后交给调用方的 `validate` 判形状。失败语义（与 stat 无关，发生在内容上）：
 * **保留上一份有效值 + 给出 error**，绝不返回半份状态，也**绝不抛**——`validate` 自己抛错
 * 同样被吞成 error 文案。
 *
 * 不负责：
 * - 不 stat、不判缺失/权限（`probe.ts`）
 * - 不缓存、不节流、不派发事件（`cache.ts` / `json-file.ts` / `subscriber.ts`）
 * - 不知道 `label`、也不知道去重状态；它只管「这一份内容行不行」
 */

import fs from "node:fs";
import { errorMessage } from "./probe.js";

/** 一次读取的结果：`value` 恒可用（失败时是上一份有效值），`error` 描述失败原因 */
export interface ReadOutcome<T> {
  value: T;
  error?: string;
}

/**
 * 把「已经确认存在的普通文件」变成一份可信的值。**绝不抛**。
 *
 * @description
 * **格式无关**是本函数的全部要点：它只管「大小上限 + 调用方的解析 + 失败沿用上一份」，
 * 不管那份内容是 JSON 还是别的什么。`JSON.parse` 出现在**调用方**（`json-file.ts`）而不是这里，
 * 于是「SQLite 账号表也要享受同一套 1s 节流 / 四态事件 / 坏内容保留上一份」这件事
 * 不必把节流与事件逻辑抄第二遍——那正是本仓最恨的「两份真相源」。
 *
 * 大小上限沿用 **stat 拿到的字节数**而不是实读长度：它挡的是「病态大文件在读进内存之前
 * 就被拒」，对 SQLite 同样有意义（`.db` 膨胀到几百 MB 说明有别的问题）。
 *
 * @param size - stat 拿到的字节数（先按它判上限，避免把超大文件读进内存）
 * @param maxBytes - 字节上限，超过即视为坏内容
 * @param load - 解析函数：合法返回可信值，非法（语法错 / 形状错 / 读失败）返回 undefined
 * @param previous - 上一份有效值（无历史时由调用方给 fallback）；读取失败时原样沿用
 */
export function readVia<T>(
  absolutePath: string,
  size: number,
  maxBytes: number,
  load: (path: string) => T | undefined,
  previous: T,
): ReadOutcome<T> {
  try {
    if (size > maxBytes) {
      throw new Error(`文件超过 ${maxBytes} 字节上限`);
    }
    const valid = load(absolutePath);
    if (valid === undefined) {
      throw new Error("格式非法（字段缺失、类型不符或存在未知键）");
    }
    return { value: valid };
  } catch (error) {
    // 上一份有效值继续生效：坏内容期间请求面照旧用旧配置，只多一条 error 事件
    return { value: previous, error: errorMessage(error) };
  }
}

/**
 * 读取并校验一个 JSON 配置文件。**绝不抛**。
 *
 * @param size - stat 拿到的字节数
 * @param maxBytes - 字节上限，超过即视为坏内容
 * @param validate - 校验函数：合法返回解析值，非法返回 undefined
 * @param previous - 上一份有效值（无历史时由调用方给 fallback）；读取失败时原样沿用
 */
export function readAndValidate<T>(
  absolutePath: string,
  size: number,
  maxBytes: number,
  validate: (raw: unknown) => T | undefined,
  previous: T,
): ReadOutcome<T> {
  return readVia(
    absolutePath,
    size,
    maxBytes,
    (target) => validate(JSON.parse(fs.readFileSync(target, "utf8")) as unknown),
    previous,
  );
}
