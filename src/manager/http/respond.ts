/**
 * @fileoverview JSON 输出 + `OpsError` → HTTP 状态码映射（**绝不泄露栈**）
 * @module manager/http/respond
 * @description
 * 本模块是「ops 的结构化失败」到「HTTP 线上字节」的唯一翻译层。它有三个职责，逐条都有代价：
 *
 * ## ① 状态码**只**由 `OpsError.code` 决定，绝不猜 message 文本
 *
 * `OpsError.code` 是 ops 层维护的**闭合分类**（见 `@/ops/error.ts`），文案是给人读的、随上下文变。
 * 拿 `message.includes("已经有")` 去判 409 是本仓最典型的「第二份真相源」：文案改一次
 * （哪怕只是加个词），状态码就悄悄变成 500。故 {@link statusForOpsError} 的判据**只有** `code`
 * 一个字段，且查表而不是 if-else 链——表外的 `code` 一律落到 {@link INTERNAL_STATUS}（500），
 * 那正是「我不认识这个分类，于是不敢假装懂」的正确落点。
 *
 * ## ② 错误响应**绝不携带栈**
 *
 * `OpsError` 的 `message` 是 ops 给的**中性事实陈述**（不含栈），原样透传——传输层**不得**改写
 * 它（改了就变成「同一件事在两个入口说两种话」）。而**不是 `OpsError` 的**任何异常（IO 错误、
 * 数据源构造失败、JSON 解析炸了…）一律降级成 `500` + 一个 `requestId`，细节只进 logger。
 * 那些 message 里带绝对路径、驱动名、内部栈帧；控制面是「能改账号与名单」的面，把这些回给
 * 一个**鉴权已经过了**但未必是可信调用方的请求，等于把内网布局送出去。
 *
 * ## ③ `changed: false` 仍然是 200
 *
 * 名单的幂等 no-op（条目本来就在 / 本来就不在）是**一次成功**（用户达到了目的），不是失败。
 * 报成 4xx 会让调用方以为操作坏了并重试；报成「成功改了」则是谎报。故它走正常 200，
 * 由 {@link HttpResult} 的 `changed: false` 如实表达「一个字节都没动」。
 *
 * 本模块**零 console、零 process**；诊断输出走注入的 logger。
 *
 * @module
 */

import type { ServerResponse } from "node:http";
import { OpsError, type OpsErrorCode } from "@/ops/index.js";
import type { LoggerImpl } from "@/utils/logger/index.js";

/** 内部错误（未分类 / 非 `OpsError`）的状态码 */
export const INTERNAL_STATUS = 500;

/**
 * `OpsError.code` → HTTP 状态码。**这张表就是全部判据**，表外一律 500。
 * @description
 * 逐条的理由：
 * - `not-found` → **404**：目标不存在。这是「请求的路径指向一个没有的东西」的标准答案。
 * - `already-exists` → **409**：目标已存在而这次要求它不存在。409 的语义正是
 *   「请求与资源当前状态冲突」；**不是** 400——请求本身完全合法，冲突在资源那一侧。
 * - `invalid` → **400**：调用方给的那几个参数**组合**不成立。请求有错，且只有调用方能修。
 * - `read-only-driver` → **501**：这份驱动**没有实现写面**。请求合法、参数合法，是**部署侧**
 *   永久缺这个能力，重试一万次也一样。400 会说「你的请求有错」，那是谎话；503 会说
 *   「稍后重试」，同样是谎话。只有 501 如实说「这个服务器不支持这个操作」。
 * - `source-unreadable` → **500**：内容读不到 / 形状非法。这不是「你的请求错了」，是**服务器
 *   自己的数据坏了**（磁盘上那份文件已经不对）。它通常需要人修文件，故不是 503。
 */
const STATUS_BY_CODE: Readonly<Record<OpsErrorCode, number>> = {
  "not-found": 404,
  "already-exists": 409,
  invalid: 400,
  "read-only-driver": 501,
  "source-unreadable": 500,
};

/**
 * 一条 `OpsError` 该回什么状态码
 * @description
 * 判据**只有** `err.code`。表外（含 `undefined`、含将来某个拼错的字面量）一律 500 ——
 * 「不认识这个分类」时诚实的落点是「我不知道」，而不是去 `message` 里找一个看起来像的词。
 *
 * @param err - 捕获到的 `OpsError`
 * @returns HTTP 状态码
 * @example statusForOpsError(new OpsError("already-exists", "…")) // => 409
 */
export function statusForOpsError(err: OpsError): number {
  // `Record<OpsErrorCode, number>` 在类型上是全覆盖的，运行期仍可能拿到表外的值
  // （跨版本升级的产物、手工构造的替身、ops 增了一个 code 而本表还没跟上）。
  // 那时**必须**落到 500 而不是 `undefined`（`undefined` 会被 `res.writeHead` 当成非法状态码抛）。
  return STATUS_BY_CODE[err.code] ?? INTERNAL_STATUS;
}

/** 错误响应体的形状（**永远**不含 `stack`） */
export interface ErrorBody {
  readonly error: {
    /** 机器可读的分类。`internal` = 详情只进日志，响应里只有 `requestId`。 */
    readonly code: OpsErrorCode | "internal" | "unauthorized" | "not-found" | "method-not-allowed" | "bad-request";
    /** 人读的一句话。`internal` 时是固定文案，不含任何内部细节。 */
    readonly message: string;
    /** 关联 id：拿去 grep 日志里的那一行。`internal` 一定有。 */
    readonly requestId?: string;
  };
}

/** 写一个 JSON 响应（`Content-Type` + `Content-Length` + `no-store` + 额外头） */
function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  if (res.writableEnded) {
    return;
  }
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.byteLength),
    // 控制面响应（配置全量、账号列表、token 相关的错误）**一律不许被缓存**：
    // 中间缓存拿到 `GET /api/config` 的副本，等于把一份含路径与账号表的快照留在磁盘上。
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * handler 的返回值：**状态码与响应体是一起给的**
 * @description
 * 让 handler 能自己定 2xx（`POST /api/users` 回 **201** 而不是 200、其余回 200）而不必
 * 把状态码塞进响应体里（那会让调用方在两个地方各找一个值：`body.status` 与 HTTP 头，
 * 而它们可以不一致——不一致时没有任何东西会红）。
 */
export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

/** 造一个 2xx 结果（`handler` 侧的构造器，故由 `router.ts` 的类型与本模块共用） */
export function reply(status: number, body: unknown): HttpResult {
  return { status, body };
}

/** 回一个成功响应（状态码由 handler 给） */
export function sendResult(res: ServerResponse, result: HttpResult): void {
  writeJson(res, result.status, result.body);
}

/** 回一个错误响应（`code` 由调用方给，`message` 必须已经是不含内部细节的） */
export function sendError(
  res: ServerResponse,
  status: number,
  code: ErrorBody["error"]["code"],
  message: string,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  writeJson(res, status, { error: { code, message, requestId } } satisfies ErrorBody, extraHeaders);
}

/**
 * 401 专用出口（**本服务唯一的 401**）
 * @description
 * 单独一个函数而不是 `sendError` 的一个可选头参数：401 是这套面里**唯一**带
 * `WWW-Authenticate` 的状态（RFC 7235 §3.1 要求 401 带它，而 403 不带），把它做成
 * `sendError(..., { wwwAuthenticate: true })` 就是给「响应形状」加一个布尔开关。
 *
 * **不**回显请求方带来的那个凭据：回显等于把它抄进访问日志 / 中间代理的日志。
 * `realm` 是固定字面量，不含主机名、路径或任何部署事实。
 */
export function sendUnauthorized(res: ServerResponse, requestId: string): void {
  writeJson(
    res,
    401,
    {
      error: { code: "unauthorized", message: "缺少或错误的 Bearer 凭据", requestId },
    } satisfies ErrorBody,
    // `writeHead` 一旦调用响应头就定型，故 `WWW-Authenticate` 必须**随这一次 writeHead 一起**写出
    // （事后再 `setHeader` 不生效）。
    { "WWW-Authenticate": 'Bearer realm="manager"' },
  );
}

/** 内部错误的固定文案：**逐字不含路径 / 驱动名 / 栈**，只给关联 id */
const INTERNAL_MESSAGE = "内部错误，详情见 manager 日志里同 requestId 的那一行";

/**
 * 把捕获到的异常翻译成一个 HTTP 响应
 * @description
 * **唯一**的「异常 → 响应」出口，路由层不许自己写错误体。三条分支，逐条有代价：
 * 1. `OpsError` 且 `code` **在表里** → 按 `code` 查表 + **原样**透传 `message`（传输层不改写
 *    ops 的文案；那是中性事实陈述，不含栈）。
 * 2. `OpsError` 但 `code` **表外 / 缺失** → 与「非 OpsError」同一条路（500 + 固定文案 +
 *    `requestId`，细节进日志）。⚠️ **连 `message` 也不透传**：`code` 是我们对那条文案
 *    所属类别的**唯一背书**；不认识的 code 意味着我们无法背书这条 message 的类别，而把它原样
 *    回出去等于宣称「我知道这是什么」——那正是「传输层拿 code 改文案 / 猜文案」这条禁令的
 *    同一个错误的两个方向。
 * 3. 其它一切 → 500 + 固定文案 + `requestId`，真实异常（含栈）只进 logger。
 *
 * @param res - 响应对象
 * @param err - 捕获到的异常（任何类型）
 * @param requestId - 本次请求的关联 id
 * @param logger - 诊断出口（`LoggerImpl`）；**非「已背书的 OpsError」才用到它**
 * @returns 实际回出的状态码（便于调用方记日志 / 测试断言）
 * @example sendFailure(res, new OpsError("not-found", "账号表里没有 bob"), "r-1", logger) // => 404
 */
export function sendFailure(
  res: ServerResponse,
  err: unknown,
  requestId: string,
  logger: LoggerImpl,
): number {
  // `code` 在表里 = 我们**背书**这条 message 的类别；表外 / 缺失 = 不背书（见函数头第 ② 条）。
  // 判据用「查表的结果是不是一个状态码」而不是 `Object.hasOwn`：本仓 `tsconfig` 的 `lib` 是
  // ES2021，而 `Object.hasOwn` 是 ES2022 —— 为一个判据抬高全仓的 lib 目标不值当。
  const known = err instanceof OpsError ? STATUS_BY_CODE[err.code] : undefined;
  const backstop = err instanceof OpsError && typeof known === "number" ? err : undefined;
  if (backstop !== undefined) {
    const status = statusForOpsError(backstop);
    // 5xx（source-unreadable）也要关联 id：那类失败的排查入口是日志，不在响应里
    if (status >= 500) {
      logger.error(
        `[manager] requestId=${requestId} ops 失败 code=${backstop.code}: ${backstop.message}`,
      );
    }
    sendError(res, status, backstop.code, backstop.message, requestId);
    return status;
  }

  // 非「已背书的 OpsError」：栈与内部路径一律只进日志。logger.error 接受 Error（impl 会原样
  // 交给 console，保留原生堆栈可读性），JSONL 落盘那一侧会 stringify —— 两条通道都拿得到细节。
  const shape = err instanceof OpsError ? `OpsError(code=${String(err.code)} 不在映射表内)` : "非 OpsError";
  logger.error(`[manager] requestId=${requestId} 内部错误（${shape}）`, err);
  sendError(res, INTERNAL_STATUS, "internal", INTERNAL_MESSAGE, requestId);
  return INTERNAL_STATUS;
}
