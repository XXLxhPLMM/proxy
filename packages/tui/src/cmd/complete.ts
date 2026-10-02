/**
 * @fileoverview 打字的建议（**纯函数**：零 IO、零终端、零网络、零 React）
 * @module cmd/complete
 * @description
 * 输入「现在这一行 + 光标在哪」→ 「有哪些候选」「补全之后那一行长什么样」。
 * ⚠️ 本模块**不执行**任何命令，也不决定「按 Tab 就接受」—— 它给的是一份**建议**，
 * 接受与否是界面层的事。
 *
 * ## 为什么它**只改光标所在那个词**
 * @description
 * 在句子中间补全是**常态**，不是边角：`user add ali| 1g` 里的光标就在中间。补全若按
 * 「整行重建」来做，界面上看着没出错，而用户已经敲好的后半行（一个流量上限、一条 token）
 * 会在一次 Tab 之后**消失** —— 那是本工具能造成的一类最贵的数据丢失（凭据丢了要重敲，
 * 目标地址丢了要重新找）。所以 {@link complete} 的出参里，`line` 是「**前后两段原样
 * 拼接**中间那一个词」的结果，`cursor` 是那个词的末尾。
 *
 * ## 候选从哪来：**只从命令表里的**形参表**读（命令名归 {@link ./palette.ts}）
 * @description
 * 候选的来源有一处：某个形参位置上的 `choices`（`user set` 的字段名、组名 `target` 的下一段）。
 * `target del` / `target switch` 的名字由调用方当参数喂进来。
 * ⚠️ 本模块**不许自己读台账**：读文件的那一层手里有台账的内存副本，而一个自己去
 * `readLedger()` 的补全器会拿到**另一个**时刻的台账 —— 于是「切了目标之后 Tab 一下」
 * 补出来的是切换前的名字。
 *
 * ## 排序只用**候选自身**的三个判据
 * @description
 * 编辑距离 → 公共前缀长度 → 字典序。⚠️ **不许**按「哪个更常用」排：那会随实现细节
 * （哪个分支写在前面、哪个名字先被创建）漂移，而调用方拿到的顺序只需要**稳定**。
 * 命令表的顺序是给 `help` 读的，与补全无关。
 *
 * ## 切词只认**空白**，不认引号
 * @description
 * 半打一个 `"` 的那一刻正是最需要建议的时候，而把引号纳入切分就要求补全器**重写**引号
 * （补全完要不要把那对引号留着？）—— 那是「动到光标之外」的另一种形式。故：
 * 切词按空白，**插入**时才在必要时给候选加引号（见 {@link render}），两个判据各管一件事。
 *
 * @module
 */

import {
  COMMAND_PREFIX,
  findSpec,
  type CommandSpec,
  type CompletionNames,
} from "./parse.js";

/** 词的边界：任何空白（与 {@link ./parse.ts} 的分词器同一套判据） */
const WHITESPACE = /\s/;

/** 分词器当 special 的四个字符（空白 + 两种引号 + 反斜杠）—— 候选含其中任何一个就要加引号 */
const NEEDS_QUOTING = /[\s"'\\]/;

/** 补全的入参 */
export interface CompletionRequest {
  /** 整行输入（**光标之后的文本也在里面**，且必须原样保留） */
  readonly line: string;
  /** 光标位置；越界由本函数夹住（夹到 `[0, line.length]`） */
  readonly cursor: number;
  /** 台账里的 target 显示名；缺省 = 没有名字可补（**纯函数不许自己读台账**） */
  readonly targetNames?: readonly string[];
}

/** 补全的出参 */
export interface Completion {
  /** 候选（已去重、已按候选自身字典序排好） */
  readonly candidates: readonly string[];
  /**
   * 补全后那一行的全文
   * @description ⚠️ **只**换掉光标所在那个词，光标之后的每一个字节原样保留。
   * 没有候选时它就是入参那一行（逐字相同）。
   */
  readonly line: string;
  /** 补全后光标该在哪儿（= 光标词的末尾；没有候选时是入参那个位置） */
  readonly cursor: number;
}

/** 去重 + 字典序（⚠️ 不按「哪个更常用」—— 理由见文件头） */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 一个候选该**怎么写进那一行**
 * @description
 * 候选只要含**分词器当 specials 的那些字符**（空白 / `"` / `'` / `\`）就必须加引号并在引号内
 * 转义，否则补全出来的那一行读回来**不是同一个词**：
 * - 带空白的显示名（`target` 的名字可以含空格）不加引号会被切成两个参数；
 * - 带反斜杠或引号的候选不加引号会被当成**转义**，于是补全顺手改掉了操作者没改的那个词。
 *
 * 两条合起来是同一条纪律：补全不许造出一行「读回来意思变了」的话。
 */
function render(candidate: string): string {
  if (candidate !== "" && !NEEDS_QUOTING.test(candidate)) return candidate;
  return `"${candidate.replace(/(["\\])/g, "\\$1")}"`;
}

/** 光标夹进 `[0, line.length]`：非有限值也要判（`NaN` 落进 `slice` 会静默变成 0 那一侧） */
function clampCursor(value: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  if (value === Number.POSITIVE_INFINITY) return max;
  if (value === Number.NEGATIVE_INFINITY) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

/** 从 `done` 走命令表，算出「光标所在那个位置」的候选 */
function candidatesFor(done: readonly string[], names: CompletionNames): readonly string[] {
  // ⚠️ **命令名不归这一层**（归 `@/cmd/palette.js` 那块面板）：它给出的是**命令名**，而它带
  // **说明**、带高亮、能在 19 行里上下走 —— 与这里「一个词后面能接什么」不是同一个问题。
  // ⚠️ 两层都答「命令名的第一个候选」的话，「Tab 填进去的」与「面板高亮的」会有两种排序
  // （这里是字典序、那里是表的顺序），而那会在 `/c` 上直接给出两个不同的命令。
  const head = done[0] === undefined ? undefined : findSpec(done[0] as string);
  // 命令名不认识：那一行已经错了，不提任何候选（提了等于让人在一行错话上继续敲）
  if (head === undefined) return [];
  let spec: CommandSpec = head;
  let consumed = 1;
  // 组：`user` / `target` 之后吃下一段
  while (spec.subs.length > 0 && consumed < done.length) {
    const child = findSpec(`${spec.name} ${done[consumed] as string}`);
    if (child === undefined) return [];
    spec = child;
    consumed += 1;
  }
  // 光标正落在组的那一段上
  if (spec.subs.length > 0) return spec.subs;
  // 否则是某个形参的位置。⚠️ 判据是**查那一格有没有形参**，不是「`done` 是不是比命令名长」：
  // `user set bob ` 里的 `bob` 是形参（用户名），不是「多出来的词」——
  // 按长度判的话这一格永远拿不到候选（字段名也就永远出不来）。
  const arg = spec.args[done.length - consumed];
  return arg === undefined ? [] : (arg.choices?.(names) ?? []);
}

/**
 * 给「当前这一行 + 光标位置」一份补全建议
 * @description
 * ⚠️ **整行必须以 {@link COMMAND_PREFIX} 开头，否则一个候选都不给** —— 这不是「少给一点」，
 * 是本层对「什么是命令」的回答与 {@link ./parse.ts:parseLine} 逐字一致：不带 `/` 的行根本不是
 * 一条命令的候选（`st`、`3`、`abc` 全都是），给它候选只会在一个**注定要失败**的行上继续诱导。
 * ⚠️ 顺带治掉一个更脏的退化：判据放在这里之前，**空输入行**会拿到「按前缀为空 = 全部候选」，
 * 于是空行上凭空浮出一个补全提示与一截幽灵文本（`status` 是其中字典序第一个）。
 *
 * 判定「光标在哪个词」的规则（**只在词的边界上补全**）：
 * - 光标左边那一段里**最后一个非空白串**就是光标词的前缀（所以「光标在词的中间」=
 *   补全**这个**词）；
 * - 光标紧跟在空白上时前缀是空串，于是**下一个**词的全量候选都出来；
 * - ⚠️ 光标落在某个词的**第一个字符**上时，那个词**就是**光标词（与 shell 的
 *   `complete-word` 一致），候选会替换掉它的全部内容。
 *
 * ⚠️ 没有候选时**原样**返回入参那一行：一次「按了 Tab 什么都没变」必须是可观察的
 * 「没有候选」，而不能是一次静默的行改写。
 *
 * ⚠️ {@link COMMAND_PREFIX} **不进词**：候选在去掉前缀的那一段上算，而 {@link Completion} 的
 * `line` / `cursor` / `start` 全部是**带前缀**那个坐标系里的位置 —— 少加那一位的话
 * `/user set bob ` 补出来的字段名会插到 `/` 前面去。
 *
 * @param request - 入参（见 {@link CompletionRequest}）
 * @returns 候选 + 补全后那一行与光标位置（见 {@link Completion}）
 */
export function complete(request: CompletionRequest): Completion {
  const line = request.line;
  const cursor = clampCursor(request.cursor, line.length);
  const lead = COMMAND_PREFIX.length;
  // ⚠️ 判据是「整行**开头**有前缀」而不是「光标左边有」：光标落在 `/` 之前时本行还没成型，
  // 而补全一个还没成型的行会在按 Tab 的那一刻把它往前改。
  if (!line.startsWith(COMMAND_PREFIX) || cursor < lead) {
    return { candidates: [], line, cursor };
  }
  const before = line.slice(lead, cursor);
  const segments = before.split(WHITESPACE);
  // 最后一段是「光标正在敲的那个词」的前缀；它之前那些段是**已经敲完的词**
  const partial = segments[segments.length - 1] as string;
  const done = segments.slice(0, -1).filter((one) => one !== "");
  const names: CompletionNames = { targetNames: request.targetNames ?? [] };

  const candidates = sortedUnique(
    candidatesFor(done, names).filter((one) => one.startsWith(partial)),
  );
  if (candidates.length === 0) return { candidates, line, cursor };

  const start = cursor - partial.length;
  // 光标词的末尾：光标紧跟空白、且下一格就是非空白时（`user |add`）那个词算光标词；
  // 光标落在空白上（`user | add`）时它是一个**空词**，不能吃掉后面那个已经敲好的词
  let end = cursor;
  if (partial !== "" || !WHITESPACE.test(line[start] ?? "")) {
    while (end < line.length && !WHITESPACE.test(line[end] as string)) end += 1;
  }

  // `line` / `cursor` 是**字典序第一个**候选的那一份结果：调用方要么接受它、要么改用
  // `candidates` 里的别的（那由界面层决定）。⚠️ 之所以在这里替调用方挑第一个而不是让它自己挑，
  // 是因为「第一个」得由同一套排序说了算 —— 两处各挑一个就会出现「列表第一项」与「Tab 填进去的」
  // 说的不是同一个词。
  const chosen = render(candidates[0] as string);
  return {
    candidates,
    line: line.slice(0, start) + chosen + line.slice(end),
    cursor: start + chosen.length,
  };
}
