/**
 * @fileoverview 事件去重与派发：per-subscriber 状态机（全目录唯一的判定点）
 * @module utils/json-file/subscriber
 * @description
 * 「这一轮要不要报事件、报哪一条」只在这里判定一次。五个分支（节流补发 / stat 失败 /
 * 文件消失 / 未变更 / 读取完成）都只是把本轮观察结果交给 `notifyTransition`，
 * 不再各自拼 `version`、不再各自写 `state.reportedError`。
 *
 * 去重按 **onEvent 回调**隔离（`WeakMap<回调, Map<键, 状态>>`）：同一份共享缓存
 * 不会吞掉其它观察者（另一个 runtime / 另一条日志呈现链路）的事件。
 *
 * 职责：
 * - `SubscriberState` 每个订阅者每个缓存键的观察状态
 * - `transitionContext(...)` 一次调用一份的固定事件身份
 * - `notifyTransition(...)` **唯一**的「去重判定 + 派发 + 状态落账」入口
 *
 * 不负责：
 * - 不 stat、不读文件、不碰缓存条目（`probe.ts` / `read-validate.ts` / `cache.ts`）
 * - 不决定「值怎么回退」与「返回哪个 error」，那属于 `json-file.ts` 的编排
 */

import type { CacheEntry } from "./cache.js";
import type { JsonFileEvent, JsonFileEventType, JsonFileOptions } from "./types.js";

/** 订阅回调（`JsonFileOptions.onEvent` 的非空形态）：去重状态按这个函数身份隔离 */
type Subscriber = (event: JsonFileEvent) => void;

/** 某个订阅者对某个缓存键的观察状态 */
export interface SubscriberState {
  /** 已向该订阅者报过的最后一条 error 文案（recovered 后清空） */
  reportedError?: string;
  /** 已向该订阅者报过 missing（文件回来后清空） */
  missingReported: boolean;
  /** 上一轮该订阅者看到的 exists（首次为 undefined） */
  lastExists?: boolean;
}

/** 每个 onEvent 回调独立去重；共享缓存不再吞掉其它 runtime 的观察事件。 */
const subscriberStates = new WeakMap<Subscriber, Map<string, SubscriberState>>();

/**
 * 本轮判定面 → 允许触发的迁移类型。
 *
 * 各分支允许集不同，是因为它们**能知道的事实不同**：节流命中没 stat 过；
 * stat 失败时不能声称「文件消失」（否则 ACL 静默全放行）；未变更时不该无端报热加载。
 */
export type TransitionKind = "throttled" | "stat-error" | "missing" | "unchanged" | "read";

const ALLOWED_TRANSITIONS: Record<TransitionKind, ReadonlySet<JsonFileEventType>> = {
  /** 节流命中：没 stat，只补发尚未上报过的 missing / error */
  throttled: new Set<JsonFileEventType>(["missing", "error"]),
  /** stat 状态不可观测（EACCES 等）：只报 error，绝不伪装成 missing */
  "stat-error": new Set<JsonFileEventType>(["error"]),
  /** 文件消失 / 非普通文件：只报 missing */
  missing: new Set<JsonFileEventType>(["missing"]),
  /** 未变更：复用旧值，只需补 error / recovered */
  unchanged: new Set<JsonFileEventType>(["error", "recovered"]),
  /** 真读了内容：完整状态机（error / recovered / reloaded） */
  read: new Set<JsonFileEventType>(["error", "recovered", "reloaded"]),
};

/** 一次 `readJsonCached` 调用内不变的事件身份（订阅方、缓存键、配置名、绝对路径） */
export interface TransitionContext {
  onEvent: Subscriber | undefined;
  key: string;
  label: string;
  path: string;
}

/** 本轮对文件状态的观察；字段与 `CacheEntry` 的对应部分同形，可直接传条目本身 */
export type TransitionSnapshot = Pick<CacheEntry, "exists" | "mtimeMs" | "size" | "error">;

/**
 * 由一次 `readJsonCached` 调用的固定部分构造事件上下文。
 *
 * 整轮调用里订阅方、缓存键、配置名、绝对路径都不变，所以只构造一次，
 * 五个分支各传一次 `kind` 即可——这是「通知」这件事在本目录里的全部输入。
 *
 * @param opts - 本次读取选项（取 `onEvent` 与 `label`）
 * @param key - 本次读取的缓存键
 * @param filePath - 已绝对化的文件路径
 */
export function transitionContext(
  opts: JsonFileOptions<unknown>,
  key: string,
  filePath: string,
): TransitionContext {
  return { onEvent: opts.onEvent, key, label: opts.label, path: filePath };
}

/** 取该订阅者对该键的观察状态；无订阅者时返回 undefined（此时不存在任何事件） */
function subscriberState(
  onEvent: Subscriber | undefined,
  key: string,
): SubscriberState | undefined {
  if (!onEvent) {
    return undefined;
  }
  let states = subscriberStates.get(onEvent);
  if (!states) {
    states = new Map<string, SubscriberState>();
    subscriberStates.set(onEvent, states);
  }
  let state = states.get(key);
  if (!state) {
    state = { missingReported: false };
    states.set(key, state);
  }
  return state;
}

/**
 * 抛出状态迁移事件；订阅方回调抛错不得影响读取（绝不外抛契约）
 * @param onEvent - 订阅回调（可选）
 * @param event - 事件
 */
function emitEvent(onEvent: Subscriber | undefined, event: JsonFileEvent): void {
  if (onEvent === undefined) {
    return;
  }
  try {
    onEvent(event);
  } catch {
    // 订阅方故障与本模块无关：吞掉，保证读取路径绝不外抛
  }
}

/**
 * 本轮状态迁移的唯一判定点：按「变化才触发」去重后派发事件，并落账去重状态。
 *
 * 判定顺序（各判定面先用 `ALLOWED_TRANSITIONS` 裁掉不允许的迁移）：
 * 1. `missing`：本轮不存在 &&（上一份缓存说它存在 || 上一轮它存在）&& 尚未上报过
 *    → 报 missing（无版本字段：文件已不可 stat），记 `missingReported`。
 *    「存在 → 缺失」必须报，否则 ACL 静默变全放行没人知道。
 * 2. `error`：本轮带 error && 与已报文案不同 → 报 error（带版本），记 `reportedError`。
 *    坏文件持续期间不重复报。
 * 3. 本轮真读了内容且带 error：清掉 `missingReported` —— 文件确实在，
 *    「上一轮曾缺失」的观察已作废（与是否真的派发了 error 无关）。
 * 4. `recovered`：本轮无 error && 文件在 && 之前报过 error / missing
 *    → 报 recovered（带版本），清掉两个标记。
 * 5. `reloaded`：以上都不成立 && 文件在 && 本轮之前已有缓存条目 → 报 reloaded；
 *    首次读取（无 previous）静默，由启动摘要覆盖。
 *
 * 注意：`error` 一律按**真值**判定（空串等于「无错误」），与本层之外所有
 * `cached.error` / `r.error` 的用法保持同一口径。
 *
 * @param context - 本次调用的订阅方/键/配置名/绝对路径
 * @param kind - 本轮判定面
 * @param previous - 本轮开始前的缓存条目（判「曾经存在」与「首次读取」）
 * @param current - 本轮观察结果；节流命中与未变更时与 `previous` 同值
 */
export function notifyTransition(
  context: TransitionContext,
  kind: TransitionKind,
  previous: CacheEntry | undefined,
  current: TransitionSnapshot,
): void {
  const state = subscriberState(context.onEvent, context.key);
  if (!state) {
    return;
  }
  const allowed = ALLOWED_TRANSITIONS[kind];
  // 版本标识：mtime/size 是「这份内容」的版本，随事件回传供日志区分版本
  // （同版本被多进程加载 vs 文件被多次修改）；文件不存在时无版本可给。
  const version = current.exists ? { mtimeMs: current.mtimeMs, size: current.size } : undefined;
  const base = { label: context.label, path: context.path };

  if (
    allowed.has("missing") &&
    !current.exists &&
    !state.missingReported &&
    (previous?.exists === true || state.lastExists === true)
  ) {
    emitEvent(context.onEvent, { type: "missing", ...base });
    state.missingReported = true;
  }
  if (allowed.has("error") && current.error && state.reportedError !== current.error) {
    emitEvent(context.onEvent, {
      type: "error",
      ...base,
      error: current.error,
      ...(version ?? {}),
    });
    state.reportedError = current.error;
  }
  if (kind === "read" && current.error) {
    state.missingReported = false;
  }
  if (
    !current.error &&
    current.exists &&
    allowed.has("recovered") &&
    (state.reportedError !== undefined || state.missingReported)
  ) {
    emitEvent(context.onEvent, { type: "recovered", ...base, ...(version ?? {}) });
    state.reportedError = undefined;
    state.missingReported = false;
  } else if (
    !current.error &&
    current.exists &&
    allowed.has("reloaded") &&
    previous !== undefined
  ) {
    emitEvent(context.onEvent, { type: "reloaded", ...base, ...(version ?? {}) });
  }
  state.lastExists = current.exists;
}
