/** @fileoverview 命令表：每一条命令的名字、说明、形参表，以及它造出的那一条命令（**唯一**一份，解析、`help`、补全、面板共读） */

import {
  UNLIMITED_BYTES,
  USER_FIELDS,
  ValueError,
  buildUserSet,
  readField,
  readText,
  readTargets,
  readTopic,
  readTraffic,
  readTimeout,
  readVerbatim,
  type UserField,
  type UserValueOf,
} from "./values.js";

/** 每一行命令都必须以它开头（**整行**的形状，判据在 `./parse.js:parseLine`；这里是 `path` 的算式） */
export const COMMAND_PREFIX = "/";

/**
 * `user set` 那一条命令（**由 {@link UserValueOf} 映射出来的联合**，不是七条手写的分支）
 * @description 加一个字段只需要在 `./values.js` 的那张表里加一行；只在联合里加一条而不改那张表，那条编译期锁会红。
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
  /** ⚠️ `0` = 不限量，与「没给」同义（判据与理由在 `./values.js` 文件头） */
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
      /** `null` = 没给这个参数（区间判据与缺省值归 `@/services/config`） */
      readonly timeoutMs: number | null;
    }
  | { readonly kind: "target-del"; readonly name: string }
  | { readonly kind: "target-switch"; readonly name: string }
  /** `/new`：新开一个会话（本地动作，一个请求都不发） */
  | { readonly kind: "session-new" }
  /** `/rename`：给当前会话改名（**打开那个改名框**，本地动作） */
  | { readonly kind: "session-rename" }
  /** `/session hide`：把一个会话从侧边栏藏起来（⚠️ 不删：输出与输入都留着） */
  | { readonly kind: "session-hide"; readonly name: string }
  /** `/session show`：把藏起来的那个放回侧边栏 */
  | { readonly kind: "session-show"; readonly name: string }
  /** `/managers`：打开控制面清单窗口（本地动作，一个请求都不发） */
  | { readonly kind: "show-managers" }
  /** `/provider show`：把 provider 那三样东西打出来（⚠️ 凭据那一格**恒为掩码**） */
  | { readonly kind: "provider-show" }
  /** `/batch`：⚠️ `command` 是**内层那一条已经解析完的**命令，`targets` 是台账里的**显示名**（`all` = 全部） */
  | { readonly kind: "batch"; readonly targets: string; readonly command: Command; readonly line: string }
  /** `/provider set`：三样一起换（⚠️ **一次写里同生死**，故「配了一半」这个状态在库里不存在） */
  | { readonly kind: "provider-set"; readonly baseUrl: string; readonly model: string; readonly apiKey: string }
  /** `/provider key`：**只**换凭据（读出另外两样再整体写回；⚠️ 没配过的时候这一条会拒 —— 那时该用 `/provider set`） */
  | { readonly kind: "provider-key"; readonly apiKey: string }
  | { readonly kind: "clear" }
  | { readonly kind: "reprobe" };

/** ⚠️ 这是**尚未递归解析**的那一档（`build` 的出参）：`line` 还是一行原文，故 `Command` 里那一档的 `command` 才是解析完的 */
export interface BatchDraft {
  readonly kind: "batch";
  readonly targets: string;
  readonly line: string;
}

/** 补全的**纯数据**上下文（本层不许自己读台账，故名字由调用方喂进来） */
export interface CompletionNames {
  /** 台账里的 target **显示名**（`target del` / `target switch` 的候选来源） */
  readonly targetNames: readonly string[];
}

/** 读一个形参的原始文本 → 规范化后的值（不合法时抛 `values.js` 那个 `ValueError`） */
export type Reader<T> = (raw: string) => T;

/** 某个形参位置的补全候选来源（缺省 = **没有**可补全的东西） */
type Choices = (names: CompletionNames) => readonly string[];

/** 一个形参的声明（`label` 是人读的参数名，只进 `usage` 与错误文案） */
export interface ArgSpec<T> {
  readonly label: string;
  readonly required: boolean;
  readonly read: Reader<T>;
  readonly choices?: Choices;
  /** 这个形参吃下**剩下的全部词**（原文，不是拼回去的一串） */
  // ⚠️ **只给 `/batch` 用**：分词再拼回去会毁掉引号，故解析层**特殊处理**这一格
  readonly rest?: true;
}

function arg<T>(label: string, read: Reader<T>, choices?: Choices): ArgSpec<T> {
  return { label, required: true, read, ...(choices === undefined ? {} : { choices }) };
}

/** 选填形参；⚠️ **选填形参只许排在最后**（于是「参数齐不齐」是一次个数比较，而不是逐位判 `undefined`） */
function opt<T>(label: string, read: Reader<T>, choices?: Choices): ArgSpec<T | undefined> {
  return { label, required: false, read, ...(choices === undefined ? {} : { choices }) };
}

/** 「剩下的全部词」那一格（⚠️ 读法**刻意不是 `Reader`**：拿到的是**原文**，由解析层那一支特殊处理） */
function rest(label: string): ArgSpec<string> {
  return { label, required: true, rest: true, read: readVerbatim };
}

/** ⚠️ `ArgSpec<any>` 是**故意的擦除**：异构元组要求一个对每一位都成立的类型（`never` 要求 `read` 返回 `never`，`unknown` 会把每一位推成 `unknown`） */
type AnyArg = ArgSpec<any>;

/** {@link AnyArg} 元组 → 每个位置上形参的**值**类型 */
type Values<A extends readonly AnyArg[]> = {
  -readonly [K in keyof A]: A[K] extends ArgSpec<infer T> ? T : never;
};

/** {@link CommandSpec} 的对外形态（表被擦成同一种形参，故 `argIndex` 是**位置**而不是类型） */
export interface CommandSpec {
  /** 命令名（**不带** {@link COMMAND_PREFIX}）—— 它是**查找键**，不是给人看的样子 */
  readonly name: string;
  /**
   * 给人看的命令名（= {@link COMMAND_PREFIX} + {@link name}）—— **呈现侧唯一该读的那个**
   * @description 它**必须**是同一处 `+` 的产物：`name` 改了而 `path` 没跟上编译器不会红。
   */
  readonly path: string;
  /** 一句说明（`help` 的呈现行与命令面板的那一列） */
  readonly summary: string;
  /** 下一段的合法取值（**组**才有；一条命令恒为空数组） */
  readonly subs: readonly string[];
  readonly args: readonly AnyArg[];
  /** 由 `path` + `args` 推出来的用法串（**不另抄**一份） */
  readonly usage: string;
  /** ⚠️ 出参可以是 {@link BatchDraft}（只有 `/batch` 是）：递归解析由 `@/commands/parse.ts` 收尾 */
  readonly build: (values: readonly any[]) => Command | BatchDraft;
}

/** 由名字与形参表推出用法串：`/user add <用户名> [流量上限]` */
function usageOf(path: string, subs: readonly string[], args: readonly AnyArg[]): string {
  if (subs.length > 0) return `${path} <子命令>`;
  return [path, ...args.map((one) => (one.required ? `<${one.label}>` : `[${one.label}]`))].join(
    " ",
  );
}

/** 声明一条命令；泛型 `const A` 让 `build` 的每个形参值都有类型，于是表与构造代码在类型上锁在一起 */
function defineCommand<const A extends readonly AnyArg[]>(spec: {
  readonly name: string;
  readonly summary: string;
  readonly args: A;
  readonly build: (values: Values<A>) => Command | BatchDraft;
}): CommandSpec {
  const path = COMMAND_PREFIX + spec.name;
  return {
    name: spec.name,
    path,
    summary: spec.summary,
    subs: [],
    args: spec.args,
    usage: usageOf(path, [], spec.args),
    // 擦除：形参表是异构元组，而 {@link CommandSpec} 对外只承诺「一组同形形参」。这个 `as` 是**单点**的
    build: spec.build as (values: readonly any[]) => Command | BatchDraft,
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

/** 命令表；顺序是 `help` 的呈现顺序，⚠️ **不是**补全的排序依据（补全与建议一律按候选自身的字典序排） */
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
      // 值是**逐字**的：按字段该怎么读，由 `buildUserSet` 分派
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
      // 凭据那一格**逐字**保留；「失败文案不许提到凭据」那条纪律在 `./values.js` 文件头
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
    name: "new",
    summary: "新开一个会话（每个会话有自己的输出与控制面）",
    args: [],
    build: () => ({ kind: "session-new" }),
  }),
  defineCommand({
    name: "rename",
    summary: "给当前会话起个新名字（Enter 确认 · Esc 取消）",
    args: [],
    build: () => ({ kind: "session-rename" }),
  }),
  defineGroup("session", ["hide", "show"], "把会话从侧边栏藏起来 / 放回来"),
  defineCommand({
    name: "session hide",
    summary: "把一个会话从侧边栏藏起来（输出与输入都留着；名字里有空格要加引号）",
    args: [arg("名字", readText("名字"))],
    build: ([name]) => ({ kind: "session-hide", name }),
  }),
  defineCommand({
    name: "session show",
    summary: "把藏起来的那个会话放回侧边栏（名字里有空格要加引号）",
    args: [arg("名字", readText("名字"))],
    build: ([name]) => ({ kind: "session-show", name }),
  }),
  defineCommand({
    name: "managers",
    summary: "打开控制面清单窗口（↑↓ 选 · Enter 确认 · Esc 关窗）",
    args: [],
    build: () => ({ kind: "show-managers" }),
  }),
  defineGroup("provider", ["show", "set", "key"], "模型 provider 的地址 / 模型名 / 凭据"),
  defineCommand({
    name: "provider show",
    summary: "看 provider 配了没有（凭据那一格只给掩码）",
    args: [],
    build: () => ({ kind: "provider-show" }),
  }),
  defineCommand({
    name: "provider set",
    summary: "配模型 provider（三样一起给，故没有「配了一半」这种状态）",
    args: [
      // ⚠️ **地址不归一**：`normalizeBaseUrl` 那份判据是**控制面**的，而 provider 可以是任何
      // OpenAI 兼容端点；拿它判就是「界面说合法、请求打不通」
      arg("地址", readText("地址")),
      arg("模型名", readText("模型名")),
      // ⚠️ 凭据**逐字**保留，而回显那一份由 `./echo.js` 按类别掩码（与 `/target add` 同一条路）
      arg("凭据", readVerbatim),
    ],
    build: ([baseUrl, model, apiKey]) => ({
      kind: "provider-set",
      baseUrl,
      model,
      apiKey,
    }),
  }),
  defineCommand({
    name: "provider key",
    summary: "只换 provider 的凭据（地址与模型名读出来一起写回）",
    args: [arg("凭据", readVerbatim)],
    build: ([apiKey]) => ({ kind: "provider-key", apiKey }),
  }),
  defineCommand({
    name: "batch",
    summary: "把一条命令发到多个控制面（all = 台账里的全部；名字用逗号分隔）",
    // ⚠️ **第二格是 `rest`**：它吃下剩下的**原文**，于是内层命令的引号不会被拆了再拼回去
    args: [arg("控制面", readTargets), rest("命令")],
    // ⚠️ 交出 `BatchDraft` 而不是 `Command`：递归解析只有 `@/commands/parse.ts` 做得了
    build: ([targets, line]) => ({ kind: "batch", targets, line }),
  }),
  defineCommand({
    name: "r",
    summary: "重探当前控制面",
    args: [],
    build: () => ({ kind: "reprobe" }),
  }),
];

export const COMMAND_SPECS = SPECS;

/** 按名字查一条命令 / 一个组；线性扫而不是查 `Map`：索引抵不上「两份结构要同步」的代价 */
export function findSpec(name: string): CommandSpec | undefined {
  return SPECS.find((spec) => spec.name === name);
}

/** 表里全部命令名（含组与两级命令，顺序 = 表的顺序） */
export const COMMAND_NAMES: readonly string[] = SPECS.map((spec) => spec.name);

/** 只有第一段的名字（一个新行能打的最长那个词就是它） */
export const TOP_LEVEL_NAMES: readonly string[] = SPECS.filter(
  (spec) => !spec.name.includes(" "),
).map((spec) => spec.name);