/**
 * 三档共用的假 fetch 与入参构造。
 *
 * ⚠️ 收件门槛是「**两个以上文件真用到**」，不是「看起来通用」：只被一档用到的东西留在那一档里。
 * ⚠️ 假 fetch 走**显式的 `fetchImpl` 形参**（而不是替掉 `globalThis.fetch`）：替身只该注入到拨号那一步，
 * 而全局替换会连另外两个拨号点（控制面 + 探活）一起换掉，症状是「按次数猜的那一档整个错位」。
 *
 * @module tests/model-dialects
 */

import type { ModelApiFormat } from "@/services/config/index.js";
import type { DialectInput, FetchLike } from "@/services/model/index.js";

/** 假凭据（⚠️ 判据要靠它：请求头里有一个它、失败文案里一个都没有） */
export const API_KEY = "sk-model-dialects-canary";

/** 用户敲进对话桶的那句话（⚠️ **响应体可能回显它** —— 「不转述响应体」那一档就靠它当探针） */
export const USER_TEXT = "CANARY-USER-INPUT-看看 alice 的用量";

/** 一次被记录下来的请求（形状**逐字**取自 `RequestInit`，故断言写的就是实现发出去的东西） */
export interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** 一次被记录下来的请求 + 它答回来的那份 JSON（⚠️ 替身先记账再答，故断言跑在请求之后） */
export interface FakeFetch {
  readonly fetchImpl: FetchLike;
  readonly calls: readonly Recorded[];
  /** 最近那一次的**请求体已解析**（⚠️ 解析失败要响亮地炸，而不是悄悄给一个 `{}`） */
  lastBody(): Record<string, unknown>;
  lastHeaders(): Readonly<Record<string, string>>;
}

/**
 * 造一个假 fetch：把每次请求记下来，然后按 `reply` 给一份响应
 * @description ⚠️ `reply` 收的是**这一次请求**，所以「按 URL 分流」这种判据写不出来也测不了；
 * 每一档要断什么形状，就在自己的 `reply` 里断什么。
 */
export function fakeFetch(reply: (call: Recorded) => unknown): FakeFetch {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (input, init): Promise<Response> => {
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const payload = reply(call);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload ?? null),
    } as Response;
  };
  return {
    fetchImpl,
    calls,
    lastBody: (): Record<string, unknown> => JSON.parse(calls[calls.length - 1]!.body) as Record<string, unknown>,
    lastHeaders: (): Readonly<Record<string, string>> => calls[calls.length - 1]!.headers,
  };
}

/** 一次往返的入参（⚠️ `signal` 给一个**永不触发**的 —— 超时由调用方给，而这里要断的是形状不是时间） */
export function inputFor(api: ModelApiFormat, fetchImpl?: FetchLike): DialectInput {
  return {
    api,
    baseUrl: "https://provider.invalid/v1",
    apiKey: API_KEY,
    model: "some-model",
    messages: [
      { role: "system", content: "你是规划器" },
      { role: "user", content: USER_TEXT },
      { role: "assistant", content: "/users" },
    ],
    reasoning: "medium",
    signal: new AbortController().signal,
    fetchImpl,
  };
}