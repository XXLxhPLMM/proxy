/**
 * @fileoverview 一行文本 → 一条命令（**纯逻辑**：零 IO、零终端、零网络、零 React）
 * @module cmd/parse
 * @description
 * 本模块只回答两个问题：「用户敲的这些字是**哪条命令**」与「**参数齐不齐、对不对**」。怎么执行
 * （发请求、读台账、清屏）是别人的事：执行层只拿到 {@link Command} 那个判别联合，于是
 * 「命令表里的一行」与「执行层的一个分支」在**类型上**不可能各说各话。
 *
 * ## 命令表是**唯一**一份，解析 / `help` / 补全三处共读它
 * @description
 * 一条命令的名字、用法串、说明、形参表全部住在 {@link defineCommand} 的那些声明里。
 * 抄第二份表（哪怕只抄一份「哪些命令有两级」）的后果不是「多一处要同步」——
 * 是**类型上察觉不到**的那种同步：补全列表在表格改了之后静默地少一项，而
 * {@link ./complete.ts} 那侧一切正常、`pnpm test` 全绿。
 *
 * ## ⚠️ 每一行命令都以 {@link COMMAND_PREFIX} 开头，而它是**整行**的形状
 * @description
 * `/status` 是一条命令，`status` 不是 —— 而这条判据住在**本层**（{@link parseLine}），不是界面层：
 * 命令名既出现在解析里、也出现在 `help` 的呈现里、也出现在错误文案与补全里，四处都写一遍「加个斜杠」
 * 就是四处会漂。本层因此给命令规格多一个字段 {@link CommandSpec.path}（= `/` + 名字，**算出来的**，
 * 不是抄的），呈现侧只许读它。
 *
 * ## 结果是**判别联合**，不是「一个对象加一个可选的 error」
 * @description
 * `switch (result.kind)` 必须穷举，而 `if (result.error)` 会让「忘了判错误」编译通过、
 * 运行时把一条 `ok` 当成空操作。故 {@link ParseResult} 的每个分支**只带自己用得到的字段**：
 * `unknown-command` 带建议，`bad-value` 带第几个形参，其余一律不带。
 *
 * ## ⚠️ 任何失败分支的文案都**不回显用户输入**
 * @description
 * 本包处理的两样东西是凭据：`user pass` 的新密码与 `target add` 的 token。操作者很容易
 * 把它们敲错一个字符，而「你输入错了：x#\$k2」这句话会**原样**把凭据抄进结果区（可滚动、
 * 可能被选中复制、可能被重定向进文件）。⚠️ 于是本模块的纪律是：
 * **失败分支的文案只许引用闭合集**（命令名、形参名、合法单位、合法字段名、合法值写法）
 * 与**位置**（第几个形参），**一个字节的用户输入都不许进去**。故这里没有
 * 「你输入的 `${raw}` 不合法」那种写法，也没有 `unknown-command` 把敲错的原文复述一遍 ——
 * 调用方手里有输入行，复述它没有任何信息增量。
 * （同源纪律：`LedgerError` / `TuiError` 的文案里本来就没有 token 的内容。）
 *
 * ## ⚠️ `0` 与「没给」是**同一件事**（`quotaBytes`）
 * @description
 * 服务端语义是「配额字节数 `0` = 不限量」，所以 `user add alice` 与 `user add alice 0`
 * **完全等价**，本模块把缺省直接归一成 `0`。⚠️ 这一点必须写在这里：下一个人看到
 * 「缺省值是 0」会以为那是「零字节」，于是去查为什么账号刚建好就立刻满了。
 *
 * ## 层边界：判据住在**它自己那层**，本层只判形状
 * @description
 * - 用户名 / 显示名的字符集与长度判据是 `@/ledger` 的（`validateTargetInput`）。
 * - 基址的形状是 `@/client` 的（`normalizeBaseUrl`）。
 * - 超时的区间是 `@/ledger` 的（`TIMEOUT_BOUNDS`），故本层**只**判「是不是一个能当毫秒数的
 *   非负安全整数」，把区间留给落盘那一层 —— 区间判据在这里抄第二份就是一处会漂的约束。
 * - `user set` 的值是**逐字**的（不 trim、不改大小写），因为 `user pass bob ""` 意为
 *   「把密码设成空串」，而首尾空白是密码与 token 的**值**而不是手滑。
 *   ⚠️ 名字类形参（用户名 / 名字 / 键名）反过来**要** trim：那里的首尾空白永远是手滑。
 *
 * ## 本模块不许 import 同目录以外的任何东西
 * @description
 * 它是一台没有终端的机器上就能单测通过的那一层：所以零 `ink`、零 React、零 `@/ui`、
 * 零 HTTP、零 `fs`、零 `process.*`、零 `console`。代价是上面那几处判据**不**在本层
 * （见「层边界」），收益是命令层的每一条判据都能被逐字断言。
 *
 * @module
 */

/* ── 行的形状 ───────────────────────────────────────────────────────────── */

/**
 * 词的边界：任何空白。⚠️ 用**字符类**而不是 `" "` —— 制表符也是词边界 */
const WHITESPACE = /\s/;

/**
 * 命令行的前缀：**每一条命令都必须以它开头**（{@link parseLine} 是唯一的判据处）
 * @description
 * ⚠️ **它不属于任何一个词**：它是**整行**的形状，且它**不进分词器** —— 一个不带 `/` 的词
 * 在本层没有意义（`status` 不是一条命令，`/status` 才是）。故 {@link tokenize} 拿到的是
 * **去掉 `/` 之后**的那一段，而 {@link COMMAND_PREFIX} 只被「这一行是不是命令」与
 * 「命令名写成什么样给人看」两件事读。
 *
 * ⚠️ **不许「宽容地」接受不带 `/` 的写法**：那会让「必须以 `/` 开头」变成一句没有牙齿的话 ——
 * 两条写法都能跑，操作者记不住哪条是本工具的形状，而下一版删掉宽容分支时他的脚本全断。
 * 故 {@link ParseResult} 有一个**专门的**失败档（`missing-prefix`），它带最接近的几条命令。
 */
export const COMMAND_PREFIX = "/";

/**
 * 分词失败的两档
 * @description
 * - `unterminated-quote` — 有一对引号只开不闭。
 * - `unterminated-escape` — 行尾有一个**没有后继字符**的反斜杠。
 */
export type TokenizeReason = "unterminated-quote" | "unterminated-escape";

/** {@link tokenize} 的结果（判别联合，不是「数组 + 可选 error」） */
export type TokenizeResult =
  | { readonly ok: true; readonly tokens: readonly string[] }
  | { readonly ok: false; readonly reason: TokenizeReason };

/**
 * 把一行文本切成词
 * @description
 * 规则四条：
 * 1. 空白分隔；`"` 与 `'` 都成对，**引号内的空白是词的一部分**（token 里有空格是常事，
 *    而「一个词」的唯一判据必须是「用户怎么读它」而不是「有没有空格」）。
 * 2. ⚠️ **空的引号是一个空词**（`""` → 一个长度为 0 的词）：`user pass alice ""` 意为
 *    「把密码设成空串」，而它与「没给这个参数」在服务端是**两件不同的事**
 *    （前者 200、一个空密码账号；后者 400）。两者要是被同一个「空 = 不给」抹平，
 *    「清空一个密码」就变成了「这条命令少一个参数」。
 * 3. ⚠️ **反斜杠在引号内外一致**地转义下一个字符：不写成「引号内不转义」的话
 *    `user pass bob "a\"b"` 与 `user pass bob 'a\b'` 会给出两套规则，而用户记不住
 *    哪一套配哪种引号。
 * 4. ⚠️ **未闭合的引号是失败，不是「把后半行都吞掉」**：吞掉的后果是
 *    `user add alice "1g` 变成一次 `user add alice`（建出一个**不限量**的账号），
 *    而操作者看到的是「命令执行过了」——那是一次静默的错误副作用。
 *
 * @param line - 整行输入（**不** trim：由分词器自己把首尾空白当分隔）
 * @returns 成功时给词数组（可能为空数组 = 全是空白）；失败时给一档原因
 */
export function tokenize(line: string): TokenizeResult {
  const tokens: string[] = [];
  /** 当前正在攒的那个词（可能已攒了内容，也可能只有一个开引号） */
  let current = "";
  /** 这个词**已开始**了吗 —— 与「内容为空」区分开，正是空引号那条规则的实现处 */
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (ch === "\\") {
      const next = line[i + 1];
      if (next === undefined) return { ok: false, reason: "unterminated-escape" };
      current += next;
      started = true;
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (WHITESPACE.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) return { ok: false, reason: "unterminated-quote" };
  if (started) tokens.push(current);
  return { ok: true, tokens };
}

/* ── 判据（读一个形参的原始文本 → 规范化后的值）────────────────────────────── */

/**
 * 形参值不合法（模块私有）
 * @description
 * `argIndex` 允许为 `null`：读**单个**形参的 `read` 不知道自己在第几位（它只拿到那一个
 * 字符串），由包装它的那一层补上；而 {@link defineCommand} 的 `build` 是知道下标的，
 * 所以它自己抛的时候把下标填进去。⚠️ 这个类只在本文件里 `catch` —— 别的层看到它
 * 就说明这里有 bug，那应该炸出来而不是被当成一次输入错误。
 */
class ValueError extends Error {
  /** 第几个形参（1 起）；`null` = 「由包装层补」 */
  public readonly argIndex: number | null;

  public constructor(argIndex: number | null, message: string) {
    super(message);
    this.name = "ValueError";
    this.argIndex = argIndex;
  }
}

/** 服务端语义：「配额 `0` 字节」= 不限量 */
export const UNLIMITED_BYTES = 0;

/** `∞` 的**唯一**写法（与 `@/ui/format.ts:UNLIMITED` 同一档意思） */
const INFINITY = "∞";

/** 不限量的各种写法（**小写后**比；空串也在里面 —— 「留空」是最省事的那种写法） */
const UNLIMITED_SPELLINGS: ReadonlySet<string> = new Set([
  "",
  INFINITY,
  "inf",
  "unlimited",
  "none",
]);

/**
 * 单位后缀 → 乘数（1024 进制；键一律小写）
 * @description
 * ⚠️ 带 B 与不带 B 各留一个键（`k` 与 `kb`）：`1mb` / `1GB` 是人真会写的样子，
 * 而 `1024**2` 只写一次 —— 键表里重复写同一个乘数不是「两份约束」，它就是一张查表。
 */
const UNIT_FACTORS: Readonly<Record<string, number>> = {
  "": 1,
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};

/** 后缀的**给人看的**清单（错误文案只用这一份，不许在文案里另抄一遍） */
const UNIT_NAMES = ["B", "K", "M", "G"] as const;

/**
 * 数值部分 + 可选后缀
 * @description
 * ⚠️ **指数写法必须落在第 1 个捕获组里**：把它写成不捕获的组，`1e30g` 会被读成
 * 「数值 1 乘 1 GiB」而**收下** —— 溢出判据于是形同虚设，而账本上多了一条 1 GiB 的账号。
 */
const TRAFFIC_SHAPE = /^((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([a-z]*)$/;

/** 毫秒：一个十进制正整数文本 */
const INTEGER_TEXT = /^\d+$/;

/**
 * 流量上限 → **字节数**
 * @description
 * 判据是**乘完之后必须落在一个非负安全整数上**，不是「输入有小数就收」也不是
 * 「输入是小数就拒」。三条合起来：
 * - `1.5g` → `1610612736`，**收**（精确算，不许先 `Math.floor` 再乘 —— 那会把
 *   `1.5g` 变成 1 GiB，而操作者以为给了 1.5 GiB）。
 * - `0.1k` → `102.4` 字节，**拒**：账本的字节数只能是整数，0.4 字节记不下来。
 * - `1e30g` → `Infinity`，**拒**：溢出的字节数序列化成 JSON 就是 `null`，而服务端
 *   收到 `null` 后的行为不是「当成一个很大的数」。⚠️ 这也是为什么判据落在**乘完之后**：
 *   判在乘之前的话 `9007199254740993`（超出安全整数，会被 `Number()` 舍入成
 *   `9007199254740992`）会静默变成另一个数。
 * - 指数写法（`8e15`）**收** —— 那是「一个很大的、但仍然是精确整数」的字节数，
 *   而账本字段就是以这种数存的。
 *
 * ⚠️ 不限量（`inf` / `unlimited` / `none` / `∞` / 留空）归一成 {@link UNLIMITED_BYTES}，
 * 与「`0`」不可区分 —— 见文件头「`0` 与没给是同一件事」。
 *
 * @param raw - 形参的原始文本
 * @returns 字节数（非负安全整数）
 * @throws {ValueError} 数值形态 / 单位 / 整数性 / 溢出
 */
function readTraffic(raw: string): number {
  const text = raw.trim().toLowerCase();
  if (UNLIMITED_SPELLINGS.has(text)) return UNLIMITED_BYTES;
  if (text.startsWith("-")) throw new ValueError(null, "流量上限不能是负数");
  const shape = TRAFFIC_SHAPE.exec(text);
  if (shape === null) {
    throw new ValueError(
      null,
      `流量上限要写成「数字 + 可选单位」（单位 ${UNIT_NAMES.join(" / ")}）；不限量写 inf / unlimited / none / ${INFINITY} 或留空`,
    );
  }
  const factor = UNIT_FACTORS[shape[2] as string];
  if (factor === undefined) {
    throw new ValueError(null, `流量上限的单位只能是 ${UNIT_NAMES.join(" / ")}（大小写随意）`);
  }
  const bytes = Number(shape[1]) * factor;
  if (!Number.isSafeInteger(bytes)) {
    throw new ValueError(
      null,
      "流量上限换算成字节之后不是一个精确的整数（字节数只能是整数，且不许超出安全整数范围）",
    );
  }
  return bytes;
}

/** `disabled` 的值：两种真相各收三种写法（全小写后比） */
const TRUE_SPELLINGS: ReadonlySet<string> = new Set(["on", "true", "1"]);
const FALSE_SPELLINGS: ReadonlySet<string> = new Set(["off", "false", "0"]);

/** 启用 / 停用 → 布尔（服务端那一侧是 `disabled`，故这里给的是**状态**而不是动作） */
function readBoolean(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (TRUE_SPELLINGS.has(text)) return true;
  if (FALSE_SPELLINGS.has(text)) return false;
  throw new ValueError(null, "值只能是 off / on / false / true / 0 / 1");
}

/**
 * 配额窗口的合法取值
 * @description
 * ⚠️ 与根仓 `src/manager/routes/patch.ts:WINDOWS` 一样是**三档闭合集**（`clear` = 删掉窗口键、
 * 回到服务端缺省），而它是一份**手抄**：对面加一档而这里没跟上时，操作者敲那一档会被本地拒掉 ——
 * 那是一次**说错了话的拒绝**，比让它走一趟网络换一句 400 更糟。故这份表的字面量由
 * `packages/tui/tests/parse.test.ts` 逐字钉住。
 * ⚠️ 元素类型写成与 `@/client` 的 `AccountUpdateInput["quotaWindow"]` **结构相同**的联合，
 * 于是执行层把它直接塞进请求体时 `tsc` 会验「这里的三档与服务端声明的三档是同一档」——
 * 写错一个拼写就红，而**不是**等对面 400。
 */
export type QuotaWindow = "day" | "month" | "clear";

/** {@link QuotaWindow} 的运行时那一份（**唯一**；错误文案与补全都读它） */
export const QUOTA_WINDOWS: readonly QuotaWindow[] = ["day", "month", "clear"];

/** 配额窗口 → 合法取值（大小写随意；出参永远是表里的规范拼写） */
function readQuotaWindow(raw: string): QuotaWindow {
  const text = raw.trim().toLowerCase();
  const found = QUOTA_WINDOWS.find((one) => one === text);
  if (found === undefined) {
    throw new ValueError(null, `配额窗口只能是 ${QUOTA_WINDOWS.join(" / ")}`);
  }
  return found;
}

/** 名单条目的分隔符（⚠️ 服务端那条字符白名单里**没有**逗号，故逗号不可能是条目的一部分） */
const ENTRY_SEPARATOR = ",";

/**
 * 逗号分隔的名单条目 → 字符串数组（空 = **清空**这份名单）
 * @description
 * ⚠️ **逐条 trim，而一条空条目是失败**：`targetWhitelist a,,b` 里那个空词在服务端会变成一条
 * 「什么都不匹配」的条目（判据在数据源，本层看不见），而本层静默把它丢掉的话，操作者看到的是
 * 「已改」而磁盘上少了一条他以为写进去的东西。
 * ⚠️ **条目的语法不在这儿判**（合法 host / IP、路径语义）：那一份判据在服务端的数据源里，本层
 * 抄一份就多一处会漂的约束，而漂的后果是「命令层拒了一个服务端其实收的条目」。
 * ⚠️ **空列表是「清空」不是「没给」**：命令表里这一位是必填形参，故 `targetWhitelist`（不带
 * 任何东西）= 清空，而「没给」由参数个数判据单独管（少一个参数是 `bad-args`，不是清空）。
 */
function readEntryList(raw: string): readonly string[] {
  const text = raw.trim();
  if (text === "") return [];
  const entries = text.split(ENTRY_SEPARATOR).map((one) => one.trim());
  if (entries.some((one) => one === "")) {
    throw new ValueError(null, "名单条目用逗号分隔，且逗号前后都要有内容（写 - 清空这份名单）");
  }
  return entries;
}

/** 毫秒数：只判「是不是一个能当毫秒数的非负安全整数」；区间判据归 `@/ledger` */
function readTimeout(raw: string): number {
  const text = raw.trim();
  if (!INTEGER_TEXT.test(text)) throw new ValueError(null, "超时必须是非负整数毫秒");
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new ValueError(null, "超时超出安全整数范围");
  return value;
}

/**
 * 凭据类形参（密码 / token）：**逐字**保留
 * @description 一律不 throw：形状由服务端那份唯一判据回答（它比的是摘要），
 * 本层再造一份字符集就是一处会漂的假约束（与 `@/ledger/validate.ts` 同源纪律）。
 */
function readVerbatim(raw: string): string {
  return raw;
}

/**
 * 名字类形参（用户名 / 显示名 / 配置键）：trim 之后**不能**是空的
 * @description
 * ⚠️ **trim 但不小写化**：配置键是 `AUTH_TYPE` 这种大写、用户名的大小写也有意义，
 * 而首尾空白在这里永远是复制粘贴带进来的手滑（`@/ledger` 落盘前还会再 trim 一遍，
 * 两边一致）。⚠️ 凭据类形参**不走**这个读法 —— 密码与 token 的首尾空白是**值**。
 */
function readText(label: string): Reader<string> {
  return (raw: string): string => {
    const value = raw.trim();
    if (value === "") throw new ValueError(null, `${label} 不能为空`);
    return value;
  };
}

/** `help` 的主题：trim + **小写**（命令表里全是小写 ASCII 命令名） */
function readTopic(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === "") throw new ValueError(null, "命令名不能为空");
  return value;
}

/**
 * `user set` 的合法字段（**闭合集**，与根仓 `src/manager/routes/patch.ts:PATCH_KEYS` 镜像）
 * @description
 * ⚠️ **字段名逐字用服务端那一份**：服务端对未知字段直接 400，而一个**本工具自己多收**的字段
 * 会让操作者以为改成功了（命令层没报错、请求被拒、界面上的字段没变）。反过来，本表**少收**
 * 一条就等于「服务端支持、本工具做不到」—— 所以它是**七条一条不缺**，不是「挑几个好打的」。
 * ⚠️ 里面**没有**「用户名」：服务端不允许改用户名（白名单里没有 `username`），而一个解析器接受、
 * 服务端会拒的字段，是把「敲错」升级成「以为成了」的最短路径。改用户的名字在本工具里**做不到**，
 * 这不是缺口。
 * ⚠️ 顺序按「补 / 密码 / 配额 / 到期 / 名单」分组，同一组的相邻，`help` 与错误文案都按它呈现。
 */
export const USER_FIELDS = [
  "disabled",
  "password",
  "quotaBytes",
  "quotaWindow",
  "expiresAt",
  "targetWhitelist",
  "targetBlacklist",
] as const;

/** {@link USER_FIELDS} 的元素类型（小写规范化后的合法值） */
export type UserField = (typeof USER_FIELDS)[number];

/**
 * 每个字段的**值**类型（{@link UserSetCommand} 与值分派共读这一张表）
 * @description
 * ⚠️ 值的**类型**住在字段名旁边，于是「字段 → 值的形状」在**类型上**只有一个真相源：改字段名不必
 * 记得改某一处 `if`，而改值的形状时 {@link UserSetCommand} 那个映射联合自动跟着走。
 * ⚠️ 两条**收窄**判据住在这个联合的**外面**：`quotaWindow`（{@link readQuotaWindow}）与名单条目
 * （{@link readEntryList}）—— 它们收的是「连请求体都拼不出来」的形态，让一次注定被拒的请求走完
 * 网络往返才显示同一句话，是在浪费操作者的注意力。时刻形态（`expiresAt` 的 ISO）与条目语法
 * （某条名单合不合法）**不**在这里收：那两样的判据在服务端，返回的是一句现成的话，本层抄一份
 * 只会与对面漂。
 */
export interface UserValueOf {
  /** `true` = 停用（与服务端那一侧同向，故这一档给的是**状态**而不是动作） */
  readonly disabled: boolean;
  /** **逐字**：空串就是空密码 */
  readonly password: string;
  /** 字节数（读法带单位后缀，见 {@link readTraffic}）；`0` = 不限量 */
  readonly quotaBytes: number;
  /** 配额窗口（`clear` = 删掉窗口键、回到服务端缺省） */
  readonly quotaWindow: QuotaWindow;
  /** **逐字**：ISO 串或 `clear`，形态由服务端判 */
  readonly expiresAt: string;
  /** 逗号分隔的条目；空列表 = 清空这份个人白名单 */
  readonly targetWhitelist: readonly string[];
  /** 逗号分隔的条目；空列表 = 清空这份个人黑名单 */
  readonly targetBlacklist: readonly string[];
}

/** 编译期锁：{@link UserValueOf} 的键与 {@link UserField} 闭合集**逐个相等** */
type ExactKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** @see {@link ExactKeys} —— 写成 `extends true` 就是那条锁；两处少一处都编译期红 */
export type UserFieldsAreComplete = ExactKeys<keyof UserValueOf, UserField> extends true
  ? true
  : never;

/**
 * 字段名 → 合法字段
 * @description
 * ⚠️ 比较时**两边都小写**，而返回的是**表里那个成员**（`quotaBytes`）：合法字段名本身是
 * 驼峰，只把用户输入小写化的话 `quotabytes` 会被拒 —— 那不是「非法字段」，那是同一个人
 * 手滑少按了 Shift。故规范化落在**比较**上，而结果永远是表里的规范拼写。
 */
function readField(raw: string): UserField {
  const text = raw.trim().toLowerCase();
  const found = USER_FIELDS.find((field) => field.toLowerCase() === text);
  if (found === undefined) {
    throw new ValueError(null, `字段只能是 ${USER_FIELDS.join(" / ")}`);
  }
  return found;
}

/**
 * `user set` 的值 → **一条命令**（字段与值的类型在同一个分支里收窄）
 * @description
 * ⚠️ **在 `switch` 的每一支里直接把对象造出来**，而不是「一个 `readUserValue(field, raw)` 返回值 +
 * 一处造对象」：那样 `field` 与 `value` 在 TS 看来是**两个互不相关的类型**，`{ field, value }`
 * 那个对象与 {@link UserSetCommand} 的七个分支**一个都对不上**（实测 `tsc` 直接红，且红得莫名其妙）。
 * 在本函数里 `field` 已被 `switch` 收窄成那个字面量，于是对象逐字落在对应的那一支上。
 * ⚠️ 末尾那条 `never` 断言是**锚点**：{@link UserValueOf} 加一档而这里忘了分派时 `tsc` 会红；
 * 少了它，新字段会静默落到「逐字透传」那一支（把一个 `number` 的字段写成字符串发出去，服务端 400）。
 * ⚠️ 形参表里那一位是**逐字**读的（凭据的首尾空白是值），而七个字段里只有三个要判 —— 故分派
 * 住在这里而不是在形参表里。
 * @throws {ValueError}（`argIndex` 留 `null`，由 {@link parseLine} 补成「第 3 个形参」）
 */
function buildUserSet(username: string, field: UserField, raw: string): UserSetCommand {
  switch (field) {
    case "quotaBytes":
      return { kind: "user-set", username, field, value: readTraffic(raw) };
    case "disabled":
      return { kind: "user-set", username, field, value: readBoolean(raw) };
    case "quotaWindow":
      return { kind: "user-set", username, field, value: readQuotaWindow(raw) };
    case "targetWhitelist":
      return { kind: "user-set", username, field, value: readEntryList(raw) };
    case "targetBlacklist":
      return { kind: "user-set", username, field, value: readEntryList(raw) };
    // ⚠️ 这两个**逐字透传**：`password` 的空串是「把密码设成空串」；`expiresAt` 的时刻形态
    // 归服务端判（那一份判据在数据源，本层抄一份就多一处会漂的约束）
    case "expiresAt":
      return { kind: "user-set", username, field, value: raw };
    case "password":
      return { kind: "user-set", username, field, value: raw };
    default:
      return unknownUserField(field);
  }
}

/**
 * 「这个字段还没有值的读法」—— **一个应该不可达的分支**
 * @description
 * ⚠️ 形参 `field: never` **不可省**：它是那条编译期锁的**全部**机制。去掉形参之后 `default` 分支
 * 就不再对任何东西做检查，于是加一个字段而忘了分派时**一声不响**（`never` 只在「把一个值传给
 * 一个不接任何东西的函数」时才被检查）。
 * ⚠️ 文案里带上 `field` **不违反「失败文案不回显用户输入」**：能走到这里说明它不在 `switch` 的
 * 七个 `case` 里，而调用它的是 {@link readField} 的产物 —— 永远是 {@link USER_FIELDS} 里的规范
 * 拼写，不是用户敲的那串（那串在 `readField` 那一层就被拒了，文案里只有闭合集）。
 */
function unknownUserField(field: never): never {
  throw new ValueError(null, `字段 ${String(field)} 还没有值的读法；合法字段是 ${USER_FIELDS.join(" / ")}`);
}

/* ── 命令表 ──────────────────────────────────────────────────────────────── */

/**
 * `user set` 那一条命令（**由 {@link UserValueOf} 映射出来的联合**，不是七条手写的分支）
 * @description
 * ⚠️ 写成**映射类型**而不是七条分支：字段名与值的类型同住一张表（{@link UserValueOf}），
 * 于是加一个字段只需要在那一处加一行 —— 联合、`user set` 的用法串、错误文案、补全候选、
 * 执行层的 `switch` 全都跟着走。⚠️ 反过来（本该被抓住的退化）：只在联合里加一条而不改那张表，
 * {@link UserFieldsAreComplete} 那条编译期锁会红。
 * ⚠️ 窄出来的 `field` 在下游**就是**一个判别位（执行层按它分派、掩码按它判），所以七档的值类型
 * 必须**互不相同**到足以让 `switch` 收窄 —— `expiresAt` 与 `password` 都是 `string`，
 * 收窄靠的是 `field` 那个字面量而不是值的类型。
 */
export type UserSetCommand = {
  readonly [F in UserField]: {
    readonly kind: "user-set";
    readonly username: string;
    readonly field: F;
    readonly value: UserValueOf[F];
  };
}[UserField];

/** 一条命令的判别（`kind` 逐条对应命令表里的一行） */
export type Command =
  | { readonly kind: "help"; readonly topic: string | null }
  | { readonly kind: "status" }
  | { readonly kind: "config"; readonly key: string | null }
  | { readonly kind: "usage"; readonly user: string | null }
  | { readonly kind: "acl" }
  | { readonly kind: "users" }
  /** ⚠️ `quotaBytes` 的 `0` = 不限量，与「没给」同义（见文件头） */
  | { readonly kind: "user-add"; readonly username: string; readonly quotaBytes: number }
  | UserSetCommand
  | { readonly kind: "user-on"; readonly username: string }
  | { readonly kind: "user-off"; readonly username: string }
  | { readonly kind: "user-del"; readonly username: string }
  | { readonly kind: "user-pass"; readonly username: string; readonly password: string }
  | {
      readonly kind: "target-add";
      readonly name: string;
      readonly baseUrl: string;
      readonly token: string;
      /** `null` = 没给这个参数（区间判据与缺省值归 `@/ledger`） */
      readonly timeoutMs: number | null;
    }
  | { readonly kind: "target-del"; readonly name: string }
  | { readonly kind: "target-switch"; readonly name: string }
  | { readonly kind: "clear" }
  | { readonly kind: "reprobe" };

/** 补全的**纯数据**上下文（本层不许自己读台账，故名字由调用方喂进来） */
export interface CompletionNames {
  /** 台账里的 target **显示名**（`target del` / `target switch` 的候选来源） */
  readonly targetNames: readonly string[];
}

/** 读一个形参的原始文本 → 规范化后的值（不合法时抛模块私有的 `ValueError`） */
type Reader<T> = (raw: string) => T;

/** 某个形参位置的补全候选来源（缺省 = **没有**可补全的东西） */
type Choices = (names: CompletionNames) => readonly string[];

/** 一个形参的声明 */
interface ArgSpec<T> {
  /** 人读的参数名（只进 `usage` 与错误文案） */
  readonly label: string;
  readonly required: boolean;
  readonly read: Reader<T>;
  readonly choices?: Choices;
}

/** 必填形参 */
function arg<T>(label: string, read: Reader<T>, choices?: Choices): ArgSpec<T> {
  return { label, required: true, read, ...(choices === undefined ? {} : { choices }) };
}

/**
 * 选填形参
 * @description ⚠️ **选填形参只许排在最后**（于是「参数齐不齐」是一次个数比较，
 * 而不是逐位判 `undefined` —— 后者会让「`user add alice 1g 2m`」这种多出来的参数
 * 静默变成第三个形参）。
 */
function opt<T>(label: string, read: Reader<T>, choices?: Choices): ArgSpec<T | undefined> {
  return { label, required: false, read, ...(choices === undefined ? {} : { choices }) };
}

/**
 * 形参数组 → 每个位置上形参的**值**类型（按位置逐个映射，于是 `build` 里每个值都有类型）
 * @description
 * ⚠️ 这里的 `ArgSpec<any>` 是**故意的擦除**：形参表是**异构元组**（一位 `string`、
 * 一位 `number`），而约束里必须有一个对每一位都成立的类型 —— `ArgSpec<never>` 会要求
 * `read` 返回 `never`（没有任何读法满足），`ArgSpec<unknown>` 看着可以但
 * `Values` 会把每一位推成 `unknown`（`build` 里就什么类型信息都没有了）。
 */
type AnyArg = ArgSpec<any>;

/** {@link AnyArg} 元组 → 每个位置上形参的**值**类型 */
type Values<A extends readonly AnyArg[]> = {
  -readonly [K in keyof A]: A[K] extends ArgSpec<infer T> ? T : never;
};

/** {@link CommandSpec} 的对外形态（表被擦成同一种形参，故 `argIndex` 是**位置**而不是类型） */
export interface CommandSpec {
  /**
   * 命令名（**不带** {@link COMMAND_PREFIX}）—— 它是**查找键**，不是给人看的样子
   * @description ⚠️ 解析、补全、错误的用法串全部按**这一个键**找规格，而给人看的形态是
   * {@link path}。写成两份的后果是「`help` 里印的是 `/user add`、回车执行的是 `user add`」这种
   * 一屏两句话，而它只在有人手抄命令名时显形。
   */
  readonly name: string;
  /**
   * 给人看的命令名（= {@link COMMAND_PREFIX} + {@link name}）—— **呈现侧唯一该读的那个**
   * @description 刻意与 {@link name} 同住一张表且由它算出：`name` 改了而 `path` 没跟上，
   * 编译器不会红（两者都是 `string`），故它**必须**是同一处 `+` 的产物。
   */
  readonly path: string;
  /** 一句说明（`help` 的呈现行与命令面板的那一列） */
  readonly summary: string;
  /** 下一段的合法取值（**组**才有；一条命令恒为空数组） */
  readonly subs: readonly string[];
  readonly args: readonly AnyArg[];
  /** 由 `path` + `args` 推出来的用法串（**不另抄**一份） */
  readonly usage: string;
  readonly build: (values: readonly any[]) => Command;
}

/** 由名字与形参表推出用法串：`/user add <用户名> [流量上限]` */
function usageOf(path: string, subs: readonly string[], args: readonly AnyArg[]): string {
  if (subs.length > 0) return `${path} <子命令>`;
  return [path, ...args.map((one) => (one.required ? `<${one.label}>` : `[${one.label}]`))].join(
    " ",
  );
}

/**
 * 声明一条命令
 * @description
 * 泛型 `const A` 的作用是让 `build` 的**每个形参值都有类型**（`Values<A>` 把形参表
 * 逐位映射成值类型），于是 `build` 里 `quotaBytes` 是 `number`、`value` 是
 * `number | string | boolean` 的**并集**且**按字段收窄** —— 表与构造代码在类型上锁在一起，
 * 不必写一句 `as`。
 */
function defineCommand<const A extends readonly AnyArg[]>(spec: {
  readonly name: string;
  readonly summary: string;
  readonly args: A;
  readonly build: (values: Values<A>) => Command;
}): CommandSpec {
  const path = COMMAND_PREFIX + spec.name;
  return {
    name: spec.name,
    path,
    summary: spec.summary,
    subs: [],
    args: spec.args,
    usage: usageOf(path, [], spec.args),
    // 擦除：形参表是异构元组，而 {@link CommandSpec} 对外只承诺「一组同形形参」。
    // ⚠️ 这个 `as` 是**单点**的 —— 泛型的那一半在 {@link Values}，写坏了会红。
    build: spec.build as (values: readonly any[]) => Command,
  };
}

/** 声明一个**组**（`user` / `target`：本身不是命令，只是下一段的容器） */
function defineGroup(name: string, subs: readonly string[], summary: string): CommandSpec {
  const path = COMMAND_PREFIX + name;
  return {
    name,
    path,
    summary,
    subs,
    args: [],
    usage: usageOf(path, subs, []),
    build: () => {
      throw new Error(`组 ${name} 不产生命令（解析器不该把一个组交出去）`);
    },
  };
}

/**
 * 命令表（**唯一**一份）
 * @description
 * 顺序是 `help` 的呈现顺序（先「查帮助」再「干活」）。⚠️ 它**不是**补全的排序依据 ——
 * 补全与建议一律按候选自身的字典序排（理由见 {@link ./complete.ts} 文件头）。
 */
const SPECS: readonly CommandSpec[] = [
  defineCommand({
    name: "help",
    summary: "列出命令，或给一条命令看用法",
    args: [opt("命令名", readTopic, () => COMMAND_NAMES)],
    build: ([topic]) => ({ kind: "help", topic: topic ?? null }),
  }),
  defineCommand({
    name: "status",
    summary: "服务进程与代理的现状",
    args: [],
    build: () => ({ kind: "status" }),
  }),
  defineCommand({
    name: "config",
    summary: "配置项（给键名只看那一个）",
    args: [opt("键名", readText("键名"))],
    build: ([key]) => ({ kind: "config", key: key ?? null }),
  }),
  defineCommand({
    name: "usage",
    summary: "各账号当前窗口的用量（给用户名只看那一个）",
    args: [opt("用户名", readText("用户名"))],
    build: ([user]) => ({ kind: "usage", user: user ?? null }),
  }),
  defineCommand({
    name: "acl",
    summary: "名单（白/黑，按目标分组）",
    args: [],
    build: () => ({ kind: "acl" }),
  }),
  defineCommand({
    name: "users",
    summary: "账号清单",
    args: [],
    build: () => ({ kind: "users" }),
  }),
  defineGroup("user", ["add", "del", "off", "on", "pass", "set"], "账号的增删改"),
  defineCommand({
    name: "user add",
    summary: "建账号（不给流量上限 = 不限量）",
    args: [arg("用户名", readText("用户名")), opt("流量上限", readTraffic)],
    // ⚠️ 缺省归一成 `0`（= 不限量）不是「零字节」：见文件头
    build: ([username, quotaBytes]) => ({
      kind: "user-add",
      username,
      quotaBytes: quotaBytes ?? UNLIMITED_BYTES,
    }),
  }),
  defineCommand({
    name: "user set",
    summary: `改账号（字段：${USER_FIELDS.join(" / ")}）`,
    args: [
      arg("用户名", readText("用户名")),
      arg("字段", readField, () => USER_FIELDS),
      // 值是**逐字**的：按字段该怎么读，由 {@link buildUserSet} 分派
      arg("值", readVerbatim),
    ],
    build: ([username, field, value]) => {
      try {
        return buildUserSet(username, field, value);
      } catch (err) {
        // ⚠️ 下标由这一层填（形参表里那一位的读法是逐字的，值域判据全在 `buildUserSet` 里）
        if (err instanceof ValueError) throw new ValueError(3, err.message);
        throw err;
      }
    },
  }),
  defineCommand({
    name: "user on",
    summary: "启用账号",
    args: [arg("用户名", readText("用户名"))],
    build: ([username]) => ({ kind: "user-on", username }),
  }),
  defineCommand({
    name: "user off",
    summary: "停用账号",
    args: [arg("用户名", readText("用户名"))],
    build: ([username]) => ({ kind: "user-off", username }),
  }),
  defineCommand({
    name: "user del",
    summary: "删账号",
    args: [arg("用户名", readText("用户名"))],
    build: ([username]) => ({ kind: "user-del", username }),
  }),
  defineCommand({
    name: "user pass",
    summary: "改密码（⚠️ 敲进这一行的密码会留在命令行的历史里）",
    args: [arg("用户名", readText("用户名")), arg("新密码", readVerbatim)],
    build: ([username, password]) => ({ kind: "user-pass", username, password }),
  }),
  defineGroup("target", ["add", "del", "switch"], "控制面目标的增删切"),
  defineCommand({
    name: "target add",
    summary: "加一个控制面目标（不给超时就用缺省）",
    args: [
      arg("名字", readText("名字")),
      arg("地址", readText("地址")),
      // ⚠️ 凭据：这里**逐字**保留，而任何失败文案都不许提到它（见文件头那条纪律）
      arg("token", readVerbatim),
      opt("超时毫秒", readTimeout),
    ],
    build: ([name, baseUrl, token, timeoutMs]) => ({
      kind: "target-add",
      name,
      baseUrl,
      token,
      timeoutMs: timeoutMs ?? null,
    }),
  }),
  defineCommand({
    name: "target del",
    summary: "删掉一个控制面目标",
    args: [arg("名字", readText("名字"), (names) => names.targetNames)],
    build: ([name]) => ({ kind: "target-del", name }),
  }),
  defineCommand({
    name: "target switch",
    summary: "切到某个控制面目标",
    args: [arg("名字", readText("名字"), (names) => names.targetNames)],
    build: ([name]) => ({ kind: "target-switch", name }),
  }),
  defineCommand({
    name: "clear",
    summary: "清掉结果区",
    args: [],
    build: () => ({ kind: "clear" }),
  }),
  defineCommand({
    name: "r",
    summary: "重探当前控制面",
    args: [],
    build: () => ({ kind: "reprobe" }),
  }),
];

/** 命令表（`readonly` 视图；**只读不改**） */
export const COMMAND_SPECS = SPECS;

/**
 * 按名字查一条命令 / 一个组
 * @description
 * 线性扫 {@link SPECS}（它就是那张表）而不是查一张 `Map`：表是这个规模时索引带来的那点收益
 * 抵不上「**两份结构要同步**」的代价 —— 而同步漏了的后果是补全与解析对同一条命令给出两个答案。
 */
export function findSpec(name: string): CommandSpec | undefined {
  return SPECS.find((spec) => spec.name === name);
}

/** 表里全部命令名（含组与两级命令，顺序 = 表的顺序） */
export const COMMAND_NAMES: readonly string[] = SPECS.map((spec) => spec.name);

/** 只有第一段的名字（一个新行能打的最长那个词就是它） */
export const TOP_LEVEL_NAMES: readonly string[] = SPECS.filter(
  (spec) => !spec.name.includes(" "),
).map((spec) => spec.name);

/* ── 「最接近的那几个」───────────────────────────────────────────────────── */

/** 相邻换位算一次编辑（`staus` → `status` 只算 1 —— 不然一个手滑的换位会给不出建议） */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) rows.push([i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (rows[i - 1] as number[])[j] as number,
        (rows[i] as number[])[j - 1] as number,
        (rows[i - 1] as number[])[j - 1] as number,
      );
      // 换位：斜着再退一格（只看紧邻的那一对）
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((rows[i - 2] as number[])[j - 2] as number) + 1);
      }
      (rows[i] as number[])[j] = best + cost;
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

/** 两个字符串的公共前缀长度（排序的第二判据，见 {@link suggestCommands}） */
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/** 建议最多给几个 */
const SUGGEST_LIMIT = 3;

/** 短到不可能是手滑的输入（1–2 个字母）一律不给建议：那时候的「接近」全是噪声 */
const SHORTEST_SUGGESTABLE = 3;

/**
 * 最接近的那几个命令名
 * @description
 * 三个排序判据（**全部**是「两个字符串」的纯函数，故结果只由它们决定）：
 * 1. 编辑距离小的在前（相邻换位算一次）；
 * 2. 同距离时公共前缀长的在前（`usr` 该指向 `users` 而不是 `r`）；
 * 3. 还一样就按**候选自身的字典序**（⚠️ 不按「哪个更常用」—— 那会随实现细节漂移，
 *    而调用方拿到的顺序只需要**稳定**）。
 *
 * 距离上限随长度长（`2` 起、`3` 封顶），且输入短于 {@link SHORTEST_SUGGESTABLE} 个
 * 字符时**不给**建议。
 *
 * @param typed - 用户敲的那一段（**不**出现在任何失败文案里，见文件头那条纪律）
 * @param pool - 候选池（缺省 = 第一段命令名）
 */
export function suggestCommands(
  typed: string,
  pool: readonly string[] = TOP_LEVEL_NAMES,
): readonly string[] {
  const text = typed.trim().toLowerCase();
  if (text.length < SHORTEST_SUGGESTABLE) return [];
  const limit = Math.min(3, Math.max(2, Math.floor(text.length / 2)));
  return pool
    .map((name) => ({ name, distance: editDistance(text, name) }))
    .filter((one) => one.distance <= limit)
    .sort(
      (x, y) =>
        x.distance - y.distance ||
        commonPrefixLength(text, y.name) - commonPrefixLength(text, x.name) ||
        (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
    )
    .slice(0, SUGGEST_LIMIT)
    .map((one) => one.name);
}

/**
 * 命令名数组 → **给人看**的路径数组（每个前面补上 {@link COMMAND_PREFIX}）
 * @description ⚠️ 「给人看」这件事只许有**这一个**出口：错误文案、`help`、命令面板三处都读它，
 * 而它们拿到的是**命令名**（`suggestCommands` / `findSpec` 的键都是名字）。写成三处 `"/" + name`
 * 就是三处会漂 —— 漂出来的症状是「建议里写 `/status`、回车却因为少个斜杠被拒」。
 * @param names - 命令名（**不带**前缀）
 */
function withPrefix(names: readonly string[]): readonly string[] {
  return names.map((one) => COMMAND_PREFIX + one);
}

/* ── 解析 ────────────────────────────────────────────────────────────────── */

/** 一次解析的结果（判别联合，见文件头） */
export type ParseResult =
  /** 语法正确、字段齐了，带**规范化后**的参数（流量上限是字节数、字段名是小写合法值） */
  | { readonly kind: "ok"; readonly command: Command }
  /** 只有空白 —— ⚠️ **不是错误**，是「什么都不做」（回车不该在结果区留下一条消息） */
  | { readonly kind: "empty" }
  /**
   * 这一行**不以 {@link COMMAND_PREFIX} 开头**（带最接近的那几个）
   * @description ⚠️ 单独一档而**不是**混进 `unknown-command`：两件事要修的地方不同 ——
   * 漏了前缀补一个字符就好，命令名本身不认识则是另一回事，而合成一档的话操作者看到的建议
   * 是「你是不是想写 `statuss`」而不是「加上 `/`」。
   */
  | {
      readonly kind: "missing-prefix";
      readonly suggestions: readonly string[];
      readonly message: string;
    }
  /** 命令名不认识（带最接近的那几个；**不回显**敲了什么） */
  | {
      readonly kind: "unknown-command";
      readonly suggestions: readonly string[];
      readonly message: string;
    }
  /** 参数个数不对（含「组少一个子命令」「引号没闭合」） */
  | {
      readonly kind: "bad-args";
      readonly name: string | null;
      readonly usage: string | null;
      readonly message: string;
    }
  /** 某个值解析不出来（`1.5x` / `1e30g` / 字段名非法）；`argIndex` 从 1 起 */
  | {
      readonly kind: "bad-value";
      readonly name: string | null;
      readonly argIndex: number;
      readonly usage: string | null;
      readonly message: string;
    };

/** 一行分词失败时的文案（不给 `name` / `usage`：词流已经不可信，说不出是哪条命令） */
const TOKEN_FAILURES: Readonly<Record<TokenizeReason, string>> = {
  "unterminated-quote": "这一行里有没闭合的引号（引号内的空格算一个词的一部分）",
  "unterminated-escape": "这一行末尾有一个没有后继字符的反斜杠",
};

/** {@link resolveFrom} 的三种结果（`missing-sub` 与 `bad-sub` 都是「参数不对」，分档是为了给不同的话） */
type Resolution =
  | { readonly type: "command"; readonly spec: CommandSpec; readonly consumed: number }
  /** 给了组而没给子命令 */
  | { readonly type: "missing-sub"; readonly spec: CommandSpec }
  /** 给了子命令而它不在闭合集里 */
  | { readonly type: "bad-sub"; readonly spec: CommandSpec };

/**
 * 从 `words[0]` 起逐级下潜
 * @description
 * ⚠️ 只走**两级**（`user add` / `target switch`）：命令表里最深就是两级，而一个能走任意
 * 层的循环会在「表里多了一级」那天静默地放过一层没人定义过的命令。
 */
function resolveFrom(words: readonly string[]): Resolution | null {
  const head = findSpec(words[0] as string);
  // 第一段就不认识（**不回显**敲了什么，见文件头那条纪律）
  if (head === undefined) return null;
  if (head.subs.length === 0) return { type: "command", spec: head, consumed: 1 };
  const sub = words[1];
  if (sub === undefined) return { type: "missing-sub", spec: head };
  const child = findSpec(`${head.name} ${sub}`);
  if (child === undefined) return { type: "bad-sub", spec: head };
  return { type: "command", spec: child, consumed: 2 };
}

/**
 * 一行文本 → 一条命令
 * @description
 * 本函数**不抛**（输入侧的每一种坏法都收敛成 {@link ParseResult} 的某一档），
 * 于是调用方不需要 `try` 就能把「用户敲错了」显示成一件事。
 * ⚠️ 它也不碰执行：拿到 `ok` 的那一支之后要发请求、读台账还是清屏，全是执行层的事。
 *
 * ## ⚠️ 第一道判据是**整行以 {@link COMMAND_PREFIX} 开头**，而且是硬要求
 * @description
 * 首尾空白先 trim（于是「回车」按两次是一样的话），然后：
 * - 全空 → {@link ParseResult} 的 `empty`（**不是错误**）；
 * - 开头不是 `/` → `missing-prefix`（带最接近的几条，写成给人看的 `path`）；
 * - 否则把**去掉 `/` 之后**的那一段交给分词器 —— `/` 不进词，于是 `/user add` 就是两个词。
 *
 * @param line - 整行输入（未分词）
 * @returns {@link ParseResult} 的某一档
 */
export function parseLine(line: string): ParseResult {
  const text = line.trim();
  if (text === "") return { kind: "empty" };
  if (!text.startsWith(COMMAND_PREFIX)) {
    return {
      kind: "missing-prefix",
      suggestions: withPrefix(suggestCommands(text)),
      message: `每一条命令都要以 ${COMMAND_PREFIX} 开头`,
    };
  }
  const tokenized = tokenize(text.slice(COMMAND_PREFIX.length));
  if (tokenized.ok === false) {
    return {
      kind: "bad-args",
      name: null,
      usage: null,
      message: TOKEN_FAILURES[tokenized.reason],
    };
  }
  const words = tokenized.tokens;
  if (words.length === 0) return { kind: "empty" };

  const resolved = resolveFrom(words);
  if (resolved === null) {
    return {
      kind: "unknown-command",
      suggestions: withPrefix(suggestCommands(words[0] as string)),
      message: `不认识的命令（${COMMAND_PREFIX}help 可以看全部命令）`,
    };
  }
  if (resolved.type !== "command") {
    const { spec } = resolved;
    return {
      kind: "bad-args",
      name: spec.name,
      usage: spec.usage,
      message:
        (resolved.type === "missing-sub" ? "少一个子命令；" : "子命令不在闭合集里；") +
        `${spec.path} 的子命令是 ${withPrefix(spec.subs.map((one) => `${spec.name} ${one}`)).join(" / ")}`,
    };
  }
  const { spec, consumed } = resolved;

  const rest = words.slice(consumed);
  const required = spec.args.filter((one) => one.required).length;
  if (rest.length < required) {
    return {
      kind: "bad-args",
      name: spec.name,
      usage: spec.usage,
      message: `参数不够；用法是 ${spec.usage}`,
    };
  }
  if (rest.length > spec.args.length) {
    return {
      kind: "bad-args",
      name: spec.name,
      usage: spec.usage,
      message: `多给了 ${rest.length - spec.args.length} 个参数；用法是 ${spec.usage}`,
    };
  }

  const values: unknown[] = [];
  for (let i = 0; i < spec.args.length; i += 1) {
    const raw = rest[i];
    // ⚠️ 选填形参在末尾（见 `opt`），故 `undefined` 只能是「没给」，不会是「给了但读不出」
    if (raw === undefined) {
      values.push(undefined);
      continue;
    }
    try {
      values.push((spec.args[i] as ArgSpec<unknown>).read(raw));
    } catch (err) {
      // 读单个形参的 `read` 不知道自己在第几位（它只拿到那一个字符串），由这一层补上
      if (err instanceof ValueError) return badValue(spec, err.argIndex ?? i + 1, err.message);
      throw err;
    }
  }
  try {
    // 擦除：形参表是异构元组（`Values<A>` 那侧有类型），这里对外只承诺一组值
    return { kind: "ok", command: spec.build(values as readonly any[]) };
  } catch (err) {
    if (err instanceof ValueError) {
      // ⚠️ 兜底是「最后一个形参」：值的读法由 `build` 按字段决定（见 `user set` 那个声明），
      // 故它出错的位置永远是值那一格。
      return badValue(spec, err.argIndex ?? spec.args.length, err.message);
    }
    throw err;
  }
}

/** 一次「某个值不合法」的失败（`name` / `usage` 来自命令表，⚠️ 文案里没有用户输入） */
function badValue(
  spec: CommandSpec,
  argIndex: number,
  message: string,
): {
  readonly kind: "bad-value";
  readonly name: string;
  readonly argIndex: number;
  readonly usage: string;
  readonly message: string;
} {
  return { kind: "bad-value", name: spec.name, argIndex, usage: spec.usage, message };
}
