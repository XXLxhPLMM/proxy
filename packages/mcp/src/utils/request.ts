/**
 * @fileoverview 控制面 HTTP 的**唯一**拨号点 —— axios 实例、鉴权头、失败翻译
 * @module utils/request
 * @description 本包其余文件都不许自己碰 axios：`src/api/` 下的端点函数一律经 {@link createClient} 拿到的那一个客户端。
 */

import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { McpError } from "./errors.js";
import { errText } from "./json-file.js";
import { hasControlChars } from "./text.js";

/** 一条控制面连接的参数（**`key` 就是凭据**，故本类型不许进日志 / 不许进错误文案） */
export interface ManagerConnection {
  /** 基址（无尾斜杠，见 {@link normalizeBaseUrl}） */
  readonly baseUrl: string;
  /** `MANAGER_TOKEN`；⚠️ 等价于主机上的 root shell */
  readonly key: string;
  readonly timeoutMs: number;
}

/** HTTP 动词（只用控制面用到的四种；表外的动词在服务端一律 405） */
export type Method = "GET" | "POST" | "PUT" | "DELETE";

/** 端点函数的统一出参类型（各端点自己的响应体由 `@/api/types.js` 声明） */
export type Json = Record<string, unknown>;

/** 一个已建好的客户端：`api/` 下每个端点函数吃的就是它 */
export interface ManagerHttp {
  readonly connection: ManagerConnection;
  request<T = Json>(spec: RequestSpec): Promise<T>;
}

export interface RequestSpec {
  readonly method: Method;
  /** 路径；含 `:username` 段的是**模板**（代入见 `endpointPath`） */
  readonly path: string;
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | undefined>;
}

/** 缺省超时（⚠️ 控制面在本机/内网，30s 足够；再长只会让「卡住」晚三十秒才说） */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 已带 scheme 的形态（RFC 3986 §3.1：字母开头 + 字母数字 / `+` / `-` / `.`，后接 `:`）
 * @description ⚠️ **先判这个，再补 scheme**。少了它，`file:///etc/passwd` 会因为「不是 http」
 * 而被当成「没写 scheme」，拼成 `http://file:///etc/passwd` —— `new URL` 把它解析成
 * `http://file:///etc/passwd`（主机名 `file:`，路径 `///etc/passwd`）而**不报错**，
 * 于是下面那道 protocol 判据形同虚设。SSRF 洞恰好开在这里。
 */
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * 基址归一：补 `http://`（无 scheme 时）、去尾斜杠
 * @description
 * ⚠️ **只认 http / https**：其余 scheme 拒掉。控制面只提供这两种，而「把任意 scheme
 * 拼进 `new URL()` 再拨号」是这类工具最经典的一个 SSRF 洞。
 * @throws {McpError} `local`：空 / 带控制字符 / scheme 不是 http(s) / URL 非法
 */
export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (value === "") {
    throw McpError.local("地址不能为空");
  }
  // 控制字符（含换行）会让 `new URL` 之后的拨号与日志里的呈现分叉（header 注入 / 日志断行）
  if (hasControlChars(value)) {
    throw McpError.local("地址里有控制字符");
  }

  const scheme = HAS_SCHEME.exec(value)?.[0];
  if (scheme !== undefined && !/^https?:$/i.test(scheme)) {
    // ⚠️ 拒在**拼之前**：见 {@link HAS_SCHEME} 的注释，这条位置就是 SSRF 防线所在
    throw McpError.local(`地址的协议只支持 http / https，收到的是 ${scheme}`);
  }
  const withScheme = scheme === undefined ? `http://${value}` : value;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch (err) {
    throw McpError.local(`地址不是一个合法的 URL：${errText(err)}`, err);
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** 路径模板代入（⚠️ **逐段 `encodeURIComponent`** —— 用户名里有一个 `/` 就不能让它改路径结构） */
export function endpointPath(template: string, ...segments: readonly string[]): string {
  let path = template;
  for (const segment of segments) {
    path = path.replace(/:[^/]+/, encodeURIComponent(segment));
  }
  return path;
}

/** 建一个控制面客户端 */
export function createClient(connection: ManagerConnection): ManagerHttp {
  const instance: AxiosInstance = axios.create({
    baseURL: connection.baseUrl,
    timeout: connection.timeoutMs,
    // ⚠️ **状态码判定交给本层**：axios 默认只把 2xx 当成功，于是错误体要靠 catch 分支
    // 去 `err.response` 里刨 —— 那是两份读法，而「读失败响应的 body」这条路径恰恰最需要只有一份。
    validateStatus: () => true,
    // 控制面响应（配置全量、账号列表）一律不许被缓存：中间缓存拿到 `GET /api/config`
    // 的副本，等于把一份含路径与账号表的快照留在磁盘上
    headers: { Accept: "application/json", "Cache-Control": "no-store" },
  });

  return {
    connection,
    async request<T>(spec: RequestSpec): Promise<T> {
      const { method, path, body, query } = spec;
      const label = `${method} ${path}`;

      const headers: Record<string, string> = {
        // 与服务端 `src/manager/http/auth.ts` 同一判据：Bearer + 至少一个空白 + 不含空白的 key
        Authorization: `Bearer ${connection.key}`,
      };
      const config: Record<string, unknown> = { headers };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        config["data"] = body;
      }
      if (query !== undefined) {
        config["params"] = query;
      }

      let response: AxiosResponse<unknown>;
      try {
        response = await instance.request({ ...config, method, url: path });
      } catch (err) {
        throw transportFailure(err, label, connection.timeoutMs);
      }

      if (response.status < 200 || response.status >= 300) {
        throw wireFailure(label, response.status, response.data);
      }
      // ⚠️ 这一步是**信封层**的校验（顶层得是对象），而 `T` 是端点函数自己声明的形状 ——
      // 那份声明是手抄的弱耦合，深字段对不上时消费面（`src/tools/`）拿到的就是 undefined，
      // 而不是一次 TypeError。理由见 `@/api/decode.js` 的文件头。
      return expectObject(label, response.data) as T;
    },
  };
}

/** 连错误体都不像时的兜底文案（⚠️ 只给状态码一个中性说法，不编一句「服务异常」） */
function wireFailure(label: string, status: number, data: unknown): McpError {
  const wire = readErrorBody(data);
  return McpError.wire(
    wire?.message ??
      `${label} 回了 HTTP ${String(status)}，而响应体不是它自己的错误格式（多半是地址指错了服务）`,
    status,
    wire?.requestId ?? null,
  );
}

/** 传输层异常 → `transport` 档；⚠️ 判据是 axios 的 `code`，不是 `err.message` 里有没有 timeout 字样 */
function transportFailure(err: unknown, label: string, timeoutMs: number): McpError {
  const code = axiosErrCode(err);
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return McpError.transport(`${label} 超时（${String(timeoutMs)}ms）`, err);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return McpError.transport(`${label} 主机名解析不了（地址里的主机名不存在？）`, err);
  }
  if (code === "ECONNREFUSED") {
    return McpError.transport(`${label} 连不上（对面没在监听，或端口写错了）`, err);
  }
  if (code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return McpError.transport(`${label} TLS 证书验不过（自签证书不会自动放行）`, err);
  }
  return McpError.transport(`${label} 请求失败：${errText(err)}`, err);
}

function axiosErrCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** 成功响应体必须是 JSON 对象（⚠️ 服务端所有端点都回 `reply()` 的对象；数组/字符串一律是对面变了） */
function expectObject(label: string, data: unknown): Json {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw McpError.wire(`${label} 回了 2xx，但响应体不是一个 JSON 对象`, null, null);
  }
  return data as Json;
}

/** 服务端自己的错误体（`{error:{code,message,requestId}}`）；形状不对就返回 `null` 而不猜 */
function readErrorBody(data: unknown): { message: string; requestId: string | null } | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const error = (data as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string" || message === "") {
    return null;
  }
  const requestId = (error as { requestId?: unknown }).requestId;
  return { message, requestId: typeof requestId === "string" ? requestId : null };
}
