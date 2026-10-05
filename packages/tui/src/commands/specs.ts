/** @fileoverview 命令表：每一条命令的名字、说明、形参表，以及它造出的那一条命令（**唯一**一份，解析、`help`、补全、面板共读） */
/** ⚠️ 侧边栏上「哪几个会话可见」归 `sidebar_sessions` 那张表（落盘那一层维护），而这张表只管「敲进去的那一串话」 */
/** ⚠️ **可见性不是一条命令**：这张表里没有、也不许长出「某个会话可不可见」那一族动作或那一列 —— 那是落盘那一层的事 */
/** ⚠️ **表里没有组**：所有列表型操作都在弹窗里做完，而弹窗由状态层直接调读写面 —— 命令表只留「敲一串话就够了」的那些 */

import { readText, readTargets, readTopic, readVerbatim } from "./values.js";

/** 每一行命令都必须以它开头（**整行**的形状，判据在 `./parse.js:parseLine`；这里是 `path` 的算式） */
export const COMMAND_PREFIX = "/";

/** 一条命令的判别（`kind` 逐条对应命令表里的一行） */
export type Command =
  | { readonly kind: "help"; readonly topic: string | null }
  | { readonly kind: "status" }
  | { readonly kind: "config"; readonly key: string | null }
  | { readonly kind: "usage"; readonly user: string | null }
  | { readonly kind: "acl" }
  /** `/accounts`：控制面那一份账号清单（**纯读**）；⚠️ 增删改是 `/users` 弹窗的事，不归命令表 */
  | { readonly kind: "accounts" }
  | { readonly kind: "clear" }
  | { readonly kind: "reprobe" }
  /** `/new`：新开一个会话（本地动作，一个请求都不发） */
  | { readonly kind: "session-new" }
  /** `/rename`：给当前会话改名（**打开那个改名框**，本地动作） */
  | { readonly kind: "session-rename" }
  /** `/sessions`：打开历史会话弹窗（本地动作，一个请求都不发） */
  | { readonly kind: "sessions-open" }
  /** `/targets`：打开控制面清单弹窗（本地动作，一个请求都不发） */
  | { readonly kind: "targets-open" }
  /** `/users`：打开账号清单弹窗（本地动作，一个请求都不发） */
  | { readonly kind: "users-open" }
  /** `/providers`：打开提供商清单弹窗（本地动作，一个请求都不发） */
  | { readonly kind: "providers-open" }
  /** `/models`：打开按提供商分组的模型选择弹窗（本地动作，一个请求都不发） */
  | { readonly kind: "models-open" }
  /** `/batch`：⚠️ `command` 是**内层那一条已经解析完的**命令，`targets` 是台账里的**显示名**（`all` = 全部） */
  | { readonly kind: "batch"; readonly targets: string; readonly command: Command; readonly line: string }
  /** `/exit` 与 `/quit` **共用这一个 kind**（两个名字、零形参、本地动作，一个请求都不发） */
  | { readonly kind: "exit" };

/** ⚠️ 这是**尚未递归解析**的那一档（`build` 的出参）：`line` 还是一行原文，故 `Command` 里那一档的 `command` 才是解析完的 */
export interface BatchDraft {
  readonly kind: "batch";
  readonly targets: string;
  readonly line: string;
}

/** 补全的**纯数据**上下文（本层不许自己读台账，故名字由调用方喂进来） */
export interface CompletionNames {
  /** 台账里的 target **显示名**（`/batch` 第一格的候选来源） */
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
  /** 一句说明（`help` 的呈现行与命令面板的那一列；⚠️ 弹窗那一族**要把键位说在这里**，那是屏上唯一一份键位说明） */
  readonly summary: string;
  /** 下一段的合法取值（⚠️ **恒为空数组**而留着：`@/lib/agent.js:toolSpecs` 按它把组滤出模型的工具表，删掉这个字段就是改那份公开面） */
  readonly subs: readonly string[];
  readonly args: readonly AnyArg[];
  /** 由 `path` + `args` 推出来的用法串（**不另抄**一份） */
  readonly usage: string;
  /** ⚠️ 出参可以是 {@link BatchDraft}（只有 `/batch` 是）：递归解析由 `@/commands/parse.ts` 收尾 */
  readonly build: (values: readonly any[]) => Command | BatchDraft;
}

/** 由名字与形参表推出用法串：`/usage <用户名>` */
function usageOf(path: string, args: readonly AnyArg[]): string {
  return [path, ...args.map((one) => (one.required ? `<${one.label}>` : `[${one.label}]`))].join(" ");
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
    usage: usageOf(path, spec.args),
    // 擦除：形参表是异构元组，而 {@link CommandSpec} 对外只承诺「一组同形形参」。这个 `as` 是**单点**的
    build: spec.build as (values: readonly any[]) => Command | BatchDraft,
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
    name: "accounts",
    summary: "控制面那一份账号清单（增删改在 /users 弹窗里）",
    args: [],
    build: () => ({ kind: "accounts" }),
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
  defineCommand({
    name: "sessions",
    summary: "打开历史会话弹窗（↑↓ 选 · Enter 激活到侧边栏 · Ctrl+D 删除 · Ctrl+R 重命名 · Esc 关窗）",
    args: [],
    build: () => ({ kind: "sessions-open" }),
  }),
  defineCommand({
    name: "targets",
    summary:
      "打开控制面清单弹窗（↑↓ 选 · Enter 接到当前会话 · Ctrl+A 新增 · Ctrl+D 删除（按两次）· Ctrl+E 编辑 · Esc 关窗）",
    args: [],
    build: () => ({ kind: "targets-open" }),
  }),
  defineCommand({
    name: "users",
    summary:
      "打开账号清单弹窗（↑↓ 选 · Enter 编辑 · Ctrl+A 新增 · Ctrl+D 删除（按两次）· Ctrl+E 编辑 · Ctrl+P 改密码 · Esc 关窗）",
    args: [],
    build: () => ({ kind: "users-open" }),
  }),
  defineCommand({
    name: "providers",
    summary:
      "打开提供商清单弹窗（↑↓ 选 · Enter 切到它 · Ctrl+A 新增 · Ctrl+D 删除（按两次）· Ctrl+E 编辑 · Ctrl+M 编辑模型列表 · Esc 关窗）",
    args: [],
    build: () => ({ kind: "providers-open" }),
  }),
  defineCommand({
    name: "models",
    summary: "打开模型选择弹窗（↑↓ 选 · Enter 用它 · Ctrl+F 置顶 · Ctrl+R 循环推理强度 · Esc 关窗）",
    args: [],
    build: () => ({ kind: "models-open" }),
  }),
  defineCommand({
    name: "batch",
    summary: "把一条命令发到多个控制面（all = 台账里的全部；名字用逗号分隔）",
    // ⚠️ **第二格是 `rest`**：它吃下剩下的**原文**，于是内层命令的引号不会被拆了再拼回去
    args: [arg("控制面", readTargets, (names) => names.targetNames), rest("命令")],
    // ⚠️ 交出 `BatchDraft` 而不是 `Command`：递归解析只有 `@/commands/parse.ts` 做得了
    build: ([targets, line]) => ({ kind: "batch", targets, line }),
  }),
  defineCommand({
    name: "r",
    summary: "重探当前控制面",
    args: [],
    build: () => ({ kind: "reprobe" }),
  }),
  // ⚠️ **退出只经这两条命令**（`exitOnCtrlC: false` 是这个决定的一部分，见 `@/cli.tsx` 文件头）——
  // 故那一句说明必须自己说清「这是唯一的退出方式」，而它是唯一那扇门
  defineCommand({
    name: "exit",
    summary: "退出 TUI（这是唯一的退出方式 · Ctrl+C 不管用）",
    args: [],
    build: () => ({ kind: "exit" }),
  }),
  // ⚠️ **别名不是第二条实现**：两条 `build` 交出同一个 kind，于是「加一个别名要改几处」恒等于 1
  defineCommand({
    name: "quit",
    summary: "退出 TUI（这是唯一的退出方式 · Ctrl+C 不管用）",
    args: [],
    build: () => ({ kind: "exit" }),
  }),
];

export const COMMAND_SPECS = SPECS;

/** 按名字查一条命令；线性扫而不是查 `Map`：索引抵不上「两份结构要同步」的代价 */
export function findSpec(name: string): CommandSpec | undefined {
  return SPECS.find((spec) => spec.name === name);
}

/** 表里全部命令名（顺序 = 表的顺序，⚠️ **每一行都是一个完整命令名** —— 表里没有组，故它也是补全与建议的那一个闭合集） */
export const COMMAND_NAMES: readonly string[] = SPECS.map((spec) => spec.name);