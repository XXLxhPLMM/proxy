/**
 * @fileoverview 路由层的**入参**解析：把「HTTP 上的一段文本」变成「ops 认识的形状」
 * @module manager/routes/input
 * @description
 * 路由的入参来自两处**攻击者可控**的地方：URL（路径段 / 查询串）与请求体。两者都必须先经过
 * 本模块的形状判据，才允许进 `@/ops`。本模块只答「这个值的形状对不对」，**不**答「这个账号
 * 存不存在」「这个名单条目合不合法」——后者是 ops 与数据源层的判据，路由重写一遍就是第二份
 * 真相源。
 *
 * ## 路径穿越：为什么要在这一层挡
 *
 * 用户名与名单条目都会被写进 `AUTH_USERS_FILE` / `ACL_FILE` 指向的那份数据，而 ops 的形状
 * 校验（`validateAuthUsers` / `validateAcl`）**不查路径语义**——它们判的是「用户名非空且不含
 * `:`」「条目符合名单语法」，不是「不含路径分隔符」。所以本模块的白名单是**第二道**闸，而它
 * 必须在这里：`ops` 是数据层，让它去猜「这个字符串将来会被拼进文件路径」是把**呈现面的知识**
 * 倒灌进数据层。
 *
 * 长度上限同理：没有上限时，一个 10 MB 的用户名会进日志、进 JSON、进内存。
 *
 * ## 两份字符集，且**必须不同**
 *
 * 它们**去的地方不同**，所以判据不能合并成一个（合并的后果见下）：
 *
 * - **username** 进的是数据源的**位置**词汇（账号表里那条记录的键）。字符集刻意**极窄**，
 *   只放行 `[A-Za-z0-9._-]`。这不是「用户名只能这么取」的断言（账号表里的存量用户名可以更宽，
 *   `proxy-cli` 照样能改它们），而是「**HTTP 面不表达**那些字符」的决定：想用别的字符请走
 *   `proxy-cli`。更窄换来的是「`..`、`/`、`\`、NUL、控制字符、百分号编码后的同类」一次全挡。
 * - **acl entry** 进的是**名单文档的语法**。字符集由数据层那份语法**反推**而来（逐字符依据见
 *   {@link SAFE_ACL_ENTRY} 的注释），而不是另挑一套。
 *
 * ⚠️ **传输层比数据层窄，对名单条目就是 bug**：acl.json 允许手改，而一条手改的**合法**条目必须
 * **读得到也删得掉**。判据比语法窄一寸，`GET /api/acl` 就会列出一条谁都删不掉的规则，运维只能
 * 回去改文件——那正是控制面本该替掉的动作。故名单这条的不变式是「**数据层接受 ⇒ HTTP 层能
 * 表达**」，牙齿是 `tests/unit/manager-http.test.ts` 里那条跨层护栏（它从 ops 的 `syntaxHint`
 * 与 `parseIpRule` / `parseHostRule` 现取形态，而不是手抄一份清单）。
 *
 * 两处都是**拒绝而非清洗**：把 `../../x` 悄悄改成 `x` 会让调用方以为操作的对象是 `x` 而它
 * 其实是别的什么；清洗后的值与请求里的值不同，那是最难查的一类不一致。
 *
 * 本模块**零 console、零 process**，不 import `@/admin/*`。
 *
 * @module
 */

import { OpsError } from "@/ops/index.js";
import type { RequestContext } from "../http/index.js";

/**
 * **用户名**的字符白名单
 * @description
 * 极窄：只放行 `[A-Za-z0-9._-]`。窄是**目的**——`..`、`/`、`\`、NUL、控制字符、百分号编码后
 * 的同类一次全挡，且判据是一句可读的字符集而不是一串 `indexOf`。
 */
const SAFE_USERNAME = /^[A-Za-z0-9._-]+$/;

/**
 * **名单条目**的字符白名单
 * @description
 * 逐个字符对齐**数据层的条目语法**，即「一条能被 `validateAcl` 接受的文本里可能出现的每一个
 * 字符」。语法判据是 `parseIpRule` / `parseHostRule`（`@/utils/addr/index.js`），字符级
 * 手术是 `@/utils/addr/text.ts` 的那四个原子：
 *
 * | 字符 | 来自哪种形态 |
 * |---|---|
 * | `A-Za-z0-9` | 域名标签、IPv4 分段、IPv6 十六进制组、前缀位数 |
 * | `.` | IPv4 分段、域名分隔、FQDN 尾点、通配前缀 `*.` |
 * | `-` | 域名标签里的连字符（`host.ts:RE_DOMAIN`） |
 * | `:` | IPv6 分组与 `::` 压缩 |
 * | `/` | **CIDR 前缀分隔符**（`parseIpRule` 按第一个 `/` 切地址与位数） |
 * | `*` | 通配域名的 `*.` 前缀（`parseHostRule` 的第一分支） |
 * | `[` `]` | 整体被方括号包裹的 IPv6 字面量（`stripIpBrackets` 收 `[::1]`） |
 * | `%` | RFC 4007 zone 后缀（`stripZone` 取第一个 `%` 之前的部分，`fe80::1%eth0`） |
 *
 * 刻意**不含**的：`_`（`RE_DOMAIN` 显式拒绝下划线，故它进不了任何合法条目，而多放一个字符就是
 * 本层多一份语法知识）、空白与控制字符（`validateList` 落盘前会 `trim`，带空白的文本会让
 * 「写进去的」与「读出来的」不是同一个串）、`\` 与引号（JSON 与日志的转义面）。
 *
 * 唯一的**刻意收窄**是 {@link requireSafeAclEntry} 另加的两条路径语义拒绝（`..`、首尾 `/`）：
 * 任何一条**规范**条目都不含 `..`、也不以 `/` 起止（`parseIpRule` 的地址段为空或位数段带 `/`
 * 都直接判非法），所以收窄它们不产生「数据层接受而 HTTP 层表达不了」的洞。
 */
const SAFE_ACL_ENTRY = /^[A-Za-z0-9.\-:/[\]*%]+$/;

/** 长度上限：够写下任何真实用户名、域名与 CIDR，又不让「一个字段吃掉整份请求体」成为可能 */
const MAX_TEXT_LENGTH = 255;

/** 逐条拒绝：空串、超长（两类标识符共用这一条上限） */
function requireBoundedText(raw: string, what: string): void {
  if (raw.length === 0) {
    throw new OpsError("invalid", `${what} 不能为空`);
  }
  if (raw.length > MAX_TEXT_LENGTH) {
    throw new OpsError("invalid", `${what} 超过 ${MAX_TEXT_LENGTH} 字符上限`);
  }
}

/**
 * 校验并返回一个「可安全用作数据源位置词汇」的**用户名**
 * @description
 * 逐条拒绝：空串、超长、含白名单外字符；`.` 与 `..` 单独出现时另拒（一个账号叫 `..` 没有任何
 * 正当理由，而它们在白名单内）。**不**尝试「清洗」——见文件头。
 *
 * @param raw - 原始文本（**已由路由层 `decodeURIComponent` 解码**）
 * @returns 逐字返回原值（不归一化、不改大小写）
 * @throws {OpsError} `invalid`：形状不合法
 * @example requireSafeUsername("alice") // => "alice"
 * @example requireSafeUsername("a/b") // => throws OpsError("invalid")
 * @example requireSafeUsername("../../etc/passwd") // => throws OpsError("invalid")
 */
export function requireSafeUsername(raw: string): string {
  requireBoundedText(raw, "username");
  if (!SAFE_USERNAME.test(raw)) {
    throw new OpsError(
      "invalid",
      `username 含不允许的字符（只接受字母、数字、. _ -）：${JSON.stringify(raw)}`,
    );
  }
  if (raw === "." || raw === "..") {
    throw new OpsError("invalid", `username 不能是 ${raw}`);
  }
  return raw;
}

/**
 * 校验并返回一条**名单条目**
 * @description
 * 字符集是 {@link SAFE_ACL_ENTRY}（逐字符依据见那里的表）——判据是「数据层接受 ⇒ HTTP 层能表达」，
 * 窄于数据层就会造出「读得到、删不掉」的条目。**本函数不判条目语法对不对**：`10.0.0.0/33`、
 * `example.com:8080`、`not a host` 一律放过，交给 `@/ops/acl.ts` 用 `parseIpRule` /
 * `parseHostRule` 判——那条错误会**点名他刚敲的那一串**，比本层说「形状不合法」有用得多。
 *
 * 字符集之外另加两条**路径语义**的拒绝（`..`、首尾 `/`）：条目会被写进 `ACL_FILE` 指向的那份
 * 文档，而任何规范条目都不含这两种形态。
 *
 * @param raw - 原始文本（**已由路由层 `decodeURIComponent` 解码**）
 * @returns 逐字返回原值（不归一化：`trim` / 小写 / 剥方括号 / 剥 zone 全部由数据层做，
 *   在这里做一遍就是第二份口径）
 * @throws {OpsError} `invalid`：形状不合法
 * @example requireSafeAclEntry("10.0.0.0/8") // => "10.0.0.0/8"
 * @example requireSafeAclEntry("*.cdn.io") // => "*.cdn.io"
 * @example requireSafeAclEntry("2001:db8::/32") // => "2001:db8::/32"
 * @example requireSafeAclEntry("../../etc/passwd") // => throws OpsError("invalid")
 */
export function requireSafeAclEntry(raw: string): string {
  requireBoundedText(raw, "acl entry");
  if (!SAFE_ACL_ENTRY.test(raw)) {
    throw new OpsError(
      "invalid",
      `acl entry 含不允许的字符（只接受字母、数字、. - : / * [ ] %）：${JSON.stringify(raw)}`,
    );
  }
  if (raw.includes("..")) {
    throw new OpsError("invalid", `acl entry 不能含 ..：${JSON.stringify(raw)}`);
  }
  if (raw.startsWith("/") || raw.endsWith("/")) {
    throw new OpsError("invalid", `acl entry 不能以 / 开头或结尾：${JSON.stringify(raw)}`);
  }
  return raw;
}

/** 请求体必须是 JSON 对象（不是数组 / null / 标量） */
function requireObjectBody(ctx: RequestContext): Record<string, unknown> {
  if (typeof ctx.body !== "object" || ctx.body === null || Array.isArray(ctx.body)) {
    throw new OpsError(
      "invalid",
      "请求体必须是一个 JSON 对象（Content-Type: application/json）",
    );
  }
  return ctx.body as Record<string, unknown>;
}

/** 对象里取一个必填字符串字段 */
function requireStringField(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new OpsError("invalid", `字段 ${key} 必须是字符串`);
  }
  return value;
}

/**
 * `POST` / `PUT` 的公共前置：取出**用户名的安全形态**
 * @description
 * 路径优先于 body：`PUT /api/users/alice` 的用户名在路径上，body 里再写一个 `username`
 * 就是「两个入口说同一件事」——本模块**不许** body 覆盖路径上的值（那正是「改的是 A、
 * 以为改的是 B」那类事故的形状）。故 `body.username` 若存在且与路径不同即报错。
 *
 * @param ctx - 请求上下文
 * @returns 用户名的安全形态
 * @throws {OpsError} `invalid`
 */
export function usernameFromPath(ctx: RequestContext): string {
  const raw = ctx.params.username;
  if (raw === undefined) {
    throw new OpsError("invalid", "请求路径里没有 :username 段");
  }
  return requireSafeUsername(raw);
}

/**
 * 取出**新建账号**的入参（`POST /api/users`）
 * @description
 * 必填 `username` 与 `password`；其余字段原样透传给 ops 的 `AccountPatch` 词汇
 * （`quotaBytes` / `quotaWindow` / `expiresAt` / `disabled` / `targetWhitelist` /
 * `targetBlacklist`）。**不认识的键直接拒**（而不是静默忽略）——静默忽略拼错的字段正是
 * 本仓最恨的形状：调用方以为改了配额，实际什么都没改。
 *
 * @param ctx - 请求上下文
 * @returns 用户名、密码、以及剩余的 patch 字段
 * @throws {OpsError} `invalid`：缺字段 / 类型不符 / 出现未知键
 */
export function accountCreateInput(ctx: RequestContext): {
  readonly username: string;
  readonly password: string;
  readonly patch: Record<string, unknown>;
} {
  const body = requireObjectBody(ctx);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "username" || k === "password") {
      continue;
    }
    patch[k] = v;
  }
  return {
    username: requireSafeUsername(requireStringField(body, "username")),
    password: requireStringField(body, "password"),
    patch,
  };
}

/**
 * 取出**改一条账号**的入参（`PUT /api/users/:username`）
 * @description
 * 用户名**只**从路径取；body 里出现的 `username` 必须与路径逐字相同（不同即拒）。
 * 空 patch 拒绝：ops 的 `setAccount` 会把「一个字段都没给」当成「整条重写」，而那与
 * 「不改」在磁盘上**逐字相同**——调用方却拿到一条「已更新」。故这里先拒。
 *
 * @param ctx - 请求上下文
 * @returns 用户名 + patch 字段
 * @throws {OpsError} `invalid`
 */
export function accountUpdateInput(ctx: RequestContext): {
  readonly username: string;
  readonly patch: Record<string, unknown>;
} {
  const username = usernameFromPath(ctx);
  const body = requireObjectBody(ctx);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "username") {
      if (v !== username) {
        throw new OpsError(
          "invalid",
          `路径里的 username（${username}）与请求体的 username 不一致；本端点以路径为准`,
        );
      }
      continue;
    }
    patch[k] = v;
  }
  if (Object.keys(patch).length === 0) {
    throw new OpsError("invalid", "至少要给一个要改的字段（空 patch 不会改任何东西）");
  }
  return { username, patch };
}

/** 名单写面认识的三个字段（组 / 方向 / 条目），三个都必填 */
const ACL_KEYS = new Set(["group", "list", "entry"]);

/**
 * 取出**名单写**的入参（`POST` 加一条 / `DELETE` 移一条）
 * @description
 * 三个字段全部必填且**都不许为空**。`entry` 额外过 {@link requireSafeAclEntry}（它会被写进
 * 名单文件，故判据与 username **不同**——见文件头「两份字符集」）；`group` / `list` 交由 ops 判
 * 闭集（组名 → 键的映射是**数据的词汇**，归 ops）。查询串形态（`DELETE` 用 body 更自然，但两者
 * 都收）由 {@link aclMutationInput} 处理。
 *
 * @param source - 字段来源（请求体或查询串）
 * @returns 三元组
 * @throws {OpsError} `invalid`：缺字段 / 未知字段 / 形状不合法
 */
function aclFieldsFrom(
  source: Record<string, unknown>,
  origin: string,
): { readonly group: string; readonly list: string; readonly entry: string } {
  const unknownKeys = Object.keys(source).filter((k) => !ACL_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new OpsError(
      "invalid",
      `${origin} 里有未知字段：${unknownKeys.join("、")}；本端点只认 ${[...ACL_KEYS].join(" / ")}`,
    );
  }
  return {
    group: requireStringField(source, "group"),
    list: requireStringField(source, "list"),
    entry: requireSafeAclEntry(requireStringField(source, "entry")),
  };
}

/**
 * 取出名单写的入参：**请求体优先，其次查询串**
 * @description
 * 两者都收是刻意的：`DELETE` 带 body 在浏览器与部分 HTTP 客户端上不可用（`fetch` 的
 * DELETE 有 body，但很多工具的 `-X DELETE -d ...` 会把它丢掉），而名单条目天然适合放
 * 查询串。⚠️ **两者同时给且不一致即拒**（不是「body 赢」）——那正是「我以为删的是 A、
 * 实际删的是 B」那条事故的形状。
 *
 * @param ctx - 请求上下文
 * @returns 三元组
 * @throws {OpsError} `invalid`
 */
export function aclMutationInput(ctx: RequestContext): {
  readonly group: string;
  readonly list: string;
  readonly entry: string;
} {
  const fromQuery: Record<string, unknown> = {};
  for (const [k, v] of ctx.query.entries()) {
    fromQuery[k] = v;
  }
  const hasQuery = Object.keys(fromQuery).length > 0;
  const hasBody = typeof ctx.body === "object" && ctx.body !== null && !Array.isArray(ctx.body);

  if (hasQuery && hasBody) {
    const bodyFields = aclFieldsFrom(ctx.body as Record<string, unknown>, "请求体");
    const queryFields = aclFieldsFrom(fromQuery, "查询串");
    for (const k of ACL_KEYS) {
      if (bodyFields[k as keyof typeof bodyFields] !== queryFields[k as keyof typeof queryFields]) {
        throw new OpsError(
          "invalid",
          `查询串与请求体的 ${k} 不一致；两者只给一种，或给成一样的`,
        );
      }
    }
    return bodyFields;
  }
  if (hasBody) {
    return aclFieldsFrom(ctx.body as Record<string, unknown>, "请求体");
  }
  if (hasQuery) {
    return aclFieldsFrom(fromQuery, "查询串");
  }
  throw new OpsError(
    "invalid",
    `请求体或查询串至少要给一个：${[...ACL_KEYS].join(" / ")}`,
  );
}
