/**
 * @fileoverview webfetch 工具：抓一个 URL，把正文交回给模型
 * @module agents/tools/webfetch
 * @description 只 GET。HTML 会**转成纯文本**再给模型——原始标签对它没用，还白占一大截上下文。
 * ⚠️ 这是个内网也能打的工具（`http://127.0.0.1:xxxx`、`http://169.254.169.254/` 都照打不误）。
 *   本包不做白名单：同目录的 shell 工具已经能把任意命令跑起来，再加一道拦没有意义。
 *   真要限制，限制的是「注册它」这个决定，不是这个函数。
 */

import { defineTool, registerTool } from "./index.js";

/** 单次读取的字节上限（HTML 转文本前先按字节卡，省得下完 50MB 才想起要砍） */
const MAX_BYTES = 256 * 1024;

/** 默认与上限的单次时长（毫秒）：模型可以要更短，要更长没有 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 给站点看的身份，如实写明是什么，不装成浏览器 */
const USER_AGENT = "swain-proxy-tui (agent webfetch)";

/** 认作「能当文本读」的 Content-Type；其余（图片、压缩包、pdf…）一律拒，不给模型塞字节流 */
const TEXTUAL = /^(?:text\/|application\/(?:json|xml|javascript|xhtml\+xml)(?:\s*;|\s*$))/i;

/** 登记这条工具时的选择 */
export interface WebFetchOptions {
  /**
   * 单次抓取多久（毫秒）：模型没给 `timeoutMs` 时用它，**要更长没有**（会被夹到这个数）。省略 = 30s。
   */
  readonly timeoutMs?: number;
  /** 最多读多少字节；省略 = 256KB */
  readonly maxBytes?: number;
}

/** 模型看到的一次抓取 */
export interface WebFetchResult {
  /** HTTP 状态码（⚠️ 非 2xx 照常交回，不算失败——404 的页面正文常比报错有用） */
  readonly statusCode: number;
  /** 2xx 为 true，省得模型自己算 */
  readonly ok: boolean;
  /** 最终 URL（跟过重定向）；站点跳转了模型得知道自己在读哪一页 */
  readonly url: string;
  /** 响应的 Content-Type（原样，可能带 charset） */
  readonly contentType: string;
  /** 正文：HTML 已转纯文本，且按 {@link WebFetchOptions.maxBytes} 卡过字节 */
  readonly text: string;
}

/** 只有 http / https；`file:` `data:` 之类不接 */
function checkUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/**
 * HTML → 纯文本（很粗，只够让模型读得懂页面在讲什么）。
 * @description ⚠️ **先剥标签再解实体，顺序不能反**：反过来 `&lt;div&gt;` 会被解成 `<div>` 再当标签剥掉，
 *   于是正文里那些字面量全没了。
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** 边下边卡字节：卡满了就掐掉连接，不把剩下的下完。`TextDecoder` 带 `stream` 才不会把多字节字符切坏 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let cut = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const room = maxBytes - bytes;
      // ⚠️ 超了要**先切再解**，不能整块丢：服务端一次把 100KB 发过来时，
      //   直接 `break` 会一个字都不给，标注还写着「只读了前 N 字节」。
      if (value.byteLength <= room) {
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        continue;
      }
      text += decoder.decode(value.subarray(0, room), { stream: true });
      bytes = maxBytes;
      cut = true;
      break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  text += decoder.decode();
  return cut ? `${text}\n…（已截断，只读了前 ${maxBytes} 字节）` : text;
}

/** 抓一次并整理成 {@link WebFetchResult}；抽出成函数是为了 `execute` 保持一行 */
async function readResponse(
  url: string,
  timeout: number,
  maxBytes: number,
  abortSignal: AbortSignal | undefined,
): Promise<WebFetchResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  abortSignal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.5", "user-agent": USER_AGENT },
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!TEXTUAL.test(contentType)) {
      throw new Error(`不是文本内容（Content-Type: ${contentType || "(没给)"}），这条工具只读文本`);
    }
    const raw = await readCapped(response, maxBytes);
    const html = contentType.startsWith("text/html") || contentType.startsWith("application/xhtml");
    return {
      statusCode: response.status,
      ok: response.ok,
      url: response.url === "" ? url : response.url,
      contentType,
      text: html ? htmlToText(raw) : raw,
    };
  } catch (error) {
    // ⚠️ 超时是我们自己 abort 的，`fetch` 给的消息是 "This operation was aborted"，
    //   跟「被人中断」长得一模一样 → 换成说人话的。真的中断仍原样抛，调用方才认得出那是取消。
    if (timedOut) throw new Error(`抓取超时（${timeout}ms）：${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 把 webfetch 工具登记进注册表。
 * @param settings 登记时的选择（见 {@link WebFetchOptions}）
 * @returns 退订函数（`registerTool` 原样交回）。
 * @description ⚠️ **HTTP 层出错才算失败**：超时、中断、连不上、非文本内容。
 *   状态码 4xx / 5xx 照常 resolve，把响应正文给模型自己判断。
 */
export function registerWebFetchTool(settings: WebFetchOptions = {}): () => void {
  const cap = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = settings.maxBytes ?? MAX_BYTES;
  if (!Number.isInteger(cap) || cap < 1)
    throw new Error(`webfetch 工具的 timeoutMs 必须是 ≥1 的整数，收到 ${cap}`);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`webfetch 工具的 maxBytes 必须是 ≥1 的整数，收到 ${maxBytes}`);
  }
  return registerTool(
    "webfetch",
    defineTool((tool, z) =>
      tool({
        description: "抓一个 http/https 的 URL，拿回状态码与正文（HTML 已转成纯文本）",
        inputSchema: z.object({
          url: z
            .string()
            .refine(checkUrl, "只收 http:// 或 https:// 开头的地址")
            .describe("要抓的地址"),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`超时上限（毫秒），最大 ${cap}`),
        }),
        execute: ({ url, timeoutMs }, options) =>
          readResponse(url, Math.min(timeoutMs ?? cap, cap), maxBytes, options?.abortSignal),
      }),
    ),
  );
}
