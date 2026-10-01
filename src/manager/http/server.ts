/**
 * @fileoverview 管理面 HTTP 服务：`node:http` + 鉴权 + 路由 + 错误翻译（**零框架依赖**）
 * @module manager/http/server
 * @description
 * 本模块是控制面的**传输层**：起一个 `http.Server`、把每个请求变成一次路由派发、把结果写成
 * JSON。它**不认识**账号 / 名单 / 账本 / 配置 —— 那些全在 `../routes/`，而数据操作全在 `@/ops`。
 * 它也不认识进程 —— 数据面归谁管由组合根回答（经 `../routes/index.ts` 的 `dataPlane` 注入进来）。
 *
 * ## 鉴权在**路由之前**，且覆盖每一个方法
 *
 * 这是本文件最重要的一条。`matchRoute` 会区分 404 / 405，而那两类信息（**这个端点存不存在**、
 * **它允许哪些方法**）本身就是侦察材料：能让未鉴权的调用者区分「路径不存在」与「方法不对」，
 * 等于免费送出一张端点清单。故 {@link authorize} 在**任何**方法上先跑一次——`OPTIONS` /
 * `HEAD` / `PATCH` / 一个不存在的动词统统 401，鉴权通过之后才有资格知道端点存不存在。
 *
 * ���时**没有任何 CORS 头**（无 `Access-Control-*`）。控制面没有跨源访问的需求，而
 * 「不发 CORS 头」在浏览器那侧的效果是**任何页面都读不到响应**——这比逐个 origin 判白名单更
 * 简单也更严。⚠️ 别把它「补全」：加一条 `Access-Control-Allow-Origin: *` 等于把「读全量配置 /
 * 增删账号与名单」开放给任何网页上的任何脚本（而 token 一旦进了 localStorage 就随 XSS 一起走）。
 *
 * ## 请求体上限是**字节数**上限，不是字段数上限
 *
 * `MAX_BODY_BYTES` 在 `data` 事件里累加，**超了立刻 `destroy()` 连接**。用 `Content-Length`
 * 判是不可信的（客户端可以不发、也可以撒谎），用「反序列化后有几个字段」判则已经晚了
 * （内存已经被吃掉了）。控制面是「能改账号与名单」的面，一个无上限的 `POST /api/users` 就是
 * 一个 OOM 制造机。
 *
 * ## 路径**不**经 `new URL()` 归一
 *
 * `new URL(req.url, base)` 会把 `/api/../../etc` 里的 `..` **解掉**——那是一次静默的路径改写：
 * 请求打的是 `/api/acl`，日志里若记的是归一后的串，两者就对不上，且「穿越」这件事被 URL
 * 解析器悄悄「处理」掉了。本模块只按**第一个 `?`** 手工切一刀，交给 {@link matchRoute} 的
 * 逐段比对（段数不等即不匹配）。查询串用 `URLSearchParams` 解析是安全的：它不参与路由。
 *
 * 本模块**零 console、零 `process.*`**：所有诊断走注入的 logger。
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authorize } from "./auth.js";
import { sendError, sendFailure, sendResult, sendUnauthorized } from "./respond.js";
import { matchRoute, type RequestContext, type Route } from "./router.js";
import type { LoggerImpl } from "@/utils/logger/index.js";

/** 请求体字节上限。`POST/PUT` 的合法载荷是「一条账号 / 一条名单条目」，64 KiB 远在其上，
 * 而它把「无上限 body」这条 OOM 路径彻底关掉。 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 记进日志的路径长度上限：请求路径是**攻击者可控**的，不截断就是一条日志放大器 */
const LOGGED_PATH_MAX = 200;

/** 请求行不是 origin-form（不以 `/` 开头）时回的固定文案 */
const BAD_REQUEST_LINE = "请求行不是 origin-form（路径必须以 / 开头）";

export interface ManagerServerOptions {
  /** 配置里的 `managerToken`。**空串时本服务一律 401**（fail-closed，见 `./auth.ts`）。 */
  readonly token: string;
  readonly routes: readonly Route[];
  readonly logger: LoggerImpl;
  /** 请求体上限（字节）。由宿主给，**不给缺省**：上限是策略决定，而「悄悄放宽到无穷」
   * 正是本文件最需要防的那件事。 */
  readonly maxBodyBytes: number;
}

/** `readBody` 的「超限」信号（**不是** `Error`：`instanceof` 在跨副本/打包后不可靠） */
const TOO_LARGE = Symbol("body-too-large");

/**
 * 读请求体，超限即**停止缓存**
 * @description
 * 逐块累加；一旦 `total > limit` 就把**缓存清空并置位**，此后进来的字节一块都不再存
 * （内存占用因此有界，与对端还在写多久无关）。不立刻 `req.destroy()`：那会在响应
 * 写出去之前就把 socket 拆掉，客户端看到的是 `socket hang up` 而不是 413 —— 而「这个请求
 * 太大了」正是它需要知道的那句话。关连接交给上层在**响应写完之后**做。
 *
 * @returns 字节缓冲；超限时 reject {@link TOO_LARGE}
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        // 清空而不是保留：已经收下的那些字节对判据没有用处，留着只是白占内存
        chunks = [];
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(TOO_LARGE);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err: Error) => {
      reject(err);
    });
    // 对端在响应之前就把连接断了：这不是「请求体非法」，是传输层失败 → 500 + 日志
    req.on("aborted", () => {
      reject(new Error("客户端在请求体读完之前断开了连接"));
    });
  });
}

/** 请求体 → `RequestContext.body`：空体给 `undefined`，有体必须能解析成 JSON */
function parseBody(raw: Buffer): unknown {
  if (raw.byteLength === 0) {
    return undefined;
  }
  // 解析失败**不**回 400 之外的任何东西，也不把 JSON.parse 的原始 message（含片段）回给调用方：
  // 那可能把请求体内容带进响应。这里抛出的 Error 会被 sendFailure 归到 500 + 日志。
  // ⚠️ 形状问题（不是 JSON、字段拼错）由**路由层**用 `OpsError("invalid")` 表达，那里有
  // 「哪个字段错了」的具体信息；而「这段字节根本不是 JSON」在本层就该死。
  return JSON.parse(raw.toString("utf8"));
}

/** 截断后的路径，仅用于日志 */
function loggablePath(path: string): string {
  return path.length > LOGGED_PATH_MAX ? `${path.slice(0, LOGGED_PATH_MAX)}…` : path;
}

/**
 * 起一个 `http.Server`（**不** listen；由宿主决定端口与时机）
 * @description
 * 返回的 server 已经在 `request` 上装好了全部逻辑，宿主只管 `listen` / `close`。这样
 * 「路由与鉴权的行为」能在端口 0 上直接测，而不必等真实端口分配。
 *
 * @param options - 见 {@link ManagerServerOptions}
 * @returns 未监听的 `http.Server`
 * @example const server = createManagerServer({ token: "t", routes, logger, maxBodyBytes: MAX_BODY_BYTES });
 */
export function createManagerServer(options: ManagerServerOptions): Server {
  const { token, routes, logger, maxBodyBytes } = options;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    void handle(req, res, requestId).catch((err: unknown) => {
      // 兜底：handle 内部已各自 catch，这一层只接「连 sendFailure 都会抛」的那种异常
      // （例如 res 已经 destroyed）。绝不让它变成 unhandledRejection。
      logger.error(`[manager] requestId=${requestId} 响应阶段异常`, err);
      res.destroy();
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";

    // ① **鉴权先行，且对每个方法都跑**（含 OPTIONS / HEAD / 未知动词）。
    //    未鉴权者拿不到 404 与 405 的区分，那条区分本身就是端点清单。
    if (!authorize(req.headers.authorization, token)) {
      logger.warn(
        `[manager] requestId=${requestId} 401 method=${method} path=${loggablePath(rawUrl)}`,
      );
      sendUnauthorized(res, requestId);
      return;
    }

    // ② 请求行必须是 origin-form
    if (!rawUrl.startsWith("/")) {
      sendError(res, 400, "bad-request", BAD_REQUEST_LINE, requestId);
      return;
    }

    // ③ 手工按第一个 `?` 切分：不经 `new URL()`（那会把 `..` 解掉 = 静默改写路径）
    const q = rawUrl.indexOf("?");
    const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
    const query = new URLSearchParams(q < 0 ? "" : rawUrl.slice(q + 1));

    // ④ 路由（404 / 405 / 400 三态在此分开）
    const matched = matchRoute(routes, method, path);
    if (matched.kind === "not-found") {
      logger.warn(
        `[manager] requestId=${requestId} 404 method=${method} path=${loggablePath(path)}`,
      );
      sendError(res, 404, "not-found", `没有这个端点：${method} ${loggablePath(path)}`, requestId);
      return;
    }
    if (matched.kind === "method-not-allowed") {
      // `Allow` 头是 405 的**契约部分**（RFC 9110 §15.5.6）：它告诉调用方该改用什么方法，
      // 而那正是「这个端点存在」这条信息——所以它只对**已鉴权**的调用方可见。
      const allow = matched.allow.join(", ");
      logger.warn(
        `[manager] requestId=${requestId} 405 method=${method} path=${loggablePath(path)} allow=${allow}`,
      );
      sendError(
        res,
        405,
        "method-not-allowed",
        `${method} 不被 ${loggablePath(path)} 接受；允许的方法：${allow}`,
        requestId,
        { Allow: allow },
      );
      return;
    }
    if (matched.kind === "malformed-path") {
      sendError(res, 400, "bad-request", "路径的百分号编码不合法", requestId);
      return;
    }

    // ⑤ 请求体：超限则**停止缓存**（内存有界），并在 413 写出**之后**关连接
    let body: unknown;
    try {
      body = parseBody(await readBody(req, maxBodyBytes));
    } catch (err) {
      if (err === TOO_LARGE) {
        logger.warn(`[manager] requestId=${requestId} 413 body 超过 ${maxBodyBytes} 字节`);
        // `Connection: close` + 写完即断：对端还在往这条 socket 写，不关掉它就是一条慢速洪泛
        res.on("finish", () => {
          req.destroy();
        });
        sendError(res, 413, "bad-request", `请求体超过 ${maxBodyBytes} 字节上限`, requestId, {
          Connection: "close",
        });
        return;
      }
      // 解析失败（含不是 JSON 的字节）：归到 500 + 日志，**不回** JSON.parse 的原始 message
      sendFailure(res, err, requestId, logger);
      return;
    }

    // ⑥ 派发。路由抛什么（`OpsError` 或别的）都由 sendFailure 翻译，本层不判。
    const ctx: RequestContext = {
      method,
      path,
      params: matched.params,
      query,
      body,
      requestId,
    };
    try {
      sendResult(res, await matched.route.handler(ctx));
    } catch (err) {
      sendFailure(res, err, requestId, logger);
    }
  }
}
