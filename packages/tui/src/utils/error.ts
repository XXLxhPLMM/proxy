/**
 * @fileoverview 本包唯一的失败词汇：`TuiError`（三档判别，一次构造）
 * @module utils/error
 * @description
 * 三档分开是因为**处置动作不同**，混成一类界面就只能说「出错了」：
 *
 * | kind | 含义 | 操作者能做什么 |
 * |---|---|---|
 * | `wire` | 服务端答了，而且答案是「不」 | 读文案；`unauthorized` → 查 token |
 * | `transport` | **根本没答上**（DNS / 连不上 / 超时 / 连接被掐） | 查地址与网络，**不是**查数据 |
 * | `shape` | 答了，但**不像本包声明的那个形状** | 多半是对面版本比本包新/旧 |
 *
 * ⚠️ **`message` 绝不转述对面的数据**（响应的 body、带凭据的地址、任何一段 token）：那串字节来自一个本包不认识
 * 版本的进程。只说「哪个路径期望什么」。
 *
 * @module
 */

import type { WireCode } from "@/api/index.js";

/** 失败的三档判别（见文件头的表） */
export type FailureKind = "wire" | "transport" | "shape";

/** 本包自己的三个 code（不是服务端的，故不进 {@link @/api/index.js:WireCode}） */
export type LocalCode = "unreachable" | "timeout" | "bad-shape";

/** 本包的全部失败码 = 服务端闭合集 ∪ 本包自造三档（服务端那一半的**契约**在 `@/api/types.js:WireCode`） */
export type TuiCode = WireCode | LocalCode;

/** 构造参数（三档各自需要的字段） */
export interface TuiErrorInit {
  readonly kind: FailureKind;
  readonly code: TuiCode;
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

  /**
   * 本地输入形状不对，**请求从未发出**
   * @description ⚠️ 刻意挂在 **`wire` 档 + `invalid` 码**上：不塞 `transport`（那一档是「根本没答上」，而这里
   * 根本**没问**，塞进去会让界面提示「检查网络与地址」而操作者敲错的是地址文本）；不新开一档（服务端对同样
   * 的坏输入回的**就是** `invalid`）。⚠️ `status` 恒为 `null`、`request` 恒为 {@link LOCAL_REQUEST} —— 界面
   * 上要把「没发出去」与「发出去了被拒」显示成两件事。
   */
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

/** `request` 字段里「**这一次没有真的发出去**」的标记（**占位**而不是描述：后者——出了门被 401——一定有
 * `status` 与一条真实路径，界面要把两件事显示成两件事） */
export const LOCAL_REQUEST = "(未发出)";

/**
 * 这条失败**重试**有没有意义
 * @description ⚠️ **判据是 `code`，不是 `kind`。** 只看 `kind` 会把 `unreachable`（地址敲错 / 网络断了 / 服务
 * 没起）也算成可重试，于是界面对着一个明显敲错的地址提示「重试」。只有 `timeout` 值得重试：它是**对面在忙**。
 */
export function isRetryable(err: TuiError): boolean {
  return err.code === "timeout";
}