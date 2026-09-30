/**
 * @fileoverview `proxy-cli` 的**命令树与参数解析**（纯函数，零 IO、零配置读取）
 * @module admin/args
 * @description
 * 本模块只答一个问题：**这串 argv 想要做什么**。它不读文件、不读配置、不看数据源，因此
 * 「参数拼错」这件事在**任何 IO 之前**就被拒掉了 —— 这与 `config/load.ts` 的未知键闸门是同一条
 * 纪律：显式给出的东西若拼错，必须当场报错，而不是静默回落缺省值。
 *
 * ## 为什么 argv **不**交给 `loadConfig`
 *
 * 服务端 CLI 把整份 argv 当配置键（`--port 8080`），于是那里有一条未知键闸门。本工具的参数**不是**
 * 配置键（`user add alice` 里没有 `user` 这个配置项），把它们塞进同一条 argv 通路只有两种做法，
 * 两种都更坏：
 * - 在闸门之前把子命令剥掉 ⇒ 闸门再也看不见本工具自己的参数，`--passwrod` 这种拼错零信号；
 * - 把子命令词塞进 `NON_CONFIG_ENV_KEYS` ⇒ 那是**配置键**的容忍名单，把 `user` 放进去等于宣布
 *   「env 文件里写 `user=whatever` 也是合法的」。
 *
 * 故本工具的配置**只**来自 env 与 env 文件（`index.ts` 里那次 `loadConfig` 的 `argv` 传空数组），
 * 要临时换一份数据源就用标准 Unix 那一套：`AUTH_USERS_DRIVER=sqlite proxy-cli user list`。
 *
 * ## 三种退出码
 *
 * `0` 成功 / `1` 操作失败（数据源写不了、形状非法、账号不存在…）/ `2` **用法错**（命令或参数
 * 拼错）。分开 2 是给脚本用的：`2` 意味着「你命令敲错了，重敲一次」，`1` 意味着「命令没错，
 * 但这件事没做成」。合成一个码的话，脚本只能靠 grep stderr 文本分辨。
 *
 * @module
 */

/** 名单的三个组（与 `AclConfig` 的键同名同形） */
export type AclGroupName = "clientip" | "target" | "upstream";

/** 名单的两个名单方向 */
export type AclListName = "whitelist" | "blacklist";

/** 账号字段的**局部修改**（`user set` 的载荷）
 * @description
 * **每个字段都可选，而「缺省」与「显式给值」必须可区分**：`disabled` 的缺省是「不动它」，
 * `--disabled` 是「置 true」，`--no-disabled` 是「置 false」。故这些字段用**三态**表达：
 * `undefined` = 不动，`false`/`0`/`""` = 显式改成那个值。
 *
 * **`quota` 与 `expires` 的「删掉这个键」用字面量 `clear`**而不是某个魔术数值：`0` 已经是
 * 「不限流」的合法值，用它当「删键」会让「我想要无限」和「我想要这个字段消失」变成同一句话。
 * 两者运行期同义（判定层 `quota === undefined` 与 `bytes === 0` 都恒放行），但它们在文件里
 * 长相不同，而这份文件是要被人 diff 的。
 */
export interface AccountPatch {
  /** 新密码（**明文**，落盘前由数据源的形状校验把关） */
  readonly password?: string;
  /** 新的 `quota.bytes`（非负安全整数），或 `"clear"` = 删掉整个 `quota` 键 */
  readonly quotaBytes?: number | "clear";
  /** 新的 `quota.window`（`day` / `month`），或 `"clear"` = 删掉 `quota` 键 */
  readonly quotaWindow?: "day" | "month" | "clear";
  /** 新的 `expiresAt`（**带时区偏移的 ISO 8601**，即磁盘形态），或 `"clear"` = 删键 */
  readonly expiresAt?: string | "clear";
  /** 新的 `disabled`；缺省 = 不动这个字段 */
  readonly disabled?: boolean;
  /** 整份替换该用户个人名单的 `target.whitelist`（空数组 = 清空） */
  readonly targetWhitelist?: readonly string[];
  /** 整份替换该用户个人名单的 `target.blacklist`（空数组 = 清空） */
  readonly targetBlacklist?: readonly string[];
}

/** 解析出来的命令（穷举，**没有「别的」**——未识别的组合在解析期就成 `AdminUsageError`） */
export type AdminCommand =
  | { readonly kind: "help"; readonly topic?: "user" | "acl" | "usage" | "config" }
  | { readonly kind: "user"; readonly op: "list" }
  | { readonly kind: "user"; readonly op: "show"; readonly name: string }
  | UserWriteCommand
  | { readonly kind: "acl"; readonly op: "show" }
  | {
      readonly kind: "acl";
      readonly op: "add" | "remove";
      readonly group: AclGroupName;
      readonly list: AclListName;
      readonly entry: string;
    }
  | { readonly kind: "usage"; readonly op: "show"; readonly name?: string }
  | { readonly kind: "config"; readonly op: "show" };

/**
 * 会**改数据**的 user 子命令
 * @description
 * 刻意与只读那两条**分成两个类型**（而不是让命令层去 `if (op === "list" | op === "show")` 排除）：
 * 联合类型按「排除两个成员」收窄不出来——`op: "list"` 那个成员没有 `name` 字段，于是访问
 * `command.name` 在类型上不成立。把「一定带 `name`」编码进类型，执行面就不必再判一次。
 */
export type UserWriteCommand =
  | {
      readonly kind: "user";
      readonly op: "add";
      readonly name: string;
      /** 密码**必填**（解析期已保证：位置参数或 `--password` 二者必居其一） */
      readonly password: string;
      readonly patch: AccountPatch;
    }
  | {
      readonly kind: "user";
      readonly op: "set";
      readonly name: string;
      readonly patch: AccountPatch;
    }
  | {
      readonly kind: "user";
      readonly op: "passwd";
      readonly name: string;
      readonly password: string;
    }
  | { readonly kind: "user"; readonly op: "disable" | "enable" | "remove"; readonly name: string };

/** 用法错（退出码 2）：命令不存在、参数个数不对、参数拼错、参数值非法 */
export class AdminUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AdminUsageError";
  }
}

/** 命令树的顶层分组（第二个位置参数） */
const GROUPS = ["user", "acl", "usage", "config", "help"] as const;

/** 三组名单名 → `AclConfig` 的键。**唯一**一份映射，两个方向共用它。 */
const GROUP_KEYS: Readonly<Record<AclGroupName, "clientIp" | "target" | "upstream">> = {
  clientip: "clientIp",
  target: "target",
  upstream: "upstream",
};

/** `proxy-cli user add|set` 认识的全部 flag —— 出现在**白名单之外**的一律报「未知参数」 */
const ACCOUNT_FLAGS = new Set([
  "--password",
  "--quota",
  "--window",
  "--expires",
  "--disabled",
  "--no-disabled",
  "--target-whitelist",
  "--target-blacklist",
]);

/** 不吃值的 flag（存在即 true）
 * @description
 * 这张表必须与 {@link ACCOUNT_FLAGS} 逐条对得上：吃值的 flag 会在 `splitFlags` 里**吞掉后一个
 * token**。把 `--disabled` 错当成吃值的，于是 `user set a --quota 42 --disabled --password z`
 * 里的 `--password` 被当成 `--disabled` 的值，然后报「参数 --disabled 缺值」——一个语法完全
 * 正确的命令被拒。判据的形状是「这张表**只**覆盖无值 flag，其余一律吃值」。
 */
const VALUELESS_FLAGS = new Set(["--disabled", "--no-disabled"]);

/** 去掉空白并把 `--flag=` 拆成两段；**不改**位置参数（它们的位置就是语义） */
function tokenize(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of argv) {
    const eq = raw.indexOf("=");
    if (eq > 0 && raw.startsWith("--")) {
      out.push(raw.slice(0, eq), raw.slice(eq + 1));
      continue;
    }
    out.push(raw);
  }
  return out;
}

/**
 * 把 argv 切成「位置参数」与「flag 表」
 * @description
 * flag 表**只收本命令白名单里的** flag：遇到白名单外的 `--x` 立刻抛错，而不是先全部收下再让
 * 各命令自己挑。后者会让每个命令都写一遍「我认这些 flag」，而那份名单迟早与实际支持的漂移。
 *
 * `@param allowed - 该命令认识的 flag 全集
 * @throws {AdminUsageError} 未知 flag / flag 缺值 / 无值 flag 后面跟了值
 */
function splitFlags(
  tokens: readonly string[],
  allowed: ReadonlySet<string>,
): { positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    if (!allowed.has(token)) {
      throw new AdminUsageError(
        `未知参数 ${token}；本命令认识的参数是：${[...allowed].sort().join(" ")}`,
      );
    }
    // 无值 flag：登记成 `""` 且**不吞掉后一个 token**
    if (VALUELESS_FLAGS.has(token)) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        throw new AdminUsageError(`参数 ${token} 不吃值（它存在就是开），却跟了一个 ${next}`);
      }
      flags.set(token, "");
      continue;
    }
    const value = tokens[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new AdminUsageError(`参数 ${token} 缺值`);
    }
    flags.set(token, value);
    i++;
  }
  return { positionals, flags };
}

/** 位置参数个数必须**恰好**是 n（多了少了都是错，不做「多了就当没有」） */
function expectCount(group: string, positionals: readonly string[], n: number): void {
  if (positionals.length !== n) {
    throw new AdminUsageError(
      `${group} 命令需要 ${n} 个位置参数，收到 ${positionals.length} 个` +
        (positionals.length > n ? `（多余：${positionals.slice(n).join(" ")}）` : ""),
    );
  }
}

/** 逗号分隔的名单条目 → 去掉空白、去空项；**空串 = 清空成空名单**（不是「没给」） */
function splitEntries(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `quota.bytes`：非负安全整数，或字面量 `clear` */
function parseQuotaBytes(raw: string): number | "clear" {
  if (raw === "clear") {
    return "clear";
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new AdminUsageError(`--quota 只能是非负整数（字节）或 clear，收到 ${raw}`);
  }
  return n;
}

/** `quota.window`：只认 `day` / `month` / `clear`——**校验的判据归数据源，这里只挡明显的拼错** */
function parseWindow(raw: string): "day" | "month" | "clear" {
  if (raw === "day" || raw === "month" || raw === "clear") {
    return raw;
  }
  throw new AdminUsageError(`--window 只能是 day / month / clear，收到 ${raw}`);
}

/** 解析 `--flag=value` / `--flag value` 两种写法的 flag 表（`splitFlags` 的产物） */
function accountPatchFrom(flags: ReadonlyMap<string, string>): AccountPatch {
  const patch: {
    -readonly [K in keyof AccountPatch]: AccountPatch[K];
  } = {};

  const password = flags.get("--password");
  if (password !== undefined) {
    patch.password = password;
  }
  const quota = flags.get("--quota");
  if (quota !== undefined) {
    patch.quotaBytes = parseQuotaBytes(quota);
  }
  const window = flags.get("--window");
  if (window !== undefined) {
    patch.quotaWindow = parseWindow(window);
  }
  const expires = flags.get("--expires");
  if (expires !== undefined) {
    // **刻意不在这里校验 ISO 形态**：那个判据归 `@/datasource/users/validate.ts`，而它同时也是
    // 落盘前的最后一道闸。这里抄一份只会漂 —— 「CLI 认得、代理不认得」是更糟的失败形态。
    patch.expiresAt = expires;
  }
  if (flags.has("--disabled")) {
    patch.disabled = true;
  }
  if (flags.has("--no-disabled")) {
    patch.disabled = false;
  }
  const wl = flags.get("--target-whitelist");
  if (wl !== undefined) {
    patch.targetWhitelist = splitEntries(wl);
  }
  const bl = flags.get("--target-blacklist");
  if (bl !== undefined) {
    patch.targetBlacklist = splitEntries(bl);
  }
  return patch;
}

function parseUser(tokens: readonly string[]): AdminCommand {
  const op = tokens[0];
  if (op === undefined || op === "--help" || op === "-h") {
    throw new AdminUsageError(
      "user 后面要跟子命令：list / show / add / set / passwd / disable / enable / remove",
    );
  }

  // 无 flag 的子命令：位置参数个数是唯一的判据
  if (op === "list") {
    const { positionals } = splitFlags(tokens.slice(1), new Set());
    expectCount("user list", positionals, 0);
    return { kind: "user", op: "list" };
  }

  if (op === "show") {
    const { positionals } = splitFlags(tokens.slice(1), new Set());
    expectCount("user show", positionals, 1);
    return { kind: "user", op: "show", name: positionals[0] };
  }

  if (op === "passwd") {
    const { positionals } = splitFlags(tokens.slice(1), new Set());
    expectCount("user passwd", positionals, 2);
    return { kind: "user", op: "passwd", name: positionals[0], password: positionals[1] };
  }

  if (op === "disable" || op === "enable" || op === "remove") {
    const { positionals } = splitFlags(tokens.slice(1), new Set());
    expectCount(`user ${op}`, positionals, 1);
    return { kind: "user", op, name: positionals[0] };
  }

  if (op === "add" || op === "set") {
    const { positionals, flags } = splitFlags(tokens.slice(1), ACCOUNT_FLAGS);
    if (op === "set") {
      expectCount("user set", positionals, 1);
      const patch = accountPatchFrom(flags);
      if (Object.keys(patch).length === 0) {
        throw new AdminUsageError(
          "user set 至少要给一个要改的字段（如 --password / --quota / --disabled / --target-whitelist）",
        );
      }
      return { kind: "user", op: "set", name: positionals[0], patch };
    }
    // `add` 的密码**可以**作为第二个位置参数（也可以用 `--password`）——两种写法都常见，
    // 强制只留一种只会让人每次都在两种错法之间挑一个。故这里不套 `expectCount`（它只收一个
    // 确定值），而是逐条给出**该命令自己的**判据。
    if (positionals.length < 1) {
      throw new AdminUsageError("user add 需要 <name>");
    }
    if (positionals.length > 2) {
      throw new AdminUsageError(
        `user add 需要 <name> [password]，收到 ${positionals.length} 个位置参数` +
          `（多余：${positionals.slice(2).join(" ")}）`,
      );
    }
    const patch = accountPatchFrom(flags);
    const password = patch.password ?? positionals[1];
    if (password === undefined) {
      throw new AdminUsageError("user add 必须给密码（第二个位置参数或 --password）");
    }
    return { kind: "user", op: "add", name: positionals[0], password, patch };
  }

  throw new AdminUsageError(
    `user 后面没有这个子命令：${op}；可用的是 list / show / add / set / passwd / disable / enable / remove`,
  );
}

function parseAcl(tokens: readonly string[]): AdminCommand {
  const op = tokens[0];
  if (op === "show") {
    const { positionals } = splitFlags(tokens.slice(1), new Set());
    expectCount("acl show", positionals, 0);
    return { kind: "acl", op: "show" };
  }
  if (op !== "add" && op !== "remove") {
    throw new AdminUsageError(`acl 后面没有这个子命令：${op ?? ""}；可用的是 show / add / remove`);
  }
  const { positionals } = splitFlags(tokens.slice(1), new Set());
  expectCount(`acl ${op}`, positionals, 3);
  // ⚠️ **不要写成 `const [, group, list, entry]`**：`op` 已经在上面从 `tokens[0]` 取走了，
  // `positionals` 里**没有**它，于是多跳一个会让 group 读到名单方向去（实测过一次：
  // `acl add target blacklist evil.com` 报「组名只能是 clientip/target/upstream，收到 blacklist」）。
  const [group, list, entry] = positionals;
  if (group !== "clientip" && group !== "target" && group !== "upstream") {
    throw new AdminUsageError(`acl ${op} 的组名只能是 clientip / target / upstream，收到 ${group}`);
  }
  if (list !== "whitelist" && list !== "blacklist") {
    throw new AdminUsageError(`acl ${op} 的名单方向只能是 whitelist / blacklist，收到 ${list}`);
  }
  if (entry.trim().length === 0) {
    throw new AdminUsageError(`acl ${op} 的条目不能是空串`);
  }
  return { kind: "acl", op, group, list, entry: entry.trim() };
}

function parseUsage(tokens: readonly string[]): AdminCommand {
  const op = tokens[0];
  if (op !== "show") {
    throw new AdminUsageError(`usage 后面没有这个子命令：${op ?? ""}；可用的只有 show`);
  }
  const { positionals } = splitFlags(tokens.slice(1), new Set());
  // 0 个 = 全部用户；1 个 = 单个用户。**不实现「不给名字就默认查当前用户」**——CLI 没有登录
  // 上下文，那个默认只能是 `process.env.USER`，而它在这台部署机上往往是 root。
  if (positionals.length > 1) {
    throw new AdminUsageError(`usage show 最多接受 1 个用户名，收到 ${positionals.length} 个`);
  }
  return positionals.length === 0
    ? { kind: "usage", op: "show" }
    : { kind: "usage", op: "show", name: positionals[0] };
}

function parseConfig(tokens: readonly string[]): AdminCommand {
  const op = tokens[0];
  if (op !== "show") {
    throw new AdminUsageError(`config 后面没有这个子命令：${op ?? ""}；可用的只有 show`);
  }
  const { positionals } = splitFlags(tokens.slice(1), new Set());
  expectCount("config show", positionals, 0);
  return { kind: "config", op: "show" };
}

/**
 * argv → 命令
 * @description
 * **空 argv = 打印总帮助**（不是报错、也不是执行某个默认动作）：一个刚装上、还没读过文档的人
 * 敲 `proxy-cli` 应该看到「这东西能干什么」，而不是一个「未知命令」。
 *
 * @param argv - `process.argv.slice(2)`
 * @throws {AdminUsageError} 用法错（退出码 2）
 * @example parseAdminArgs(["user", "disable", "alice"])
 * // => { kind: "user", op: "disable", name: "alice" }
 */
export function parseAdminArgs(argv: readonly string[]): AdminCommand {
  const tokens = tokenize(argv);

  if (tokens.length === 0) {
    return { kind: "help" };
  }
  // 全局帮助：`--help` / `-h` 出现在任何位置都优先（拼错子命令时它是唯一的出路）
  if (tokens.includes("--help") || tokens.includes("-h")) {
    const topic = tokens.find((t) => (GROUPS as readonly string[]).includes(t) && t !== "help");
    return topic !== undefined && topic !== "help"
      ? { kind: "help", topic: topic as "user" | "acl" | "usage" | "config" }
      : { kind: "help" };
  }

  const group = tokens[0];
  if (group === "help") {
    const topic = tokens[1];
    if (topic === undefined) {
      return { kind: "help" };
    }
    if (topic === "user" || topic === "acl" || topic === "usage" || topic === "config") {
      return { kind: "help", topic };
    }
    throw new AdminUsageError(
      `help 后面没有这个主题：${topic}；可用的是 user / acl / usage / config`,
    );
  }
  if (group !== "user" && group !== "acl" && group !== "usage" && group !== "config") {
    throw new AdminUsageError(
      `没有这个命令：${group}；可用的是 ${GROUPS.join(" / ")}（或 proxy-cli --help）`,
    );
  }

  switch (group) {
    case "user":
      return parseUser(tokens.slice(1));
    case "acl":
      return parseAcl(tokens.slice(1));
    case "usage":
      return parseUsage(tokens.slice(1));
    case "config":
      return parseConfig(tokens.slice(1));
  }
}

/** 名单组名 → `AclConfig` 的键（CLI 侧唯一一份映射，命令层据此读改） */
export function aclGroupKey(group: AclGroupName): "clientIp" | "target" | "upstream" {
  return GROUP_KEYS[group];
}
