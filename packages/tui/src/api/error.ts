/**
 * @fileoverview 本包唯一的失败词汇：`TuiError`（三档判别，一次构造）
 * @module client/error
 * @description
 * 本包面对的失败有**三类**，它们对操作者的意义完全不同，混成一类就等于让界面只能说「出错了」：
 *
 * | kind | 含义 | 操作者能做什么 |
 * |---|---|---|
 * | `wire` | 服务端答了，而且答案是「不」 | 读文案；`unauthorized` → 查 token |
 * | `transport` | **根本没答上**（DNS / 连不上 / 超时 / 连接被掐） | 查地址与网络，**不是**查数据 |
 * | `shape` | 答了，但**不像本包声明的那个形状** | 多半是对面版本比本包新/旧；**不是**操作者的错 |
 *
 * ���三类分开不是分类癖，是因为**处置动作不同**：把「服务没起来」显示成「token 不对」会把人
 * 带去改一份完全正确的凭据，而把「对面版本对不上」显示成「内部错误」会让人去翻服务端日志里一行
 * 根本不存在的东西。
 *
 * ## 表外的 `code` 一律降级成 `internal`
 * @description
 * 本包的 {@link ./types.ts:WireCode} 是手抄的一份闭合集。对面升级后加了新 code 时，本包收到它
 * **不能**原样透传 —— 本包并不认识那个 code 的语义，而 `message` 是服务端为**它的**语义写的
 * 一句中性事实陈述，原样显示等于宣称「我知道这是什么」。降级成 `internal` 时**保留 `requestId`**：
 * 那是唯一还能让人接上服务端日志的线索。
 *
 * 本模块**零 console、零 process** —— 呈现归 UI 层。
 *
 * @module
 */

/** 失败的三档判别（见文件头的表） */
export type FailureKind = "wire" | "transport" | "shape";

/** 本包自己的三个 code（不是服务端的，故不进 {@link ./types.ts:WireCode}） */
export type LocalCode = "unreachable" | "timeout" | "bad-shape";

/** 本包的全部失败码 = 服务端闭合集 ∪ 本包自造三档 */
export type TuiCode = import("./types.js").WireCode | LocalCode;

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

/** 本包唯一的失败类型 */
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
   * @description `request` 必给：本包的界面上同时可能有多个 manager 在飞，
   * 「哪个请求失败」比「失败了」有用得多。
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
   * @description
   * 刻意挂在 **`wire` 档 + `invalid` 码**上，而不是新开一档，也不是塞进 `transport`：
   * - 不塞 `transport`：那一档的定义是「根本没答上」，而这里根本没**问**——把它算成网络问题
   *   会让界面提示「检查网络与地址」，而操作者敲错的是地址文本本身。
   * - 不新开一档：服务端对同样的坏输入回的**就是** `invalid`（`routes/input.ts` 的
   *   `OpsError("invalid", …)`）。同一种失败在两端同一个 code，界面也只需要认一个。
   * - 不省掉本地判：让一次注定被拒的请求走完整个网络往返，才显示服务端那句一模一样的话，
   *   是在浪费操作者的注意力。本地判的价值是**快**，不是**判得不同**。
   *
   * ⚠️ `status` 恒为 `null`（见文件头「没收到响应就没有状态码」）且 `request` 恒为
   * {@link LOCAL_REQUEST} —— 界面上要把「没发出去」与「发出去了被拒」显示成两件事。
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

  /**
   * 答了但形状不对
   * @description ⚠️ `message` **只说形状差在哪**，绝不转述对面那条 body 的内容：那串字节来自
   * 一个本包不认识版本的进程，它既可能是凭据也可能是名单，把它打印到终端等于把对面的数据
   * 抄进本机的滚动缓冲。
   */
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

/**
 * `request` 字段里「**这一次没有真的发出去**」的标记
 * @description 它是一个**占位**而不是描述：界面上要把「地址敲错了，请求没出门」与「出了门被
 * 401」显示成两件事，而后者一定有 `status` 与一个真实路径。
 */
export const LOCAL_REQUEST = "(未发出)";

/**
 * 这条失败**重试**有没有意义
 * @description
 * ⚠️ **判据是 `code`，不是 `kind`。** 只看 `kind` 会把 `unreachable`（地址敲错 / 网络断了 /
 * 服务没起）也算成可重试，于是界面对着一个明显敲错的地址提示「重试」——那是在教操作者反复按
 * 一个不可能成功的按钮。
 *
 * 只有 `timeout` 值得重试：它是**对面在忙**，与本机的输入无关。`unreachable` 的处置是查地址与
 * 网络，`shape` 的处置是升级本包或对面，`wire` 的处置是改请求或改凭据。
 */
export function isRetryable(err: TuiError): boolean {
  return err.code === "timeout";
}
