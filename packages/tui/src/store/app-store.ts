/**
 * @fileoverview 应用状态层的形状与常量（零逻辑、零 React、零终端）
 */

import type { Command } from "@/commands/index.js";
import type { LogEntry } from "@/lib/log/index.js";
import type { ModelApiFormat } from "@/services/config/index.js";

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

/** 输入历史留几条（⚠️ **提交时才入**，且最新在末尾 —— 判据是「提交过的那几行」，不是「这一会话说过的话」） */
export const INPUT_HISTORY = 10;

/** 推理强度的四档闭集（⚠️ 住本目录：它是**跨帧状态里的一格**，而 {@link Session.reasoning} 与它的缺省
 *  必须同生共死 —— 定义放在别的层时本目录就得**运行期**去拿一个值，形状层于是不再是形状层） */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

/** 四档的顺序（`/models` 弹窗里循环切档按它走） */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["off", "low", "medium", "high"];

/** 缺省档（⚠️ 缺 `medium` 而不是 `off`：一半的模型不认这个参数，而 `off` 会让「没配」看起来像一个选择） */
// ⚠️ **只有一处**：新会话的缺省、那一列的缺省与读写两面的缺省全从它取
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

/**
 * 推理强度的循环序（⚠️ **只是 {@link REASONING_EFFORTS} 的另一个名字**：两处各抄一份就各自漂）
 */
export const REASONING_CYCLE: readonly ReasoningEffort[] = REASONING_EFFORTS;

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
  /** 这一格**跑没跑完**（⚠️ 它只答那一个问句；`running` 从**入队**那一刻起置位，队列串行） */
  // ⚠️ 「跑完了你还没看」是**另一个字段**（{@link Session.seen}）—— 合成一格的话「看一眼」就把它一起清了
  readonly run: RunState;
  /** 「跑完了而你还没看」（⚠️ **纯内存，不落盘**：它是这一次的注意力，不是会话的身份） */
  readonly seen: boolean;
  readonly bucket: Bucket;
  readonly input: string;
  /** 插入符位置（**UTF-16 code unit 下标**，与 `./input-line.js` / `./editor.js` 同一套） */
  readonly cursor: number;
  /** 选区锚点（**UTF-16 code unit**）；`null` = 无选区（⚠️ 与「锚点正好在插入符上」是两件事） */
  readonly anchor: number | null;
  /** 选中的模型存储键 `"<providerId>/<modelId>"`（⚠️ **按第一个 `/` 切**）；`null` = 还没选 */
  readonly modelRef: string | null;
  /** 出网时那一档推理强度（⚠️ 缺省 {@link DEFAULT_REASONING_EFFORT}；四档的循环序是 {@link REASONING_CYCLE}） */
  readonly reasoning: ReasoningEffort;
}

/** 造一个新会话（⚠️ 每个键一个全新的对象：`setState` 靠引用变化判断） */
  // ⚠️ **新字段的缺省值只在这里给一次**（`sessionOf` 与 `restoredSessions` 都经它）：三处各写一遍的话，
  // 恢复出来的会话就与新建的那些**不是同一份形状**（症状是「重启之后绿点没了」而零报错）
export function newSession(id: string, name: string): Session {
  return {
    id,
    name,
    targetId: null,
    run: "idle",
    seen: false,
    bucket: emptyBucket(),
    input: "",
    cursor: 0,
    anchor: null,
    modelRef: null,
    reasoning: DEFAULT_REASONING_EFFORT,
  };
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

/** 提供商表单**正在编辑的那一份**（⚠️ 它是「跨帧状态的形状」而不是落盘记录，故住在本目录） */
  // ⚠️ **`apiKey` 是编辑中的草稿**：屏上读回来的那一份恒是掩码，**留空 = 不改这一项**（不是「改成空」）
export interface ProviderDraft {
  readonly baseUrl: string;
  /** 下拉那一格：三种 API 格式各认一套请求形状 */
  readonly api: ModelApiFormat;
  /** 稳定标识（⚠️ **不许含 `/`** —— 模型存储键按第一个 `/` 切） */
  readonly id: string;
  /** 显示名 */
  readonly name: string;
  readonly apiKey: string;
}

/** 模态窗口此刻是什么（`null` = 没开）⚠️ **判别联合**，不是 `boolean` 也不是一个字符串档名 */
  // ⚠️ 每种内容要的格子不同 ⇒ 合成「一个 `kind` + 全可选字段」就是那份形状的谎话
  // ⚠️ **`pending` 是「待确认删除的那一个 id」**：换行 / `Esc` / 任何非删除键都清掉它，而它**每一档
  // 清单上都有** —— 两段 `Ctrl+D` 的每一档都得有它，住在这边才只有一个持有者。
export type WindowState =
  /** 历史会话（⚠️ 没有 `at`：那一档的高亮下标住在状态层，可选项就是整份清单） */
  | { readonly kind: "sessions"; readonly pending?: string }
  /** 控制面清单（增删改查都在这个弹窗里） */
  | { readonly kind: "targets"; readonly at: number; readonly pending?: string }
  /** 账号清单 */
  | { readonly kind: "users"; readonly at: number; readonly pending?: string }
  /** 提供商清单 */
  | { readonly kind: "providers"; readonly at: number; readonly pending?: string }
  /** 编辑某个提供商的模型清单（⚠️ `busy` = 正在从 `/models` 端点拉；`filter` **只影响显示**） */
  | {
      readonly kind: "provider-models";
      readonly id: string;
      readonly at: number;
      readonly filter: string;
      readonly picked: ReadonlySet<string>;
      readonly busy: boolean;
      readonly pending?: string;
    }
  /** 选模型（按提供商分组；`pinned` 是**全局**置顶集合的快照，⚠️ 不按会话） */
  | { readonly kind: "models"; readonly at: number; readonly pinned: readonly string[]; readonly pending?: string };

/** 只改当前会话的输入行 / 插入符 / 选区锚点（键位与鼠标共用这三个写入口） */
export type InputPatch = Partial<Pick<Session, "input" | "cursor" | "anchor">>;

/** 拿**最新**状态算出来的那一改（⚠️ `anchor` 也在入参里：退格与删除要把整段选区吃掉，而那一段两端都要知道） */
export type EditActive = (
  change: (
    text: string,
    cursor: number,
    anchor: number | null,
  ) => { text: string; cursor: number; anchor: number | null },
) => void;

/** 同 {@link EditActive}，但只改插入符与锚点（`←` `→` `Home` `End`） */
  // ⚠️ **它返回两格而不是一个数**：不带 Shift 的移动要**清空选区**（`anchor` 变 `null`）
export type CaretActive = (
  pick: (text: string, cursor: number, anchor: number | null) => Pick<Session, "cursor" | "anchor">,
) => void;

/** 写死的那一改（补全已算好的结果 / `Esc` 清行 / 鼠标点输入行定位插入符 / 拖选） */
export type FillActive = (patch: InputPatch) => void;
