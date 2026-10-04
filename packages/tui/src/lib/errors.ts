/**
 * @fileoverview 本包唯一的失败词汇：`TuiError`（三档判别，一次构造）
 * @module utils/error
 * @description 三档分开是因为**操作者的处置动作不同**：`wire` 读文案、`transport` 查地址与网络、`shape` 查对面版本。
 */

import type { WireCode } from "@/api/index.js";

/** 失败的三档判别 */
export type FailureKind = "wire" | "transport" | "shape";

/** 本包自己的三个 code（不是服务端的，故不进 {@link @/api/index.js:WireCode}） */
export type LocalCode = "unreachable" | "timeout" | "bad-shape";

/** 本包的全部失败码 = 服务端闭合集 ∪ 本包自造三档（服务端那一半的**契约**在 `@/api/types.js:WireCode`） */
export type TuiCode = WireCode | LocalCode;

export interface TuiErrorInit {
  readonly kind: FailureKind;
  readonly code: TuiCode;
  /** ⚠️ 绝不转述对面的数据（响应的 body、带凭据的地址、任何一段 token），只说「哪个路径期望什么」 */
  readonly message: string;
  /** HTTP 状态码；`transport` 档恒为 `null`（**没收到响应就没有状态码**，别拿 0 冒充） */
  readonly status?: number | null;
  /** 服务端给的关联 id；界面上必须能看见它，否则 5xx 是死路 */
  readonly requestId?: string | null;
  /** 请求的目标（方法 + 路径），用于「是哪个请求失败了」 */
  readonly request?: string | null;
  readonly cause?: unknown;
}

export class TuiError extends Error {
  public readonly kind: FailureKind;
  public readonly code: TuiCode;
  public readonly status: number | null;
  public readonly requestId: string | null;
  public readonly request: string | null;

  public constructor(init: TuiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "TuiError";
    this.kind = init.kind;
    this.code = init.code;
    this.status = init.status ?? null;
    this.requestId = init.requestId ?? null;
    this.request = init.request ?? null;
  }

  /**
   * 服务端明确答了「不」
   * @description `request` 必给：界面上同时可能有多个 manager 在飞，「哪个请求失败」比「失败了」有用得多。
   */
  public static wire(args: {
    code: TuiCode;
    message: string;
    status: number;
    requestId?: string | null;
    request: string;
  }): TuiError {
    return new TuiError({
      kind: "wire",
      code: args.code,
      message: args.message,
      status: args.status,
      requestId: args.requestId ?? null,
      request: args.request,
    });
  }

  /** 本地输入形状不对，**请求从未发出** */
  /** ⚠️ 挂 `wire` 档 + `invalid` 码，不塞 `transport`：那一档的处置是「查地址与网络」，而这里没发出去 */
  public static local(args: { message: string }): TuiError {
    return new TuiError({
      kind: "wire",
      code: "invalid",
      message: args.message,
      status: null,
      request: LOCAL_REQUEST,
    });
  }

  /** 根本没答上（连接层失败） */
  public static transport(args: {
    code: LocalCode;
    message: string;
    request: string;
    cause?: unknown;
  }): TuiError {
    return new TuiError({
      kind: "transport",
      code: args.code,
      message: args.message,
      status: null,
      request: args.request,
      cause: args.cause,
    });
  }

  /** 答了但形状不对（`message` 只说形状差在哪，理由见文件头） */
  public static shape(args: { what: string; request: string }): TuiError {
    return new TuiError({
      kind: "shape",
      code: "bad-shape",
      message: `${args.what} 的响应不像本包声明的形状（多半是对面版本与本包不一致）`,
      status: null,
      request: args.request,
    });
  }
}

/** `request` 字段里「**这一次没有真的发出去**」的标记（⚠️ 是**占位**而不是描述：出了门被 401 一定有真 `status` 与真路径） */
export const LOCAL_REQUEST = "(未发出)";

/** 这条失败**重试**有没有意义；⚠️ 判据是 `code` 而不是 `kind` —— 只有 `timeout` 值得重试（对面在忙） */
export function isRetryable(err: TuiError): boolean {
  return err.code === "timeout";
}