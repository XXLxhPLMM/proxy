/**
 * @fileoverview 统一错误分类与收尾边界
 * @module core/error-boundary
 * @description
 * 把任意 catch 值转换成稳定的错误类别、建议状态码和安全消息，并按请求/运行时
 * 作用域发布**已经发生**的失败事实。协议实现仍负责选择具体应答形态。
 *
 * - **零协议写入 / 零日志 / 零环境读取 / 零文件**：本模块只分类 + 生成安全消息。
 *   ⚠️ 这半句**全仓零断言**，改它只能自己复核
 * - 分类真值表（timeout/504、Node 网络错误码 → upstream/502、协议错误 → protocol/502、
 *   未知 → internal/502 且 `expected:false` 不许被吞）与「不猜客户端 400」：
 *   判据全文见 `../../../tests/unit/error-boundary.test.ts` 头注释
 * - 事件发布是**可观测性副作用而非控制流**：观察者或总线自身抛错都会被吞掉，分类结果照常返回
 * - **分类本身是一个可替换端口**（`types/proxy.ts:ErrorClassifier`），本模块提供它的**默认
 *   实现** `DEFAULT_ERROR_CLASSIFIER`。`ErrorBoundary` 一律经 `this.classifier` 走，**绝不
 *   直调 `classifyError`** —— 直调会让注入悄悄失效而全部用例照绿，护栏见测试档。
 *   ⚠️ 该端口对「客户端可见状态码」**零影响**（那 7 处手写逻辑不经这里），理由全文见它的注释
 */

import type { EventContext, RequestStage } from "@/core/events/types.js";
import type { EventHub } from "@/core/events/hub.js";
import { DialTimeoutError } from "@/core/forward/upstream/dial.js";
import { isProxyHeaderName } from "@/core/helpers/index.js";
import type { ClassifiedError, ErrorClass, ErrorClassifier } from "@/core/types/proxy.js";
import {
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_GATEWAY_TIMEOUT,
} from "@/utils/constants/index.js";

/** 错误边界配置：事件总线、分类策略与跨调用共享的关联上下文均为可选注入。 */
export interface ErrorBoundaryOptions {
  /** 事件总线；缺省时只分类，不发布任何事件。 */
  hub?: EventHub;
  /**
   * 分类策略；缺省 = {@link DEFAULT_ERROR_CLASSIFIER}。
   * @description 走可选形参而不是必填：裸构 `new ErrorBoundary({ hub })` 是本模块的常规用法
   * （测试与任何只想发事件不想换分类的调用方），而「分类器缺席」有一条**说得清**的路——
   * 用默认分类，不判定任何东西。判据与其它端口的「必填 vs 显式 inert 档」之争见
   * `types/proxy.ts:ErrorClassifier`。
   */
  classifier?: ErrorClassifier;
  /** 关联上下文；单次调用传入的字段优先。 */
  context?: Partial<EventContext>;
}

const MAX_ERROR_MESSAGE_LENGTH = 200;
const REDACTED_VALUE = "[REDACTED]";

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EADDRNOTAVAIL",
  "EADDRINUSE",
  "EACCES",
  "ENETDOWN",
  "ENOPROTOOPT",
  "EAFNOSUPPORT",
  "EPROTO",
]);

const PROTOCOL_MESSAGE_PATTERN =
  /(?:bad\s*request|invalid\s+(?:request|target|url|authority|header|method)|malformed\s+(?:request|message|protocol|target)|parse\s*(?:error|failed)|protocol\s*(?:error|violation))/i;
const BAD_REQUEST_NAME_PATTERN = /bad[\s_-]*request/i;

/**
 * 匹配敏感头值的**整段**而不是只替换 scheme，否则 `Basic` 被替换后 token 仍会泄漏；
 * 遮蔽范围取「宁可遮多了」（代价是目标站少收一条头）。
 * `Proxy-Authorization` 复用 `helpers/headers` 的纯头名规则；Authorization/Cookie
 * 在错误消息场景一律按敏感信息遮蔽，不能因不属于代理自身凭证而暴露目标站凭证。
 * 样本与锁点见 `../../../tests/unit/error-boundary.test.ts`。
 */
const SENSITIVE_HEADER_PATTERN =
  /(["']?\b(proxy-authorization|authorization|cookie|set-cookie)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n]*)/gi;
const AUTH_SCHEME_PATTERN = /\b(Basic|Bearer)\s+[^\s,;)}\]]+/gi;
const COOKIE_ASSIGNMENT_PATTERN =
  /(\b(?:cookie|set-cookie)\s*=\s*)("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi;

function statusForClass(errorClass: ErrorClass): number {
  switch (errorClass) {
    case "timeout":
      return STATUS_GATEWAY_TIMEOUT;
    case "client":
      return STATUS_BAD_REQUEST;
    case "upstream":
    case "protocol":
    case "internal":
      return STATUS_BAD_GATEWAY;
  }
}

function propertyString(value: unknown, key: "code" | "name"): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    const property = (value as { [key in "code" | "name"]?: unknown })[key];
    return typeof property === "string" ? property : undefined;
  } catch {
    return undefined;
  }
}

function isDialTimeoutError(error: unknown): boolean {
  try {
    return error instanceof DialTimeoutError;
  } catch {
    return false;
  }
}

function isSyntaxOrUriError(error: unknown): boolean {
  try {
    return error instanceof SyntaxError || error instanceof URIError;
  } catch {
    return false;
  }
}

function rawErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string") {
      return error.message;
    }
  } catch {
    // 访问恶意/跨 realm 对象的 message 失败时继续走 String 兜底。
  }
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

function shouldRedactMessageHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    isProxyHeaderName(lower) ||
    lower === "authorization" ||
    lower === "cookie" ||
    lower === "set-cookie"
  );
}

function redactMessage(input: string): string {
  const withoutHeaders = input.replace(
    SENSITIVE_HEADER_PATTERN,
    (match: string, prefix: string, name: string): string =>
      shouldRedactMessageHeader(name) ? `${prefix}${REDACTED_VALUE}` : match,
  );
  return withoutHeaders
    .replace(AUTH_SCHEME_PATTERN, `$1 ${REDACTED_VALUE}`)
    .replace(COOKIE_ASSIGNMENT_PATTERN, `$1${REDACTED_VALUE}`);
}

function safeMessage(error: unknown): string {
  return redactMessage(rawErrorMessage(error)).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function classified(errorClass: ErrorClass, error: unknown, message: string): ClassifiedError {
  return {
    class: errorClass,
    status: statusForClass(errorClass),
    expected: errorClass !== "internal",
    cause: error,
    message,
  };
}

function isProtocolError(error: unknown, message: string): boolean {
  if (isSyntaxOrUriError(error)) {
    return true;
  }
  const name = propertyString(error, "name");
  const code = propertyString(error, "code");
  return (
    name === "SyntaxError" ||
    name === "URIError" ||
    BAD_REQUEST_NAME_PATTERN.test(name ?? "") ||
    BAD_REQUEST_NAME_PATTERN.test(code ?? "") ||
    PROTOCOL_MESSAGE_PATTERN.test(message)
  );
}

/**
 * 将任意 catch 值分类为稳定错误类别。
 *
 * @description 分类真值表与「不猜客户端 400（客户端拒绝走 `rejectRequest`）」的理由
 * 见 `../../../tests/unit/error-boundary.test.ts` 头注释。
 *
 * @param error - 任意 catch 到的值
 * @returns 含原始 cause、状态码、预期性和安全消息的分类结果（`cause` 不进公共载荷）
 * @example
 * ```ts
 * const result = classifyError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
 * result.class; // "upstream"
 * result.status; // 502
 * ```
 */
export function classifyError(error: unknown): ClassifiedError {
  if (isDialTimeoutError(error)) {
    return classified("timeout", error, safeMessage(error));
  }

  const code = propertyString(error, "code");
  if (code !== undefined && NETWORK_ERROR_CODES.has(code)) {
    return classified("upstream", error, safeMessage(error));
  }

  const message = rawErrorMessage(error);
  if (isProtocolError(error, message)) {
    return classified("protocol", error, redactMessage(message).slice(0, MAX_ERROR_MESSAGE_LENGTH));
  }

  return classified("internal", error, redactMessage(message).slice(0, MAX_ERROR_MESSAGE_LENGTH));
}

/**
 * 错误分类端口的**默认实现单例**（`ErrorClassifier`）
 *
 * @description
 * **冻结单例而不是每次 `new`**：它是无状态的纯函数包，共享一个实例让「注入没生效」在对象身份
 * 上也看得出来（各处拿到的都是同一个）——与 `BaseProxy` 里 `NONE_IDENTITY` / `INERT_TRAFFIC_ACCOUNT`
 * 同一条纪律，只是那两档是「禁用档」、这里是「真实现的缺省」。真值表与判据见
 * `../../../tests/unit/error-boundary.test.ts` 头注释。
 *
 * ⚠️ 替换方请**不要**从它派生（`{ ...DEFAULT_ERROR_CLASSIFIER, classify: 我的 }`）：那会把
 * `classifyClient` 一起换成你的，而那正是你要挑的那一半。要「只换一处」就显式写全两个方法。
 */
export const DEFAULT_ERROR_CLASSIFIER: ErrorClassifier = Object.freeze({
  classify: classifyError,
  classifyClient: classifyClientError,
});

/**
 * 显式把客户端侧错误归为 client/400。
 *
 * @description
 * 解析、鉴权、访问控制等“预期内拒绝”应由 `ErrorBoundary.rejectRequest` 发布
 * `request.rejected`；此函数提供给只有错误值、尚未决定是否写协议应答的调用方，
 * 避免把客户端输入错误误归为 internal。
 *
 * @param error - 客户端侧错误或原始值
 * @returns class 为 client、status 为 400 的分类结果
 * @example
 * ```ts
 * const result = classifyClientError(new Error("malformed header"));
 * result.status; // 400
 * ```
 */
export function classifyClientError(error: unknown): ClassifiedError {
  return classified("client", error, safeMessage(error));
}

/**
 * 统一错误分类与事件收尾边界。
 *
 * @description 边界本身不写协议应答、不打印日志；它只负责分类、生成安全消息，并在注入
 * `EventHub` 时发布 `request.failed`、`request.rejected` 或 `runtime.error`。
 * 事件发布路径自身有 try/catch，观察者异常不会改变返回值或调用方控制流。
 *
 * @example
 * ```ts
 * const boundary = new ErrorBoundary({ hub, context: { requestId: "request-1" } });
 * const classified = boundary.failRequest(error, "dial", { protocol: "http" });
 * if (!classified.expected) {
 *   // 由上层决定告警或升级处理
 * }
 * ```
 */
export class ErrorBoundary {
  private readonly hub: EventHub | undefined;
  private readonly classifier: ErrorClassifier;
  private readonly context: Partial<EventContext>;

  /**
   * 创建错误边界。
   *
   * @param options - 可选事件总线、分类策略与默认关联上下文；不传总线时仅分类
   */
  constructor(options: ErrorBoundaryOptions = {}) {
    this.hub = options.hub;
    // 缺省解析**只在这一处**：裸构的常规用法（只发事件、不换分类）不必知道默认实现是谁
    this.classifier = options.classifier ?? DEFAULT_ERROR_CLASSIFIER;
    this.context = { ...(options.context ?? {}) };
  }

  /**
   * 分类请求级失败，并可选发布 `request.failed`。
   *
   * @param error - 任意 catch 到的错误
   * @param stage - 失败发生的请求阶段
   * @param context - 本次请求覆盖默认上下文的关联字段
   * @returns 不受事件观察者异常影响的分类结果（走注入的分类策略，缺省为默认实现）
   * @example
   * ```ts
   * const result = boundary.failRequest(error, "dial", { client: "127.0.0.1" });
   * ```
   */
  public failRequest(
    error: unknown,
    stage: RequestStage,
    context?: Partial<EventContext>,
  ): ClassifiedError {
    const result = this.classifier.classify(error);
    if (this.hub !== undefined) {
      try {
        this.hub.publish("request.failed", { stage, error }, this.contextFor(context));
      } catch {
        // 事件总线故障不能改变错误分类或调用方控制流。
      }
    }
    return result;
  }

  /**
   * 发布预期内的请求拒绝，并返回调用方指定的状态码。
   *
   * @param reason - 拒绝原因（会在事件中按安全消息规则遮蔽）
   * @param stage - 拒绝发生的请求阶段
   * @param status - 协议调用方已经决定的应答状态码
   * @param context - 本次请求覆盖默认上下文的关联字段
   * @returns 原样返回 `status`，方便调用方直接用于协议应答
   * @example
   * ```ts
   * const status = boundary.rejectRequest("target denied", "access", 403);
   * ```
   */
  public rejectRequest(
    reason: string,
    stage: RequestStage,
    status: number,
    context?: Partial<EventContext>,
  ): number {
    if (this.hub !== undefined) {
      try {
        this.hub.publish(
          "request.rejected",
          { stage, status, reason: redactMessage(reason).slice(0, MAX_ERROR_MESSAGE_LENGTH) },
          this.contextFor(context),
        );
      } catch {
        // 事件总线故障不能改变协议收尾。
      }
    }
    return status;
  }

  /**
   * 分类运行时级错误，并可选发布 `runtime.error`。
   *
   * @param error - 任意 catch 到的错误
   * @param context - 运行时关联上下文的覆盖字段
   * @returns 不受事件观察者异常影响的分类结果（走注入的分类策略，缺省为默认实现）
   * @example
   * ```ts
   * const result = boundary.failRuntime(error, { protocol: "https" });
   * ```
   */
  public failRuntime(error: unknown, context?: Partial<EventContext>): ClassifiedError {
    const result = this.classifier.classify(error);
    if (this.hub !== undefined) {
      try {
        this.hub.publish("runtime.error", { error }, this.contextFor(context));
      } catch {
        // 事件总线故障不能改变调用方的错误处理。
      }
    }
    return result;
  }

  private contextFor(context?: Partial<EventContext>): Partial<EventContext> {
    return { ...this.context, ...(context ?? {}) };
  }
}
