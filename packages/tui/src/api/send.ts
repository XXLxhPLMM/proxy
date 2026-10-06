/**
 * @fileoverview 端点函数**唯一**的那条出口：一次请求怎么被描述、发出去、失败怎么翻译、响应怎么收窄
 * @module api/send
 * @description 本文件是本包与控制面之间的**唯一**拨号点 —— axios 实例、凭据头、失败三档的翻译都在这里，
 * 而端点函数（`{status,config,users,acl,usage}.ts` 那十二个）只负责给 `(method, path)` 与逐字段判据。
 *
 * ⚠️ **拨号只有这一个实现，而那不是洁癖**：四条纪律一旦散到十二个函数里，就会有某一个漏掉其中一条。
 * ① 状态码判定收在这一层（`validateStatus`）—— 少了它，「读失败响应的 body」那条最需要唯一读法的路径
 * 会分叉成两条（catch 分支去 `err.response` 里刨）；② 真的吃 `HTTP_PROXY`（**刻意不写 `proxy`**）；
 * ③ 超时判据读 axios 的 `code`；④ **不重试**（写端点不幂等，重试就是重复建账号 / 重复删名单）。
 * 漏掉 ④ 的代价是往别人的生产环境里多插一个账号。
 */

import axios, { type AxiosResponse } from "axios";
import { z } from "zod";
import { TuiError, type TuiCode } from "@/lib/errors.js";
import { normalizeBaseUrl, withoutUserinfo } from "@/lib/http.js";
import { readErrorBody } from "./error.js";

/** 一条台账记录里够发一次请求的那三样（⚠️ **凭据就在这里**，故本类型不许进日志 / 不许进错误文案） */
export interface ManagerTarget {
  /** 控制面基址；⚠️ 出门前**再过一次** {@link normalizeBaseUrl}（见 {@link sendDecoded}） */
  readonly baseUrl: string;
  /** `MANAGER_TOKEN`；⚠️ 等价于主机上的 root shell */
  readonly token: string;
  readonly timeoutMs: number;
}

/** HTTP 动词（只用控制面用到的四种；表外的动词在服务端一律 405） */
export type Method = "GET" | "POST" | "PUT" | "DELETE";

/** 一次请求的规格（`@/api` 里每个端点函数发出去的那一份） */
export interface RequestSpec {
  /**
   * ⚠️ **必写在 `path` 之前** —— 仓库根那道端点契约护栏（`tests/unit/manager/tui-contract.test.ts`）
   * 正是按这一排版形状从源码文本现取 `(method, path)`，反着排它会报「少了一条端点」。
   */
  readonly method: Method;
  /** 路径；含 `:username` 段的是**模板**（代入在 `@/lib/http.js:endpointPath`） */
  readonly path: string;
  /** ⚠️ **有它才带 `Content-Type`**：无 body 的请求带了那个头会被读成空 patch 之类的怪事 */
  readonly body?: unknown;
}

/** zod 的类型名 → 本包的话（⚠️ 错误文案是给人看的，故不把 `invalid_type` 那句英文原样透出去） */
const TYPE_WORDS: Readonly<Record<string, string>> = {
  string: "字符串",
  number: "数字",
  boolean: "布尔",
  object: "对象",
  array: "数组",
};

/** 收窄器的类型：`z.infer` 从 schema 推，故**响应体的类型与它的判据不可能漂**（旧的 `types.ts` 那 221 行正是漂的产地） */
type Schema<T> = z.ZodType<T>;

/**
 * 线上给的响应体，**本包一个字都不改**
 * @description ⚠️ `z.infer` 推出来的是**可变**类型，而响应体是**对面给的快照**——改它就是改「控制面说了什么」。
 * 旧的 `types.ts` 逐字段写了 `readonly`，而那 221 行正是漂的产地；故今天由这一个映射保住同一条纪律。
 * 函数类型原样穿过（判据面不需要把它变成一个没有 `apply` 的对象）。
 */
export type Response<T> =
  T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer U)[] ? readonly Response<U>[]
  : T extends object ? { readonly [K in keyof T]: Response<T[K]> }
  : T;

/**
 * 一条 zod issue → 本包的一句话
 * @description 开头那个 `request` 标签（`GET /api/status`）是**必需**的：界面上同时可能有多个 manager
 * 在飞，而这句话会落进可滚动的结果区 —— 「哪个请求的哪一段不对」缺了前半截就没法处置。
 * ⚠️ **不转述对面给的那个值**：zod 的 `issue.message` 里带 `received number` 那半句，
 * 值的原样回显正是「文案绝不转述对面的数据」要挡的东西，故只取「期望什么」那一半。
 * @example whatOf(issue, "GET /api/status") // => "GET /api/status.process.pid（期望 字符串）"
 */
function whatOf(issue: z.core.$ZodIssue, request: string): string {
  const at = issue.path.length === 0 ? request : `${request}.${formatPath(issue.path)}`;
  if (issue.code === "invalid_type") {
    // ⚠️ `nonoptional` 是 zod 对「这个键必须存在但没给」的 `code`（`z.unknown()` 那一支）
    const expected = TYPE_WORDS[issue.expected] ?? String(issue.expected);
    return `${at}（期望 ${expected}）`;
  }
  if (issue.code === "invalid_value" && "values" in issue) {
    return `${at}（期望 ${issue.values.join(" / ")} 之一）`;
  }
  // ⚠️ 认不出的 `code` 落最后这一支：仍**不**透出 `issue.message` 的全文（它含对面那个值）
  return `${at}（形状不对）`;
}

/** issue 的路径 → `process.pid` / `usage[0].user`（⚠️ 与旧的逐字段收窄器逐字同形，故文案不断档） */
function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (out === "") out += String(segment);
    else out += `.${String(segment)}`;
  }
  return out;
}

/**
 * 把线上的 `unknown` 按一个 schema 收窄，失败翻成 `shape` 档
 * @description 判据面（`tests/wire/`）直接调它喂样本，故它是「判据」与「请求」之间的那道缝 ——
 * 端点函数里的 `sendDecoded` 走的也是它，故那两档测的是同一段代码。
 * @throws {TuiError} `shape`：`request` 恒给（界面上同时可能有多个 manager 在飞）
 * @example parseBody(statusSchema, sample, "GET /api/status")
 */
export function parseBody<T>(schema: Schema<T>, value: unknown, request: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  // ⚠️ **只报第一条**：一次失败点出 40 个键等于没点，而处置动作只需要知道「先修哪个」
  const first = parsed.error.issues[0];
  throw TuiError.shape({
    what: first === undefined ? `${request}（整个响应体）` : whatOf(first, request),
    request,
  });
}

/**
 * 发出去，然后**按同一个请求的标签**收窄
 * @description
 * ⚠️ 标签（`GET /api/users` 那种「方法 + 路径」）**从 `spec` 现算**，端点函数不许自己拼一份 ——
 * 拼一份就多第二处真相源，而它们漂了的后果是「错误文案指向一个已经不存在的请求」且**零报错**。
 * ⚠️ **基址在这里再过一次** {@link normalizeBaseUrl}，而不是让每个调用点记得调：台账文件是给人能手改的，
 * 而「地址是归过的」这句话只有一处说得出 ⇒ 漏一处就是一次把 `http://h:3010/api` 拼成 `//api/status` 的往返。
 * @example sendDecoded(target, { method: "GET", path: "/api/status" }, statusSchema)
 */
export async function sendDecoded<T>(
  target: ManagerTarget,
  spec: RequestSpec,
  schema: Schema<T>,
): Promise<T> {
  const label = `${spec.method} ${spec.path}`;
  return parseBody(schema, await send(target, spec), label);
}

/** 发一次并把成败翻成一档 `TuiError`（成则给线上的 `unknown`，**不收窄**：收窄是 {@link parseBody} 的事） */
async function send(target: ManagerTarget, spec: RequestSpec): Promise<unknown> {
  const { method, path, body } = spec;
  const label = `${method} ${path}`;
  const baseUrl = normalizeBaseUrl(target.baseUrl);

  // 与服务端 `http/auth.ts` 同一判据：Bearer + 至少一个空白 + 不含空白的 token
  const headers: Record<string, string> = { Authorization: `Bearer ${target.token}` };
  const config: Record<string, unknown> = {
    headers,
    baseURL: baseUrl,
    url: path,
    method,
    timeout: target.timeoutMs,
    // ⚠️ **状态码判定交给本层**：axios 默认只把 2xx 当成功，于是错误体要靠 catch 分支去
    // `err.response` 里刨 —— 那是两份读法，而「读失败响应的 body」这条路径恰恰最需要只有一份。
    validateStatus: () => true,
    // ⚠️ **刻意不写 `proxy`**：axios 的 Node adapter 逐请求读 `HTTP_PROXY` / `http_proxy` /
    // `HTTPS_PROXY` / `https_proxy` / `ALL_PROXY` / `all_proxy` 与 `NO_PROXY` / `no_proxy`
    // （含 `*`、CIDR、`.后缀`、`host:port` 四种条目），而控制面常在只能经公司代理抵达的内网 ——
    // 环境里配了就得真的用。牙齿：`tests/client/env-proxy.test.ts`。
    // ⚠️ **代价要说明白**：经代理时 `http://` 的控制面那条 `Authorization: Bearer` 对代理是**明文**
    // （`https://` 则在隧道里，代理只看见 `CONNECT`）。这就是「优先给 `https://` 的控制面」的理由。
  };
  // ⚠️ **有 body 才给 `Content-Type`，且逐字是 `application/json`**：axios 的默认
  // `transformRequest` 会给对象体改写成 `application/json;charset=utf-8`，
  // 而服务端与本包的判据都逐字认前者。无 body 的请求带了那个头会被读成空 patch 之类的怪事。
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    config["data"] = body;
  }

  let response: AxiosResponse<unknown>;
  try {
    response = await axios.request(config);
  } catch (err) {
    throw transportFailure(err, label, target.timeoutMs);
  }

  if (response.status < 200 || response.status >= 300) {
    throw wireFailure(label, response.status, response.data);
  }
  // ⚠️ axios 已经替我们试过 `JSON.parse`（解不出来就**原样留字符串**），
  // 故「2xx 但响应体不是 JSON 对象」这件事由端点那个 schema 判成 `shape` 档。
  return response.data;
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

/** 服务端明确答了「不」 */
function wireFailure(label: string, status: number, data: unknown): TuiError {
  const wire = readErrorBody(data);
  return TuiError.wire({
    // ⚠️ body 不是错误形状时只给状态码一个中性说法，不编一句「服务异常」
    code: wire?.code ?? statusFallbackCode(status),
    message:
      wire?.message ??
      `服务端回了 HTTP ${status}，而响应体不是它自己的错误格式（多半是地址指错了服务）`,
    status,
    requestId: wire?.requestId ?? null,
    request: label,
  });
}

/**
 * 把连接层的异常翻译成 `transport` 档
 * @description ⚠️ 判据是 **axios 的 `code`**，不是 `err.message` 里有没有 timeout 字样 ——
 * `AbortSignal` 时代那条判据是 `err.name === "TimeoutError"`，而 axios 的超时落在 `ECONNABORTED` /
 * `ETIMEDOUT` 上（前者是 axios 自己的计时器，后者是内核那一层）。
 */
function transportFailure(err: unknown, label: string, timeoutMs: number): TuiError {
  const code = axiosErrorCode(err);
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return TuiError.transport({
      code: "timeout",
      message: `请求超时（${timeoutMs}ms）：${label}`,
      request: label,
      cause: err,
    });
  }
  // ⚠️ **只取 `message`**（`err.config` 里躺着代理地址，而代理地址可能带 userinfo），
  // 且过了 {@link withoutUserinfo} —— 「文案绝不重打 userinfo」与凭据是同一条纪律
  const detail = withoutUserinfo(err instanceof Error ? err.message : String(err));
  return TuiError.transport({
    code: "unreachable",
    message: `连不上 ${label}：${detail}`,
    request: label,
    cause: err,
  });
}

/** axios 的 `code`（`AxiosError.code`；不认得就 `undefined` ⇒ 归 `unreachable` 那一档） */
function axiosErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}