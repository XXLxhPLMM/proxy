/**
 * @fileoverview 本包**唯一**的失败词汇 —— 每一个出口的失败都是这三种形态之一
 * @module utils/errors
 */

/**
 * 失败的三档
 * @description 判据是「谁能修」：
 * - `local`：本机的东西不对（台账 JSON 坏了、参数不合法、环境没激活）。**不需要发请求**就能判。
 * - `wire`：对面答了，而答案是失败（4xx/5xx 带着它自己的错误体）。
 * - `transport`：连接层就没成（连不上、超时、TLS 失败）—— 没有任何响应体。
 */
export type McpErrorCode = "local" | "wire" | "transport";

export interface McpErrorInit {
  readonly code: McpErrorCode;
  readonly message: string;
  /** `wire` 档：HTTP 状态码；其余档恒 `null` */
  readonly status?: number | null;
  /** `wire` 档：服务端给的关联 id，排查时拿去 grep 它的日志 */
  readonly requestId?: string | null;
  readonly cause?: unknown;
}

/**
 * 一条面向**模型**的失败
 * @description
 * ⚠️ `message` 会逐字进 tool result，而 tool result 会进模型的上下文。故这条类型里
 * **不许**有字段通往凭据：`baseUrl` / `key` 都不许出现在 `message` 的构造里
 * （`key` 更是任何情况下都不许出现 —— 它等价于主机上的 root shell）。
 */
export class McpError extends Error {
  public readonly code: McpErrorCode;
  public readonly status: number | null;
  public readonly requestId: string | null;

  public constructor(init: McpErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "McpError";
    this.code = init.code;
    this.status = init.status ?? null;
    this.requestId = init.requestId ?? null;
  }

  /** 本机侧的失败（**一个请求都没发**） */
  public static local(message: string, cause?: unknown): McpError {
    return new McpError({ code: "local", message, ...(cause === undefined ? {} : { cause }) });
  }

  /** 对面答了，而答案是失败 */
  public static wire(
    message: string,
    status: number | null,
    requestId: string | null,
    cause?: unknown,
  ): McpError {
    return new McpError({
      code: "wire",
      message,
      status,
      requestId,
      ...(cause === undefined ? {} : { cause }),
    });
  }

  /** 连接层就没成 */
  public static transport(message: string, cause?: unknown): McpError {
    return new McpError({
      code: "transport",
      message,
      ...(cause === undefined ? {} : { cause }),
    });
  }

  /** 一句话形态（进 tool result 的那一份：带档位与状态码，模型据此决定重试还是改参数） */
  public toReport(): string {
    const head = `[${this.code}]`;
    const status = this.status === null ? "" : ` HTTP ${String(this.status)}`;
    const requestId = this.requestId === null ? "" : ` requestId=${this.requestId}`;
    return `${head}${status}${requestId} ${this.message}`;
  }
}

/** 任何异常 → 一条 {@link McpError}（⚠️ **未知异常不许把 `String(err)` 直接透出去**，那可能是整个栈） */
export function asMcpError(err: unknown): McpError {
  if (err instanceof McpError) {
    return err;
  }
  if (err instanceof Error) {
    return new McpError({ code: "local", message: err.message, cause: err });
  }
  return new McpError({ code: "local", message: "未知的失败（不是 Error 实例）", cause: err });
}
