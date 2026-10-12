/**
 * @fileoverview 鼠标事件中心源（模块单例）：全进程只解析一次、只合并一次，消费方都从这里取数
 * @module ink-ui/hooks/mouse/source
 * @description
 * 一条流，两个消费面，外加一对应用级开关：
 *
 * ```text
 * startMouse(write, tracking)    应用启动时调一次（组合根 starter/plugins/ui.tsx）：写开跟踪的控制码
 *   └─ started = true            此后 pushMouseSequence 才开始解析
 * pushMouseSequence(input)       唯一入口（由 use-mouse.ts 的 useMouseInput 喂 ink 递过来的输入）
 *   └─ parseMouseSequence        解不出鼠标上报就原样路过（键盘那条路不归这里管）
 *      ├─ move / drag  → paced(...)                      33ms 覆盖式合并
 *      └─ down/up/wheel → paced.flush() → deliver(...)     离散动作一条不丢，且排在挂起的移动之后
 *   └─ deliver(event)           = 刷新快照 + 通知订阅者
 * stopMouse()                    应用退出时调一次：写关跟踪的控制码、丢挂起、快照归零
 * ```
 *
 * | 消费面 | 语义 | 谁在用 |
 * |---|---|---|
 * | `subscribeMouse` | 事件：一条不丢、按序 | `useMouse`（按下 / 松开 / 拖动这类交互） |
 * | `getMouseSnapshot` | 采样：只保留最新一条 | `useMouseState`（悬停高亮、坐标读数） |
 *
 * 为什么必须是单例：ink 的 `useInput` 把每条输入**广播**给它的每个订阅者，各挂一份就等于同一段
 * 上报被解析 N 次、各自维护 N 套节流窗口 —— 同一个物理动作在不同消费者眼里会长出不同的时间线。
 * 收成一条流之后，「合并」只有一个地方发生，`down` / `up` 与移动的先后顺序也只有一个地方决定。
 *
 * ⚠️ **开关是应用级的，不跟视图挂载走**：`startMouse` / `stopMouse` 只由组合根在应用启动 / 退出时
 * 调（视图直接调就会变成「谁在开」取决于哪个组件恰好挂着）。代价是**跟踪常开**：全应用的 `useInput`
 * 处理器永远会收到鼠标上报噪声，判键前一律用 `protocol.ts` 的 `isMouseSequence` 滤掉。
 *
 * ⚠️ **快照不能拿来接 `down` / `up`**：它只保留最新一条，React 一批处理就能把「按下 + 松开」并成
 * 一次渲染，消费方永远只看得到后一个。要知道每一次离散动作，走 `subscribeMouse`。
 *
 * 纯数据层：只往调用方给的 `write` 里写控制码，自己不碰 stdout、不碰 React。
 */

import type { MouseEvent, MouseEventType } from "./protocol.js";
import type { MouseTracking } from "./tracking.js";
import { parseMouseSequence } from "./protocol.js";
import { disableMouseTracking, enableMouseTracking } from "./tracking.js";
import { throttle } from "@/ink-ui/utils/index.js";

/** 高频事件的最小投递间隔：≈ ink 默认 `maxFps: 30` 的一帧 */
const COALESCE_MS = 33;

/** 写终端控制码的通道：应用启动时由组合根给 `process.stdout.write` */
export type MouseWriter = (data: string) => void;

/** 订阅者收到的就是最终投递的事件（高频那两种已经合并过） */
export type MouseListener = (event: MouseEvent) => void;

/** 是否正在捕获：没 start 就不解析（没开跟踪本来也收不到上报） */
let started = false;

/** 开跟踪时用的写通道；`stopMouse` 要靠它把关跟踪的码写回去 */
let writer: MouseWriter | null = null;

/** 最新一次**已投递**的事件；没投递过、或已经 stop 就是 `null` */
let snapshot: MouseEvent | null = null;

/** 订阅者集合：`useMouse` 与 `useSyncExternalStore` 都挂在这里 */
const listeners = new Set<MouseListener>();

/**
 * 哪些事件算「高频」、值得合并：只有指针在动的那两种。
 * `down` / `up` / `wheel` 是离散动作，一条都不许丢（策略住在本层，`utils/` 只管机制）。
 */
function isCoalescable(type: MouseEventType): boolean {
  return type === "move" || type === "drag";
}

/** 投递：先刷新快照再通知 —— 两条消费面拿到的必须是同一份数据 */
function deliver(event: MouseEvent): void {
  snapshot = event;
  for (const listener of listeners) listener(event);
}

/**
 * 模块级节流器：**活过 render** 才是重点。放进消费组件的 `useMemo` 就会随它重渲染而重建，窗口一
 * 重置，拖动立刻退化成「每条都投」；建在这里则只有一条流、一个窗口，消费方怎么重渲染都不影响它。
 * `deliver` 也是模块级的，没有闭包过期问题。
 */
const paced = throttle<[MouseEvent]>(deliver, COALESCE_MS);

/**
 * 开始捕获（**start**）：写开跟踪的控制码，此后 `pushMouseSequence` 才开始解析。幂等。
 *
 * @param write 写控制码的通道（`process.stdout.write`，不用 ink 的 `write`：理由见 `stopMouse`）
 * @param tracking 要跟踪的档次（1002 拖拽 / 1003 悬停也报），含义见 `tracking.ts`
 */
export function startMouse(write: MouseWriter, tracking: MouseTracking): void {
  if (started) return;
  started = true;
  writer = write;
  write(enableMouseTracking(tracking));
}

/**
 * 停止捕获（**stop**）：写关跟踪的控制码、丢掉挂起的投递、快照归零。幂等，且没 start 过就什么都不做
 * （不许凭空往终端写关闭码）。
 *
 * ⚠️ **这里必须直接写 `write` 给的通道（`process.stdout`），不能换成 ink 的 `write`**：本函数在应用
 * 退出时被调，那时 ink 往往已经卸载，而 ink 的 `writeToStdout` 在 `isUnmounted` / `isSuspended` 时
 * 直接 return —— 关跟踪的码写不出去，终端就留在鼠标跟踪模式里（ink.js `writeToStdout` 开头两行）。
 * 另外 ink 的 `write` 会 clear 再重绘整屏，两串控制码不值得各触发一次全屏重绘。
 *
 * 快照归零时**不通知订阅者**：此刻组件本来就该跟着一起卸载（调用方是组合根，不是视图）。
 */
export function stopMouse(): void {
  if (!started) return;
  started = false;
  paced.cancel();
  snapshot = null;
  writer?.(disableMouseTracking());
  writer = null;
}

/**
 * 唯一入口：把 ink 递过来的一条输入喂进来，是鼠标上报就解出来往下发。
 *
 * 没 start 时连解析都不做（tracking 关着本来也收不到上报，这里只是把「没开 = 零开销」闭合）。
 */
export function pushMouseSequence(sequence: string): void {
  if (!started) return;

  const event = parseMouseSequence(sequence);
  if (!event) return;

  if (!isCoalescable(event.type)) {
    // 离散动作先补发再直通：`up` 不能抢在最后一次 `drag` 前面，否则消费方停在旧位置
    paced.flush();
    deliver(event);
    return;
  }

  paced(event);
}

/**
 * 最新一次已投递的事件。
 *
 * **引用稳定**：没有新事件时反复调用返回同一个对象（`useSyncExternalStore` 依赖这一点判定有没有变）。
 */
export function getMouseSnapshot(): MouseEvent | null {
  return snapshot;
}

/**
 * 订阅投递（高频事件已按 `COALESCE_MS` 合并）；返回退订函数。
 *
 * @param listener 收到每一次投递；`useSyncExternalStore` 传的 `onStoreChange` 也能直接当它用
 */
export function subscribeMouse(listener: MouseListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
