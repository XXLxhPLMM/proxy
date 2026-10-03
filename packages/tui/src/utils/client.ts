/**
 * @fileoverview 控制面客户端 —— 本包与控制面之间**唯一**的拨号点
 * @module utils/client
 * @description 本目录其余文件一律是零 IO 的纯变换，故替身只可能注入到这一处。
 */

import {
  ENDPOINTS,
  SHAPES,
  readErrorBody,
  type AclBody,
  type AclGroupName,
  type AclListName,
  type AclMutationInput,
  type AccountBody,
  type AccountCreateInput,
  type AccountUpdateInput,
  type ChangeBody,
  type ConfigBody,
  type Method,
  type StatusBody,
  type UsageBody,
  type UsageOneBody,
  type UsersBody,
} from "@/api/index.js";
import { TuiError, type TuiCode } from "./error.js";
import { endpointPath } from "./http.js";

/** 一个 manager 端点的连接参数（**凭据就在这里**，故本类型不许进日志 / 不许进错误文案） */
export interface ManagerEndpoint {
  /** 控制面基址（无尾斜杠，见 {@link ./http.js:normalizeBaseUrl}） */
  readonly baseUrl: string;
  /** `MANAGER_TOKEN`；⚠️ 等价于主机上的 root shell */
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

export class ManagerClient {
  private readonly endpoint: ManagerEndpoint;

  public constructor(endpoint: ManagerEndpoint) {
    this.endpoint = endpoint;
  }

  /** 连接参数（**只给「我要显示哪个 manager」这类用途**，故本包不把它打进任何错误文案） */
  public get info(): ManagerEndpoint {
    return this.endpoint;
  }

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

  /** `GET /api/usage/:username`（⚠️ 返回体的 `usage` 是**一个对象**而不是数组，见 `@/api/wire.js`） */
  public async usageFor(username: string): Promise<UsageOneBody> {
    return this.call(
      { method: "GET", path: endpointPath("/api/usage/:username", username) },
      SHAPES.usageOne,
    );
  }

  /** `POST /api/users`（成功 201）；撞名回 409 `already-exists` —— `PUT` 是整条替换，故撞名必须报错 */
  public async createAccount(input: AccountCreateInput): Promise<ChangeBody> {
    return this.call({ method: "POST", path: "/api/users", body: input }, SHAPES.change);
  }

  /**
   * `PUT /api/users/:username`
   * @throws {TuiError} `invalid`：空 patch（理由见 `@/api/types.js:AccountUpdateInput`）
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

  /** `POST /api/acl`（幂等：已经有了回 `changed: false`，那**不是**错误，见 `@/api/types.js:ChangeBody`） */
  public async addAclEntry(input: AclMutationInput): Promise<ChangeBody> {
    return this.call({ method: "POST", path: "/api/acl", body: input }, SHAPES.change);
  }

  /** `DELETE /api/acl`（幂等：本来就没有回 `changed: false`，那**不是**错误） */
  public async removeAclEntry(input: AclMutationInput): Promise<ChangeBody> {
    return this.call({ method: "DELETE", path: "/api/acl", body: input }, SHAPES.change);
  }

  /** 发一次请求、收窄响应；失败一律抛 {@link TuiError} */
  /** ⚠️ **先读 text 再判成败**（错误体也是 JSON），且 **`DELETE` 也带 body**（改用查询串就得多一条分支） */
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
        // ⚠️ body 不是错误形状时只给状态码一个中性说法，不编一句「服务异常」
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

  /** 把连接层的异常翻译成 `transport` 档 */
  /** ⚠️ 只有 `AbortSignal.timeout` 抛的 `TimeoutError` 算超时，不许靠 `err.name` 里有没有 timeout 字样 */
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

/** `AccountUpdateInput` 至少要给一个键（与服务端那道 400 对齐，本地判只为了**快**） */
/** ⚠️ 抛 {@link TuiError.local} 而不是 `TuiError.wire`：这次**根本没有请求** */
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

/** 连错误体都不像时的状态码兜底（只映射传输层自造那几档；5xx 一律 `internal`，不另发明分类表） */
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