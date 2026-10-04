/**
 * 本目录三档共用的请求标签、收窄失败取回器与那条「抄进终端就出事」的凭据样本
 *
 * @description
 * 判据与不变量在 `./AGENTS.md`；这里只放三档都要用、且**必须是同一份**的东西。抄成三份的话，
 * 改一处漏掉另两处，而症状是「某一档的红由另一档的改动造成」—— 最难查的那一种。
 */

import { expect } from "vitest";
import { TuiError } from "@/lib/errors.js";

/** 请求标签：收窄器的第三个参数，用于错误里的「是哪个请求」 */
export const REQ = "GET /api/status";

/**
 * 跑一次收窄并取回抛出的 `TuiError`
 * @description 没抛时**显式失败**：返回一个假错误会让下游断言对着空对象判绿。
 */
function caught(run: () => unknown): TuiError {
  try {
    run();
  } catch (err) {
    expect(err, "收窄失败必须抛 TuiError 而不是别的").toBeInstanceOf(TuiError);
    return err as TuiError;
  }
  throw new Error("判据：本次调用应当抛 TuiError（实际没抛）");
}

/** 断言「这确实是一档 `shape` 失败」 */
export function expectShape(run: () => unknown): TuiError {
  const err = caught(run);
  expect(err.kind).toBe("shape");
  expect(err.code).toBe("bad-shape");
  return err;
}

/** 一条会被抄进终端就出事的内容：来自对面响应体的凭据形态 */
export const SECRET = "s3cr3t-token-value";
