/**
 * @fileoverview 应用状态层的形状与常量（零逻辑、零 React、零终端）
 */

import type { Command } from "@/commands/index.js";
import type { LogEntry } from "@/lib/log/index.js";
import type { ProviderSettings } from "@/services/config/index.js";

/** 每个会话里保留多少条输出条目（**环形缓冲**，不是审计日志）：理由在 `@/lib/log/index.js:trim` 文件头 */
export const LOG_KEEP = 2000;

/** 滚轮 / 翻页一次滚几行（三行 ≈ 一段话，且不至于一滚就穿过整个屏幕） */
export const SCROLL_STEP = 3;

/** 输入区中间那一行给一条瞬时消息停留多久（毫秒）。⚠️ 它必须会自己消失，且**不是**历史的唯一去处 */
export const MESSAGE_TTL_MS = 8000;

/** 兜底的终端行数（`process.stdout.rows` 拿不到时） */
export const FALLBACK_ROWS = 24;

/** 一次模型往返的超时（毫秒；⚠️ **与控制面那一份分开**：模型慢，而控制面慢是另一回事，混成一个数就调不准） */
export const MODEL_TIMEOUT_MS = 20000;

/** 内存里 provider 的**中性值**（⚠️ 每格都是 `null` = 没配，而 `readProvider` 对不存在的库也给这个） */
export const EMPTY_PROVIDER: ProviderSettings = { baseUrl: null, model: null, apiKey: null };

/** 一个输出桶：条目 + 滚动位置 + 「贴不贴底」（三个字段同住一个对象：贴底判定要追加前后两个高度） */
export interface Bucket {
  readonly entries: readonly LogEntry[];
  /** 顶行号（行，0 起）。**读的时候还要再夹一次**，改窗口高度会让它越界 */
  readonly top: number;
  /** 是否贴底。`false` = 操作者往上翻过，于是新输出**不**把他拽回去 */
  readonly follow: boolean;
}

/** 空的桶（每个会话一个：共享同一个对象会让 `setState` 的引用判据失灵） */
export function emptyBucket(): Bucket {
  return { entries: [], top: 0, follow: true };
}

/** 会话名后面那一枚记号的状态（**三档各有各的字形与色档**：见 `@/theme/impl.ts:runMarkOf` 的真值表） */
export type RunState = "idle" | "running" | "done";

/** 一个会话（本包**唯一的**「上下文」单元）；⚠️ 输出桶 + 输入行 + `targetId` 同生共死（分开就造出「切到会话 2 看着会话 1 的结果」）；⚠️ 台账不在会话里（它是所有会话共享的一份） */
export interface Session {
  readonly id: string;
  readonly name: string;
  /** 这个会话连的是哪个控制面（`null` = 还没选；⚠️ **不认台账的 `selected`**，那是「上次用的」） */
  readonly targetId: string | null;
  /** 侧边栏那一枚记号的状态（`running` = 有命令在排队或正在跑，`done` = 跑完且这个会话再没有排队的东西） */
  // ⚠️ **`running` 从**入队**那一刻起就置位**（不是开跑那一刻）：队列串行，排在后面的会话也在等
  // ⚠️ `idle` 表示「没有在跑的，也没有你还没看的跑完」
  readonly run: RunState;
  readonly bucket: Bucket;
  readonly input: string;
  /** 插入符位置（**UTF-16 code unit 下标**，与 `./input-line.js` 同一套） */
  readonly cursor: number;
}

/** 造一个新会话（⚠️ 每个键一个全新的对象：`setState` 靠引用变化判断） */
export function newSession(id: string, name: string): Session {
  return { id, name, targetId: null, run: "idle", bucket: emptyBucket(), input: "", cursor: 0 };
}

/** 库里一个会话都没有时补出来的那**起步一个**（⚠️ `id` 是 `s1`，即 {@link sessionSeqOf} 空清单发回来的那个数） */
export const SEED_SESSION = { id: "s1", name: "会话 1" } as const;

/** 启动恢复：落盘那份清单 → 内存里那份（库里**一个都没有**时补出起步那一个） */
/** ⚠️ 有一个就不要造；⚠️ **补的只是内存里那一份**：一个字节都不写回去 */
export function restoredSessions(records: readonly SessionRecord[]): readonly Session[] {
  if (records.length === 0) return [newSession(SEED_SESSION.id, SEED_SESSION.name)];
  return records.map(sessionOf);
}

/** 把一条落盘的会话记录变回内存里那个会话（⚠️ 输出桶与输入行**一律从空开始** —— 它们从来没有落盘） */
export function sessionOf(record: SessionRecord): Session {
  return newSession(record.id, record.name);
}

/**
 * 库里那批会话已经把发号用到哪儿了（⚠️ **只认 `s<数字>`**：认不出来的贡献 0，缺省 1 ⇒ 起步那个是 `s1`）
 */
export function sessionSeqOf(records: readonly SessionRecord[]): number {
  return records.reduce((top, one) => {
    const at = /^s(\d+)$/.exec(one.id);
    return at === null ? top : Math.max(top, Number(at[1]));
  }, 1);
}

/** 落盘的一个会话（`@/services/config` 的 `sessions` 表就是这张形状；⚠️ **输出桶与「在不在侧边栏上」都不在里面**） */
export interface SessionRecord {
  readonly id: string;
  readonly name: string;
  /** 建成这个会话的时刻（epoch 毫秒；⚠️ **改名不动它** —— 它是「这个会话有多老」的唯一定义） */
  readonly createdAt: number;
  /** 最后一次新增或改名的时刻（epoch 毫秒）；⚠️ 激活与摘下都**不动**它 —— 那不是「这个会话动了一次」 */
  readonly updatedAt: number;
}

/** 侧边栏清单的一行（`sidebar_sessions` 表就是这张形状；在不在侧边栏上由「有没有被激活过」答） */
export interface SidebarEntry {
  readonly sessionId: string;
  /** 激活进侧边栏的时刻（epoch 毫秒；⚠️ **不动 `sessions.updated_at`** —— 「出现在侧边栏上」不是「这个会话动了一次」） */
  readonly at: number;
}

/** 一条排队中的命令（**已经解析完**，故队列里不含任何需要 `try` 的东西） */
export interface Job {
  /** 这一条属于哪个会话（⚠️ 落盘与渲染都按它，故必须在**排队那一刻**定下来） */
  readonly sessionId: string;
  readonly line: string;
  readonly command: Command;
}

/** 模态窗口当前是哪一个（`null` = 没开）。⚠️ 只有一个窗口而它是**联合**，不是 `boolean` */
// ⚠️ **两档的内容模型完全不同**（一台机器 + 连接状态 vs 一个会话 + 有没有在侧边栏上 + 分组标题），
// 故它们是两个 `kind` 而不是**同一个组件的两种配置** —— 一个窗口一次只开一种内容
export type WindowKind = "managers" | "sessions" | null;

/** 只改当前会话的输入行 / 插入符（键位与鼠标共用这三个写入口） */
export type InputPatch = Partial<Pick<Session, "input" | "cursor">>;

/** 拿**最新**状态算出来的那一改 */
export type EditActive = (
  change: (text: string, cursor: number) => { text: string; cursor: number },
) => void;

/** 同 {@link EditActive}，但只改插入符（`←` `→` `Home` `End`） */
export type CaretActive = (pick: (text: string, cursor: number) => number) => void;

/** 写死的那一改（补全已算好的结果 / `Esc` 清行 / 鼠标点输入行定位插入符） */
export type FillActive = (patch: InputPatch) => void;
