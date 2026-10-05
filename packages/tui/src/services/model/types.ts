/**
 * @fileoverview 模型那一侧的**契约**：一次往返的入参、两种回复形态、一个方言端口
 * @module services/model/types
 */

import type { ModelApiFormat, ReasoningEffort } from "@/services/config/index.js";

/** 一次出网的那个函数（⚠️ 替身**只可能**注入到拨号这一步，故它挂在入参上） */
export type FetchLike = typeof globalThis.fetch;

/** 模型看得见的那一格对话（⚠️ 系统提示的位置**各家不同** —— 由各方言各自归位，见 `./dispatch.js`） */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** 模型回复的两种形态（判别联合，不是「可选字段」） */
export type ModelReply =
  /** 模型直接给了答案，不调工具 */
  | { readonly kind: "text"; readonly text: string }
  /** 模型要调一条命令；⚠️ `line` **必须**逐字再过一遍 `@/commands/parse.js` */
  | { readonly kind: "command"; readonly line: string };

/** 一次模型往返的失败（⚠️ 分档与 `TuiError` 同形：**「对面没答上」与「形状不对」是两件事**） */
export class ModelError extends Error {
  public readonly code: "unreachable" | "shape";

  public constructor(code: "unreachable" | "shape", message: string) {
    super(message);
    this.name = "ModelError";
    this.code = code;
  }
}

/** 一次模型往返的入参（⚠️ **`apiKey` 就在这里**，故本类型不许进日志 / 错误文案 / 快照） */
export interface DialectInput {
  /** 用哪一种请求形状（判据是那个值：三种格式的路径、头、体与回复面全都不同） */
  readonly api: ModelApiFormat;
  /** provider 基址（⚠️ **不归一** —— 那是控制面的判据，provider 可以是任何兼容端点） */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly reasoning: ReasoningEffort;
  /** 超时**由调用方给**（`AbortSignal.timeout`）—— 本目录不读时钟 */
  readonly signal: AbortSignal;
  /** 替身注入点；不给就用全局那个真 `fetch` */
  readonly fetchImpl?: FetchLike;
}

/** 拉回来的一个模型：协议 id + 一个可改的显示名初值 */
export interface ModelListing {
  readonly modelId: string;
  /** 初值恒等于 `modelId`（用户之后能在提供商弹窗里改它，故这里只给初值） */
  readonly label: string;
}

/** 一种 API 格式的请求形状（⚠️ 三份实现各自认自己的路径、头、体与回复面，不许合并成一份） */
export interface ModelDialect {
  readonly format: ModelApiFormat;
  /** 一次模型往返：入参消息 + 推理强度，出参 {@link ModelReply} */
  ask(input: DialectInput): Promise<ModelReply>;
  /** 从该提供商的端点拉取模型清单（⚠️ 三家的清单形状也不同：字段名与前缀都不同） */
  listModels(input: DialectInput): Promise<readonly ModelListing[]>;
}