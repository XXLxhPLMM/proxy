/**
 * @fileoverview 控制面客户端 —— 本包与控制面之间**唯一**的拨号点
 * @module api/client
 * @description
 * 本模块只做四件事：拼请求（`Authorization: Bearer` + JSON）、把失败分成三档（见 `./error.ts`）、把响应收窄成
 * 本包声明的形状（见 `./wire.ts`）、原样交出服务端的文案（`message` / `notice` / `effective` 一律不改写）。⚠️ 传
 * 输面**不自己决定写哪条通道**：一切都表达成 `TuiError`，由界面决定显示成 toast 还是状态栏。
 *
 * ⚠️ **每个端点一个方法**，而不是暴露一个通用 `request()`：通用入口会让「路径拼错」「用错了解码器」「给 GET
 * 发了 body」三类错误全部推迟到运行期，且**没有任何东西会红**。逐端点的方法里 `shape` 形参是必填的，于是「用错
 * 解码器」变成一次类型不匹配。
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
  readonly timeoutMs: number;
}

export interface CallOptions {
  readonly method: Method;
  readonly path: string;
  readonly body?: unknown;
}

/** ⚠️ 本目录**没有**注入点：`call` 直接取全局那个 `fetch`（故测试要么起真 `http.Server`、要么替掉全局） */
export type FetchLike = typeof globalThis.fetch;

/**
 * 把用户敲的地址收窄成可用的基址
 * @description ⚠️ **只保留 origin**：路径与查询都不该出现在基址里，且尾斜杠 / 尾路径必须拒 —— 拼出
 * `//api/status` 而服务端逐段比对路径，于是「地址填对了却连不上」变成一句毫无线索的 404。⚠️ 带 userinfo
 * （`http://u:p@host`）也拒：`fetch` 对带凭据的 URL 直接抛 `TypeError`，而那句话把**密码**印在栈里。
 *
 * @param raw - 用户输入
 * @throws {TuiError} `invalid` / `LOCAL_REQUEST`：地址形状不合法，**请求从未发出**
 * @example normalizeBaseUrl("http://127.0.0.1:3010/api") // => "http://127.0.0.1:3010"
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw TuiError.local({ message: "地址为空" });
  }
  // ⚠️ 这一条**必须在解析之前**：`new URL("http:///api").hostname === "api"`（实测）—— WHATWG 解析会把
  // 三个斜杠消解成「一个斜杠 + 主机分隔符」，于是 `http:///api` **合法地**解析成主机 `api`，
  // `url.hostname === ""` 那一支永远走不到，而用户看到的是「静默去连一台叫 `api` 的机器」
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

  public async status(): Promise<StatusBody> {
    return this.call({ method: "GET", path: "/api/status" }, SHAPES.status);
  }

  /** `GET /api/config`（**只读**：服务端刻意没有对应的写端点） */
  public async config(): Promise<ConfigBody> {
    return this.call({ method: "GET", path: "/api/config" }, SHAPES.config);
  }

  public async users(): Promise<UsersBody> {
    return this.call({ method: "GET", path: "/api/users" }, SHAPES.users);
  }

  public async user(username: string): Promise<AccountBody> {
    const body = await this.call(
      { method: "GET", path: endpointPath("/api/users/:username", username) },
      SHAPES.user,
    );
    return body.account;
  }

  public async acl(): Promise<AclBody> {
    return this.call({ method: "GET", path: "/api/acl" }, SHAPES.acl);
  }

  public async usage(): Promise<UsageBody> {
    return this.call({ method: "GET", path: "/api/usage" }, SHAPES.usage);
  }

  /** `GET /api/usage/:username`（⚠️ 返回体的 `usage` 是**一个对象**而不是数组，见 `./wire.ts`） */
  public async usageFor(username: string): Promise<UsageOneBody> {
    return this.call(
      { method: "GET", path: endpointPath("/api/usage/:username", username) },
      SHAPES.usageOne,
    );
  }

  /**
   * `POST /api/users`（成功是 **201**）
   * @description 撞名会被服务端拒成 409 `already-exists`（那是**保护**：底层 `put` 是整条替换，让「新建」
   * 静默成功等于把「我以为在新建」变成「我顺手清掉了他的配额与有效期」）。
   */
  public async createAccount(input: AccountCreateInput): Promise<ChangeBody> {
    return this.call({ method: "POST", path: "/api/users", body: input }, SHAPES.change);
  }

  /**
   * `PUT /api/users/:username`
   * @throws {TuiError} `invalid`：空 patch（理由见 `./types.ts:AccountUpdateInput`）
   */
  public async updateAccount(username: string, patch: AccountUpdateInput): Promise<ChangeBody> {
    assertNonEmptyPatch(patch);
    return this.call(
      { method: "PUT", path: endpointPath("/api/users/:username", username), body: patch },
      SHAPES.change,
    );
  }

  public async deleteAccount(username: string): Promise<ChangeBody> {
    return this.call(
      { method: "DELETE", path: endpointPath("/api/users/:username", username) },
      SHAPES.change,
    );
  }

  /** `POST /api/acl`（幂等：已经有了回 `changed: false`，那**不是**错误，见 `./types.ts:ChangeBody`） */
  public async addAclEntry(input: AclMutationInput): Promise<ChangeBody> {
    return this.call({ method: "POST", path: "/api/acl", body: input }, SHAPES.change);
  }

  /** `DELETE /api/acl`（幂等：本来就没有回 `changed: false`，那**不是**错误） */
  public async removeAclEntry(input: AclMutationInput): Promise<ChangeBody> {
    return this.call({ method: "DELETE", path: "/api/acl", body: input }, SHAPES.change);
  }

  /**
   * 发一次请求、收窄响应；失败一律抛 {@link TuiError}
   * @description ⚠️ **先读 text 再判成败**：错误体也是 JSON，`res.json()` 在 4xx 上照样能解，而按状态码
   * 分流会逼出两份解析路径。⚠️ **`DELETE` 也带 body**：服务端 `aclMutationInput` 明确收请求体，而很多 HTTP
   * 客户端会在 `DELETE` 上丢 body —— 改用查询串就得多写一条分支，而那正是「删了 A 实际删了 B」那条事故
   * 最容易长出来的地方。
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
   * @description **超时与连不上分开**：前者多半是对面在忙（重试有意义），后者多半是地址/网络错了。
   * `AbortSignal.timeout` 抛的 `TimeoutError` 是唯一可判的信号 —— 不能靠「`err.name` 里有没有 timeout
   * 字样」，那是猜。
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
      message: `连不上 ${request}：${detail}`,
      request,
      cause: err,
    });
  }
}

/**
 * `AccountUpdateInput` 至少要给一个键
 * @description 与服务端的 400 对齐，但**放在本地先判**：让一次注定被拒的请求走完整个网络往返才显示服务端
 * 那句一模一样的话，是在浪费操作者的注意力 —— 本地判的价值是**快**，不是**判得不同**。⚠️ 走
 * {@link TuiError.local} 而不是 `TuiError.wire`：这次**根本没有请求**。
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
 * @description 只对**传输层自造**的那几档做映射（它们就是 HTTP 的标准语义）；5xx 一律 `internal` ——
 * 逐个细分只会造出一张本包自己发明的、与服务端无关的分类表。
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