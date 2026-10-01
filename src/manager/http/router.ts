/**
 * @fileoverview 极简路由：方法 + 路径段匹配
 * @module manager/http/router
 * @description
 * 零框架依赖（**本仓不许为一个控制面引 npm 包**），只做两件事：把「方法 + 路径」派发到
 * 一个 handler，以及在派发不成时**把 404 与 405 分开**。
 *
 * ## 为什么 404 与 405 必须分开
 *
 * 它们是两种不同的诊断：「没有这个端点」（打错路径）与「有这个端点，但不许用这个方法」
 * （用 `GET` 去调一个写端点）。合成一个 404 会让第二种情况的排查从「看方法」变成
 * 「去翻文档找这个路径到底存不存在」。`405` 同时回 `Allow` 头——那才是调用方需要的信息。
 *
 * ## 路径段匹配（而不是整串比较）
 *
 * 按 `/` 切成段、逐段比：`/api/users` 与 `/api/users/` 因此是同一个端点（尾斜杠不是另一个
 * 端点，两个入口说同一件事必然漂）。空段一律丢弃，于是 `//` 也塌成一个分隔符。
 * `:name` 是**唯一一个**参数形态，且**必须**占满一整段（`/api/users/:name` 不匹配
 * `/api/users/a/b`）——参数要拼进别的地方时，「多一段」就必须是「不匹配」，而不是「取到
 * `a/b` 再交给下游」。
 *
 * ## 路径参数必须 decode 之后再校验
 *
 * `:name` 捕获的是**原始（仍带百分号编码）**的一段，故本模块对它做 `decodeURIComponent`。
 * 这一点是安全判据的一半：`%2e%2e%2f` 与 `../` 在**路由匹配时**完全一样（都不含裸 `/`），
 * 真正的判别发生在 decode 之后。若不 decode 就交给下游，下游看到的是一个「不像路径穿越的
 * 路径穿越串」。`decodeURIComponent` 对畸形 `%` 序列抛 `URIError` —— 那种请求是
 * `malformed-path`（400），**不是** 404（把它报成 404 等于说「路径不存在」，而它确实存在，
 * 只是编码坏了）。
 *
 * 本模块**零 console、零 process**，也不认识 `node:http`（`RequestContext` 是纯数据），
 * 于是整张路由表能在不起监听端口的情况下直接测。
 *
 * @module
 */

/** 路由表的一行 */
export interface Route {
  /** HTTP 方法（`GET` / `POST` / …）。本仓**不做**方法大小写归一：Node 的 `req.method` 是
   * 大写形态（`fetch`/curl 也发大写），而把 `get` 当成另一个方法只会让「为什么 405」更难答。 */
  readonly method: string;
  /** 路径模式：`/api/users` 或 `/api/users/:username`。段以 `/` 分隔，`:name` 捕获一整段。 */
  readonly path: string;
  readonly handler: RouteHandler;
}

/** 派发到 handler 的那一份请求（**纯数据**，不含 `node:http` 任何类型） */
export interface RequestContext {
  readonly method: string;
  /** 已归一的路径（无 query、无尾斜杠、空段已折叠） */
  readonly path: string;
  /** 路径参数（已 `decodeURIComponent`；空模式无参数） */
  readonly params: Readonly<Record<string, string>>;
  /** 查询串（`?user=alice`）。**空串与「给了空值」不可区分**——`URLSearchParams` 就是这样，
   * 需要区分的判据放请求体里。 */
  readonly query: URLSearchParams;
  /** 请求体：`content-type: application/json` 时是解析结果，否则是原始 Buffer（**零拷贝**） */
  readonly body: unknown;
  /** 本次请求的关联 id（进日志与错误响应，**不含任何秘密**） */
  readonly requestId: string;
}

/**
 * handler 的返回值形状（**由 `respond.ts` 定义**，此处只做结构引用以免成环）
 * @description handler 回 `{ status, body }` 而不是裸对象：状态码必须与响应体**一起**被
 * 构造出来。裸对象 + 隐含 200 会让「这个端点该回 201 还是 200」这件事只活在注释里。
 */
export interface HandlerResult {
  readonly status: number;
  readonly body: unknown;
}

export type RouteHandler = (ctx: RequestContext) => Promise<HandlerResult> | HandlerResult;

/** 派发结果 */
export type RouteMatch =
  /** 命中 */
  | { readonly kind: "matched"; readonly route: Route; readonly params: Readonly<Record<string, string>> }
  /** 路径命中但方法不对 → 405（`allow` 逐条列出该路径允许哪些方法） */
  | { readonly kind: "method-not-allowed"; readonly allow: readonly string[] }
  /** 路径不存在 → 404 */
  | { readonly kind: "not-found" }
  /** 路径存在但百分号编码坏了 → 400（`decodeURIComponent` 抛 `URIError`） */
  | { readonly kind: "malformed-path" };

/** 路径分段：空段丢弃（尾斜杠 / `//` 因此不是另一个端点） */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * 逐段比对：长度先等，再逐段（`:name` 捕获一整段，静态段逐字相等）
 * @returns 命中时给出参数表；未命中返回 null
 */
function matchSegments(
  pattern: string,
  rawPath: string,
): Readonly<Record<string, string>> | null {
  const patternSegments = segmentsOf(pattern);
  const pathSegments = segmentsOf(rawPath);
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const p = patternSegments[i] as string;
    const v = pathSegments[i] as string;
    if (p.startsWith(":")) {
      // ⚠️ **必须 decode 之后才算数**：`%2e%2e%2f` 与 `../` 在未解码时无法区分，而下游
      // （账号名 / 名单条目）拿到的一定是解码后的值。畸形编码抛 URIError → 上层报 400。
      params[p.slice(1)] = decodeURIComponent(v);
      continue;
    }
    if (p !== v) {
      return null;
    }
  }
  return params;
}

/**
 * 把一张路由表派发到一条请求上
 * @description
 * 派发顺序是**先看方法、再看路径**：方法匹配上但路径段数不对 → 404（真的没这个端点）；
 * 路径匹配上但方法不在该路径的允许集里 → 405。**先扫全表收集 `Allow`**，所以哪怕请求的是
 * 一个尚不存在的方法（`PATCH` / `FOO`），只要路径存在就得到 405 + 完整 `Allow` 列表。
 *
 * @param routes - 路由表；**同一 (method, path) 不得出现两次**（重复会让哪一条命中取决于顺序）
 * @param method - `req.method`
 * @param path - `req.url` 里 `?` 之前的那一段（**不要**先 decode 整条路径：那样
 *   `/api/users/a%2Fb` 会在路由层就裂成两段，而它其实是一个合法的单段参数）
 * @returns 见 {@link RouteMatch}
 * @example matchRoute([{ method: "GET", path: "/api/status", handler }], "GET", "/api/status").kind // => "matched"
 */
export function matchRoute(
  routes: readonly Route[],
  method: string,
  path: string,
): RouteMatch {
  const allow: string[] = [];
  try {
    for (const route of routes) {
      const params = matchSegments(route.path, path);
      if (params === null) {
        continue;
      }
      if (route.method === method) {
        return { kind: "matched", route, params };
      }
      if (!allow.includes(route.method)) {
        allow.push(route.method);
      }
    }
  } catch (err) {
    // 唯一可能的来源是 `decodeURIComponent` 对畸形 `%` 序列抛 URIError。它**不是** 404：
    // 那个端点确实存在，只是编码坏了；报成 404 等于让调用方去查「路径写错了」这件不存在的事。
    if (err instanceof URIError) {
      return { kind: "malformed-path" };
    }
    throw err;
  }
  return allow.length > 0
    ? { kind: "method-not-allowed", allow }
    : { kind: "not-found" };
}
