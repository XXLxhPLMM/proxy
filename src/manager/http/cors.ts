/**
 * @fileoverview 跨源（CORS）放行的**唯一**判据 —— 缺省一个 `Access-Control-*` 头都不发
 * @module manager/http/cors
 * @description
 * 控制面能读全量配置、增删账号与名单（≈ 主机上的 root shell），所以本模块的缺省形态是
 * **完全不发** `Access-Control-*`：那不是「还没配」，而是让**任何页面**都读不到响应。
 * 浏览器端 GUI（`file://` 打开的页面、Vite dev server、另一个子域）确实需要跨源时，由
 * `MANAGER_CORS_ORIGINS` **逐个 origin 显式**放行。
 *
 * ## 「不发」不是巧合，是构造出来的
 *
 * {@link decideCors} 在白名单为空时恒回 {@link CorsDecision} 的 `none` 档，而 `none` 档
 * 的唯一义务是**什么都不做**。于是「缺省一个 CORS 头都不发」这条性质落在**一处判据**上，
 * 不依赖调用点自觉；`server.ts` 里那条分支与普通请求走的是同一段代码。
 *
 * ## 白名单是**精确 origin 字符串**，不是域名通配
 *
 * 一个 origin 由 scheme + host + port 三段组成，**没有任何一段是大小写敏感的**（RFC 6454：
 * scheme 与 host 大小写不敏感，port 是数字），也没有路径可谈。故判据是**整串相等**，
 * 不做后缀匹配 —— 后缀匹配那个「`evil-a.com` 命中 `a.com`」的方向与「`a.com.evil.com`
 * 命中 `a.com`」的**另一个**方向都必须被排除掉，而任一方向的子串判据都挡不住另一个。
 *
 * 比较前两侧都小写化（{@link parseCorsPolicy} 与 {@link decideCors} 各做一次）：这既让
 * 大小写混写的配置项能生效（否则浏览器恒发小写 origin，而运维写了大写就得到一个**永不命中**
 * 的白名单 —— 静默失败比报错坏），也让回显给浏览器的那个值一定是浏览器自己规范化过的形态
 * （回显原始大小写会让浏览器的比对**失败**，而那正是「加了 CORS 却不生效」最难查的一种）。
 *
 * ## 预检豁免是**唯一**一条不鉴权的路径，且它不许看路由表
 *
 * 浏览器的 `OPTIONS` 预检**不带凭据**（Fetch 规范明文如此），所以要让跨源 GUI 干活，
 * `OPTIONS` 必须在鉴权之前被短路。而鉴权先于路由是本层最贵的一条不变量（`server.ts`）：
 * 未鉴权者拿不到 404 与 405 的区分，那条区分本身就是**一张端点清单**。故豁免必须窄到：
 *
 * 1. `method === "OPTIONS"` **且**带 `Access-Control-Request-Method`（真预检；随手打的
 *    `OPTIONS` 不带那个头，仍然 401）；
 * 2. `Origin` **逐字**在白名单里（未列出的 origin 连豁免都拿不到）；
 * 3. **绝不进路由表** —— 对存在的路径和不存在的路径返回**逐字节相同**的 204。
 *
 * ## 绝不发 `Access-Control-Allow-Credentials`
 *
 * 控制面用 `Authorization: Bearer`，**不用 cookie**，而 `Allow-Credentials: true` 会把本面
 * 推进「只有同源带凭据请求才被接受」的更严模式 —— 在一个不发 cookie 的服务上没有它能解决的
 * 问题，只有它能招来的问题：一旦有人日后给它加上 cookie 鉴权而忘了这个头，跨源行为会静默
 * 变化。宁可让缺它这件事在代码里显形。
 *
 * 本模块**零 console、零 `process.*`**，诊断走注入的 logger（调用方 `server.ts` 负责）。
 *
 * @module
 */

import type { IncomingHttpHeaders, ServerResponse } from "node:http";

/**
 * 预检回 `Access-Control-Allow-Methods` 的方法集合（**常量**）
 * @description ⚠️ **绝不从路由表推导**：逐路径算出「这个路径允许哪些方法」并回给一个
 * **未鉴权**的预检请求，等于当众念出那张端点清单 —— 恰好是 `server.ts` 亲手关掉的那件事。
 * 这里给的是四种动词的通用集合，它不随路径变化因而不携带任何路径信息。
 */
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

/**
 * 预检回 `Access-Control-Allow-Headers` 的头名集合（**常量**）
 * @description 只列控制面真会收到的两类非安全列表头：`Authorization`（`Authorization` 不在
 * CORS 安全列表里，故带凭据的跨源请求必然触发预检）与 `Content-Type: application/json`
 * （`application/json` 同样不在安全列表里）。同样**不从请求回显** `Access-Control-Request-Headers`
 * —— 回显一个攻击者可控的头名进允许集合没有任何用途，只有把白名单变成对方的输入。
 */
const ALLOWED_HEADERS = "Authorization, Content-Type";

/** `Access-Control-Max-Age`：预检结果可被浏览器缓存的秒数。取 10 分钟—— 够掐掉开发期
 * 「改一次 CORS 配置就要硬刷一次」的循环，又短到改配置后不至于看着旧行为怀疑人生。 */
const PREFLIGHT_MAX_AGE = "600";

/** 放行策略：白名单为空（缺省）时不发任何 CORS 头 */
export interface CorsPolicy {
  /** **精确** origin 串（已小写化）。空数组 = 缺省 = 不发任何 CORS 头。 */
  readonly allowedOrigins: readonly string[];
}

/** 缺省策略：一个 origin 都没放行。**零副作用**，不是一个「宽松的默认值」。 */
export const NO_CORS: CorsPolicy = { allowedOrigins: [] };

/**
 * 判据结果：三档互斥，`none` 是缺省
 * @description 用判别联合而不是三个布尔，是为了让 `server.ts` 那种「短路 / 写头 / 什么都不做」
 * 三种处置在类型上**穷尽**：漏一档会在编译期红，而不是运行时静默少写一个头。
 */
export type CorsDecision =
  /** 不发任何 CORS 头（无 `Origin` 头、或 origin 未被放行、或白名单为空）。**零副作用。** */
  | { readonly kind: "none" }
  /** 该 origin 被放行：响应要带 `Access-Control-Allow-Origin` + `Vary: Origin`，然后**继续**
   * 走鉴权 —— 放行的是「可读性」，不是「免鉴权」。 */
  | { readonly kind: "allowed"; readonly origin: string }
  /** 一次真预检：回 204 + 全套 `Allow-*`，**短路且不鉴权**。 */
  | { readonly kind: "preflight"; readonly origin: string };

/**
 * 把配置串解析成放行策略
 * @description 按 `,` 切、逐项去空白、丢空项、小写化、去重。⚠️ **不做语法校验** —— 那是启动期
 * `assertManagerConfig` 的判据（`src/config/schema/validate.ts`），本层不重复一份：两处各判一次
 * 就是「两个地方对不上」的原料。而本层即使收到一条非法条目也**天然fail-closed**（一个垃圾串
 * 永远匹配不上任何浏览器发来的 origin），故绕过校验也不会变成一个开着的面。
 *
 * @param raw - 配置值 `MANAGER_CORS_ORIGINS`（缺省空串）
 * @returns 放行策略；空串 ⇒ {@link NO_CORS}
 * @example parseCorsPolicy("http://127.0.0.1:5173") // => { allowedOrigins: ["http://127.0.0.1:5173"] }
 * @example parseCorsPolicy("") // => { allowedOrigins: [] }
 * @example parseCorsPolicy("HTTP://A.com:80, ,http://a.com") // => { allowedOrigins: ["http://a.com:80"] }
 */
export function parseCorsPolicy(raw: string): CorsPolicy {
  const seen = new Set<string>();
  for (const piece of raw.split(",")) {
    const origin = piece.trim().toLowerCase();
    if (origin !== "") {
      seen.add(origin);
    }
  }
  if (seen.size === 0) {
    return NO_CORS;
  }
  return { allowedOrigins: [...seen] };
}

/**
 * 这一次请求该不该带 CORS 头（判据的**唯一**入口）
 * @description 判据按「错了会怎样」排序：
 * 1. 白名单为空 ⇒ `none`。**先判这个**，于是缺省形态与本模块不存在时逐字节一致。
 * 2. 没有 `Origin` 头 ⇒ `none`（非浏览器请求不需要跨源）。
 * 3. `Origin` 不逐字在白名单里 ⇒ `none`（**不是**拒绝：普通请求照常走鉴权，只是响应不可被跨源读取）。
 * 4. 真预检（`OPTIONS` + 带 `Access-Control-Request-Method`）⇒ `preflight`。
 * 5. 其余 ⇒ `allowed`。
 *
 * ⚠️ 第 3 步的「不回错误」是刻意的：一个**未放行**的 origin 拿到的是「一个没有 ACAO 头的
 * 响应」，浏览器据此拒绝把 body 交给脚本；服务端这边它仍是一个正常的、带鉴权的请求。
 * 回 403 才是把「跨源策略」与「鉴权」这两件事混成一件。
 *
 * @param method - `req.method`
 * @param headers - `req.headers`
 * @param policy - 放行策略（缺省传 {@link NO_CORS}）
 * @returns 见 {@link CorsDecision}
 * @example decideCors("OPTIONS", { origin: "http://a.com", "access-control-request-method": "GET" }, NO_CORS).kind // => "none"
 * @example decideCors("GET", { origin: "http://a.com" }, parseCorsPolicy("http://a.com")).kind // => "allowed"
 */
export function decideCors(
  method: string | undefined,
  headers: IncomingHttpHeaders,
  policy: CorsPolicy,
): CorsDecision {
  if (policy.allowedOrigins.length === 0) {
    return { kind: "none" };
  }
  const origin = headers.origin;
  if (origin === undefined) {
    return { kind: "none" };
  }
  // 两侧都小写化：小写化 origin 不改变语义（scheme/host 大小写不敏感，port 是数字），
  // 而回显原始大小写会让浏览器的 origin 比对**失败** —— 那正是「加了 CORS 却不生效」最难查的一种。
  const normalized = origin.toLowerCase();
  if (!policy.allowedOrigins.includes(normalized)) {
    return { kind: "none" };
  }
  // `Access-Control-Request-Method` 是「真预检」的判据：浏览器发的预检**必带**它，而随手打的
  // `OPTIONS` 不带。把这一条放进豁免条件，缺省（白名单为空）之外也仍只有**浏览器**能拿到豁免。
  if (method === "OPTIONS" && headers["access-control-request-method"] !== undefined) {
    return { kind: "preflight", origin: normalized };
  }
  return { kind: "allowed", origin: normalized };
}

/**
 * 把「该跨源可读」这件事写成响应头（`allowed` 档用；`preflight` 档走 {@link sendPreflight}）
 * @description 用 `setHeader` 而不是 `writeHead`，因为 `respond.ts` 拥有那一次 `writeHead`
 * ——它要先定型 `Content-Type` / `Content-Length` / `Cache-Control` / `WWW-Authenticate`。
 * Node 的 `writeHead(status, headers)` 与此前 `setHeader` 的内容**合并**（后者被前者覆盖），
 * 故这里写的两个头会随那一次 `writeHead` 一起上网。
 *
 * 鉴权失败（401）也会带上这两个头：那让浏览器**能读到** 401 的 JSON body，GUI 因此能显示
 * 「凭据不对」而不是一句读不出正文的 CORS 错误。放行的是可读性，与鉴权正交。
 *
 * @param res - 响应对象
 * @param origin - {@link decideCors} 给出的**已小写** origin（必须是 `allowed` 档的 `origin`）
 */
export function applyCorsHeaders(res: ServerResponse, origin: string): void {
  // ⚠️ `Access-Control-Allow-Origin` 回显**逐字**那个 origin，绝不 `*`：配了凭据的浏览器
  // 请求本来就不接受 `*`，而 `*` 还会让任意网页都能读到一个**已鉴权**调用者的响应。
  res.setHeader("Access-Control-Allow-Origin", origin);
  // ⚠️ `Vary: Origin` 不是可选的礼貌：缺了它，任何共享缓存（反向代理 / CDN）会把带 ACAO 头的
  // 那份响应喂给下一个 origin —— 放行于是从「这批 origin」静默退化成「所有 origin」。
  res.setHeader("Vary", "Origin");
}

/**
 * 回一次预检：**204 + 无 body**，且**绝不进路由表**
 * @description 响应头随**同一次** `writeHead` 写出（`respond.ts` 的 `WWW-Authenticate` 同一条纪律：
 * `writeHead` 一旦调用响应头就定型，事后再 `setHeader` 不生效）。`maxAge` 参数形同虚设故不给 ——
 * 策略在模块里，不在调用点。
 *
 * ⚠️ **对存在与不存在的路径返回逐字节相同的响应**，是这个函数的**全部**安全价值所在：一旦
 * 这里按路径分叉（404 / 405 / 不同 `Allow`），一个未鉴权的调用者就又能拿回那张端点清单。
 * 故本函数**不接收**路径、不查路由表、也不区分「这个端点在不在」。
 *
 * @param res - 响应对象
 * @param origin - {@link decideCors} 给出的**已小写** origin
 */
export function sendPreflight(res: ServerResponse, origin: string): void {
  if (res.writableEnded) {
    return;
  }
  res.writeHead(204, {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
    "Vary": "Origin",
    // 204 的 body 按定义是空的；显式写 `Content-Length: 0` 会让某些 HTTP/1.1 中间件按
    // 「有实体」处理，故这里只断连接不发长度头。
  });
  res.end();
}