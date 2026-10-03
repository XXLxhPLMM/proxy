/**
 * @fileoverview 控制面客户端 —— 一个 manager 端点的全部调用面
 * @module client/client
 * @description
 * 本模块是本包与控制面之间**唯一**的出入口。它只做四件事，且每件都有明确理由：
 *
 * 1. **拼请求**（`Authorization: Bearer` + JSON）
 * 2. **把「失败」分成三档**（见 `./error.ts`：wire / transport / shape）
 * 3. **把响应收窄成本包声明的形状**（见 `./wire.ts`）
 * 4. **原样交出服务端的文案**（`message` / `notice` / `effective` 一律不改写）
 *
 * ## ⚠️ 本模块**零 console、零 process**
 * @description
 * 与 `src/manager/routes/`、`src/admin/` 同纪律：一个传输面不自己决定「写哪条通道」，那由呈现
 * 层决定。故本模块把一切都表达成 `TuiError`，由界面决定显示成 toast 还是状态栏。
 *
 * ## 为什么**每个端点一个方法**，而不是暴露一个通用 `request()`
 * @description
 * 通用 `request(method, path)` 会让「路径拼错」「用错了解码器」「给 GET 发了 body」这三类错误
 * 全部推迟到运行期，而且**没有任何东西会红**。逐端点的方法让「用错解码器」变成一次类型不匹配。
 *
 * ## ⚠️ `changed: false` **不是**错误
 * @description
 * 名单写是幂等的：加一条它已经有了的 / 移一条它本来就没有的，服务端回 **200** +
 * `changed: false`（一个字节都没动）。本模块原样返回，**绝不**把它抛成失败 —— 抛了会让界面说
 * 「操作失败」，而用户已经达到目的了；谎报「已改」同样是错的。见 `./types.ts:ChangeBody`。
 *
 * @module
 */

import { TuiError, type TuiCode } from "./error.js";
import { ENDPOINTS, endpointPath, type Method } from "./endpoints.js";
import { SHAPES, readErrorBody } from "./wire.js";
import type {
  AclBody,
  AclGroupName,
  AclListName,
  AclMutationInput,
  AccountBody,
  AccountCreateInput,
  AccountUpdateInput,
  ChangeBody,
  ConfigBody,
  StatusBody,
  UsageBody,
  UsersBody,
} from "./types.js";
import type { UsageOneBody } from "./wire.js";

/** 一个 manager 端点的连接参数（**凭据就在这里**，故本类型不许进日志 / 不许进错误文案） */
export interface ManagerEndpoint {
  /** 控制面基址，形如 `http://127.0.0.1:3010`（无尾斜杠，见 {@link normalizeBaseUrl}） */
  readonly baseUrl: string;
  /** `MANAGER_TOKEN`。⚠️ 等价于主机上的 root shell —— 泄露它等于交出这台机器 */
  readonly token: string;
  /** 单次请求超时（毫秒） */
  readonly timeoutMs: number;
}

/** 单次请求的选项 */
export interface CallOptions {
  readonly method: Method;
  readonly path: string;
  /** 请求体；给了就按 JSON 序列化（服务端对非对象体一律 400） */
  readonly body?: unknown;
}

/** `call` 拨号时用到的那个 `fetch` 的类型（⚠️ 本目录**没有**注入点：`call` 直接取全局那个，
 *  故测试要么起真 `http.Server`、要么替掉全局，两条都不是「传一个替身进来」） */
export type FetchLike = typeof globalThis.fetch;

/**
 * 把用户敲的地址收窄成可用的基址
 * @description
 * 五条拒绝各自挡掉一种**具体的**坏法：
 * - 空串 / 不是 URL：`new URL` 自己会抛，但那句话不提「要写成 http://主机:端口」
 * - 非 http/https：`file:` / `ws:` 之类会让 `fetch` 抛一句与地址无关的错
 * - 带 userinfo（`http://u:p@host`）：`fetch` 对带凭据的 URL 直接抛 `TypeError`，而那句话
 *   把**密码**印在栈里
 * - 主机名前多一个 `/`（`http:///api`）：⚠️ **必须在 `new URL` 之前按原始文本判**，
 *   WHATWG 解析会把三个斜杠消解成「一个斜杠 + 主机分隔符」，`http:///api` 于是**合法地**解析成
 *   主机 `api` —— 判 `url.hostname === ""` 那一支永远走不到，而用户看到的是「静默去连一台叫
 *   `api` 的机器」
 * - 尾斜杠 / 尾路径：`http://h:3010/` + `/api/status` 拼出 `//api/status`，而服务端逐段比对
 *   路径 —— 它会判 404，于是「地址填对了却连不上」变成一句毫无线索的 404
 *
 * @param raw - 用户输入
 * @returns 归一后的基址（**只保留 origin**：路径与查询都不该出现在基址里）
 * @throws {TuiError} `invalid` / `LOCAL_REQUEST`：地址形状不合法，**请求从未发出**
 * @example normalizeBaseUrl("http://127.0.0.1:3010/") // => "http://127.0.0.1:3010"
 * @example normalizeBaseUrl("http://127.0.0.1:3010/api") // => "http://127.0.0.1:3010"
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw TuiError.local({ message: "地址为空" });
  }
  // ⚠️ 这一条**必须在解析之前**：`new URL("http:///api").hostname === "api"`（实测）
  if (/^https?:\/{3,}/i.test(trimmed)) {
    throw TuiError.local({
      message: `地址缺主机名：${trimmed}（协议头后面要直接跟主机，别多打斜杠）`,
    });
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw TuiError.local({ message: `地址不是合法 URL：${trimmed}（要写成 http://主机:端口）` });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw TuiError.local({
      message: `只支持 http / https，收到 ${url.protocol.replace(":", "")}`,
    });
  }
  if (url.username !== "" || url.password !== "") {
    // ⚠️ 错误文案里**不重打** userinfo：那一段就是凭据
    throw TuiError.local({
      message: "地址里不许带 user:pass（控制面用 Bearer token 鉴权，不走 URL 凭据）",
    });
  }
  if (url.hostname === "") {
    throw TuiError.local({ message: `地址缺主机名：${trimmed}` });
  }
  return `${url.protocol}//${url.host}`;
}

/** 一个 manager 端点的客户端 */
export class ManagerClient {
  private readonly endpoint: ManagerEndpoint;

  public constructor(endpoint: ManagerEndpoint) {
    this.endpoint = endpoint;
  }

  /** 连接参数（**只给「我要显示哪个 manager」这类用途**，故本包不把它打进任何错误文案） */
  public get info(): ManagerEndpoint {
    return this.endpoint;
  }

  /** 端点路径（用于界面显示本包覆盖了哪些面） */
  public get knownEndpoints(): readonly { method: Method; path: string }[] {
    return ENDPOINTS;
  }

  /* ── 读面 ─────────────────────────────────────────────────────────────── */

  /** `GET /api/status` */
  public async status(): Promise<StatusBody> {
    return this.call({ method: "GET", path: "/api/status" }, SHAPES.status);
  }

  /** `GET /api/config`（**只读**：服务端刻意没有对应的写端点） */
  public async config(): Promise<ConfigBody> {
    return this.call({ method: "GET", path: "/api/config" }, SHAPES.config);
  }

  /** `GET /api/users` */
  public async users(): Promise<UsersBody> {
    return this.call({ method: "GET", path: "/api/users" }, SHAPES.users);
  }

  /** `GET /api/users/:username` */
  public async user(username: string): Promise<AccountBody> {
    const body = await this.call(
      { method: "GET", path: endpointPath("/api/users/:username", username) },
      SHAPES.user,
    );
    return body.account;
  }

  /** `GET /api/acl` */
  public async acl(): Promise<AclBody> {
    return this.call({ method: "GET", path: "/api/acl" }, SHAPES.acl);
  }

  /** `GET /api/usage` */
  public async usage(): Promise<UsageBody> {
    return this.call({ method: "GET", path: "/api/usage" }, SHAPES.usage);
  }

  /**
   * `GET /api/usage/:username`
   * @description ⚠️ 返回体的 `usage` 是**一个对象**而不是数组（服务端 `routes/usage.ts` 如此），
   * 与 `usage()` 的返回类型**不同** —— 见 `./wire.ts:usageOneShape` 的注释。
   */
  public async usageFor(username: string): Promise<UsageOneBody> {
    return this.call(
      { method: "GET", path: endpointPath("/api/usage/:username", username) },
      SHAPES.usageOne,
    );
  }

  /* ── 写面 ─────────────────────────────────────────────────────────────── */

  /**
   * `POST /api/users`（成功是 **201**）
   * @description 撞名会被服务端拒成 409 `already-exists`（那是**保护**：底层 `put` 是整条替换，
   * 让「新建」静默成功等于把「我以为在新建」变成「我顺手清掉了他的配额与有效期」）。
   */
  public async createAccount(input: AccountCreateInput): Promise<ChangeBody> {
    return this.call({ method: "POST", path: "/api/users", body: input }, SHAPES.change);
  }

  /**
   * `PUT /api/users/:username`
   * @throws {TuiError} `invalid`：**空 patch** —— 服务端 400（理由见 `./types.ts:AccountUpdateInput`）
   */
  public async updateAccount(username: string, patch: AccountUpdateInput): Promise<ChangeBody> {
    assertNonEmptyPatch(patch);
    return this.call(
      { method: "PUT", path: endpointPath("/api/users/:username", username), body: patch },
      SHAPES.change,
    );
  }

  /** `DELETE /api/users/:username` */
  public async deleteAccount(username: string): Promise<ChangeBody> {
    return this.call(
      { method: "DELETE", path: endpointPath("/api/users/:username", username) },
      SHAPES.change,
    );
  }

  /** `POST /api/acl`（幂等：已经有了回 `changed: false` 且**不是**错误） */
  public async addAclEntry(input: AclMutationInput): Promise<ChangeBody> {
    return this.call({ method: "POST", path: "/api/acl", body: input }, SHAPES.change);
  }

  /** `DELETE /api/acl`（幂等：本来就没有回 `changed: false` 且**不是**错误） */
  public async removeAclEntry(input: AclMutationInput): Promise<ChangeBody> {
    return this.call({ method: "DELETE", path: "/api/acl", body: input }, SHAPES.change);
  }

  /* ── 传输 ─────────────────────────────────────────────────────────────── */

  /**
   * 发一次请求、收窄响应；失败一律抛 {@link TuiError}
   * @description
   * ⚠️ **先读 text 再判成败**：错误体也是 JSON，`res.json()` 在 4xx 上照样能解，而按状态码分流
   * 会逼出两份解析路径。⚠️ **`DELETE` 也带 body**：服务端 `aclMutationInput` 明确收请求体
   * （并与查询串不一致时报错），而很多 HTTP 客户端会在 `DELETE` 上丢 body —— 用查询串那份通路
   * 就得在这里多写一条分支，而它正是「删了 A 实际删了 B」那条事故最容易长出来的地方。
   */
  public async call<T>(
    options: CallOptions,
    shape: (v: unknown, path: string, req: string) => T,
  ): Promise<T> {
    const { method, path, body } = options;
    const label = `${method} ${path}`;
    const { baseUrl, token, timeoutMs } = this.endpoint;

    const headers: Record<string, string> = {
      Accept: "application/json",
      // 与服务端 `http/auth.ts` 同一判据：Bearer + 至少一个空白 + 不含空白的 token
      Authorization: `Bearer ${token}`,
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, init);
    } catch (err) {
      throw this.transportFailure(err, label);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      // 读 body 失败 = 连接在中途被掐（服务端提前 destroy / 中间设备超时）
      throw this.transportFailure(err, `${label} (读响应体)`);
    }

    const parsed = tryParseJson(text);

    if (!response.ok) {
      const wire = parsed === undefined ? null : readErrorBody(parsed);
      throw TuiError.wire({
        // ⚠️ 整个 body 不是错误形状时只能给状态码一个中性说法 —— 那比编一句「服务异常」诚实
        code: wire?.code ?? statusFallbackCode(response.status),
        message:
          wire?.message ??
          `服务端回了 HTTP ${response.status}，而响应体不是它自己的错误格式（多半是地址指错了服务）`,
        status: response.status,
        requestId: wire?.requestId ?? null,
        request: label,
      });
    }

    if (parsed === undefined) {
      throw TuiError.shape({ what: `${method} ${path}`, request: label });
    }
    return shape(parsed, label, label);
  }

  /**
   * 把连接层的异常翻译成 `transport` 档
   * @description **超时与连不上分开**：前者多半是对面在忙（重试有意义），后者多半是地址/网络错了
   * （重试没意义）。`AbortSignal.timeout` 抛的 `TimeoutError` 是唯一可判的信号 —— 不能靠
   * 「`err.name` 里有没有 timeout 字样」，那是猜。
   */
  private transportFailure(err: unknown, request: string): TuiError {
    if (err instanceof Error && err.name === "TimeoutError") {
      return TuiError.transport({
        code: "timeout",
        message: `请求超时（${this.endpoint.timeoutMs}ms）：${request}`,
        request,
        cause: err,
      });
    }
    const detail = err instanceof Error ? err.message : String(err);
    return TuiError.transport({
      code: "unreachable",
      // ⚠️ 只带 `detail` 不带 baseUrl 的凭据段（baseUrl 已经过 normalizeBaseUrl，无 userinfo）
      message: `连不上 ${request}：${detail}`,
      request,
      cause: err,
    });
  }
}

/**
 * `AccountUpdateInput` 至少要给一个键
 * @description 与服务端的 400 对齐，但**放在本地先判**：让一次注定被拒的请求走完整个网络往返，
 * 才在界面上显示服务端那句「至少要给一个要改的字段」，是在浪费操作者的注意力。
 *
 * ⚠️ 走 {@link TuiError.local} 而不是 `TuiError.wire`：这次**根本没有请求**，
 * `status` 必须是 `null`（给个 `0` 是拿一个假状态码冒充「服务端回了个 0」）。
 * @throws {TuiError} `invalid` / {@link ./error.ts:LOCAL_REQUEST}：空 patch
 */
export function assertNonEmptyPatch(patch: AccountUpdateInput): void {
  if (Object.keys(patch).length === 0) {
    throw TuiError.local({ message: "至少要给一个要改的字段（空 patch 不会改任何东西）" });
  }
}

/** `JSON.parse` 但不抛（返回 `undefined` 表示「不是 JSON」） */
function tryParseJson(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 连错误体都不像时的状态码兜底
 * @description 只对**传输层自造**的那几档做映射（它们就是 HTTP 的标准语义）；5xx 一律
 * `internal` —— 逐个细分 500/501/502/503 只会造出一张本包自己发明的、与服务端无关的分类表。
 */
function statusFallbackCode(status: number): TuiCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  if (status === 405) return "method-not-allowed";
  if (status === 400) return "bad-request";
  return "internal";
}

/** 名单组名 → HTTP 面用的组名（**唯一**这一份，界面与客户端都从这里取） */
export const ACL_GROUPS: readonly AclGroupName[] = ["clientip", "target", "upstream"];

/** 名单方向（**唯一**这一份） */
export const ACL_LISTS: readonly AclListName[] = ["whitelist", "blacklist"];
