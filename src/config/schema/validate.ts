/**
 * 只做「已经解析成标量之后还差什么」的判断，因此只依赖字段表的 `int` 元数据，
 * 不认识 env 文件与 argv。所有函数是纯函数且**不抛业务异常以外的意外**：
 * 非法一律抛 `配置校验失败: ...`，调用方（loadConfig）无需再翻译错误。
 */

import { FIELDS } from "./fields.js";

/**
 * 一个 origin 里的 host：域名（**首尾**必须是字母数字）/ IPv4 / `[IPv6]`
 * @description 逐字符判而不是 `[^/]+`：`user:pw@a.com`、带尾点的 `a.com.`、带下划线的
 * `_a.com` 都会从「看不出问题的串」里滑过去，而它们匹配不上任何浏览器规范化后的 origin。
 */
const ORIGIN_HOST = "(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)";

/**
 * 一个 origin 里的端口，限定 **1-65535**
 * @description 逐段写六支而不是 `\d{1,5}`：后者会放过 `99999`，而那个 origin **永远匹配不上**
 * 任何浏览器发来的 `Origin` —— 症状是「跨源 GUI 连不上」，与「白名单写错了」之间没有任何
 * 可观察的区别。同理前导零（`http://a.com:08080`）被拒：URL 规范化会把它归一成 `8080`，
 * 那个串同样永不命中。启动期中止的成本远低于这两种静默失败。
 *
 * 六支覆盖 `1-65535` 全程且互不越界：`6553[0-5]`(65530-65535) / `655[0-2][0-9]`(65500-65529) /
 * `65[0-4][0-9]{2}`(65000-65499) / `6[0-4][0-9]{3}`(6000-64999) / `[1-5][0-9]{3,4}`(1000-59999) /
 * `[1-9][0-9]{0,2}`(1-999)。全部以 `[1-9]` 起头 ⇒ 前导零天然被拒。
 *
 * ⚠️ **冒号必须包在交替组的外面**（`(?::(?:A|B|C))?` 而不是 `(?:A|B|C)?`）：`(?:A|B)` 只包住
 * 「第一支到最后一个 `|` 之间」，所以写在第一支**前面**的 `:` 属于第一支 —— 后面的支会漏掉它，
 * 于是除第一支外所有端口都少一个 `:` 而整段永不命中。症状是「绝大多数合法 origin 被拒、而报错
 * 报文看不出哪里不对」：判据自己坏掉时长得最像「用户写错了」。
 */
const ORIGIN_PORT = "(?:(?::(?:6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{3,4}|[1-9][0-9]{0,2})))?";

/**
 * 一个 origin 的形态：`scheme://host[:port]`，无路径 / 无凭据 / 无尾斜杠
 * @description scheme 只允许 `http` / `https`：`file://` 页面的 origin 是字面量 `null` 而不是
 * `file://…`，故给 `file` 写一条白名单等于写一条永不命中的条目（症状：以为放行了本地页面，
 * 实际浏览器按 `null` 来问，而那条永远不在名单里）。
 */
const ORIGIN_ATOM = `https?://${ORIGIN_HOST}${ORIGIN_PORT}`;

/**
 * `MANAGER_CORS_ORIGINS` 整项的形态：空串（= 不放行）或「若干 origin 逗号分隔，容忍空白」
 * @description `i` 标志让 scheme 与 host 大小写不敏感（RFC 6454：origin 没有大小写敏感的
 * 成分），与 `cors.ts` 的小写化归一是同一件事的两端 —— 配置端容忍大小写混写，运行期端
 * 保证比对与回显都在小写形态上。
 */
const CORS_ORIGINS_SHAPE = new RegExp(
  `^\\s*(?:${ORIGIN_ATOM}(?:\\s*,\\s*${ORIGIN_ATOM})*)?\\s*$`,
  "i",
);

/**
 * @description 遍历 FIELDS 的 `int` 约束，对已出现在 resolved 表中的字段检查整数性与上下界，
 * 返回 `ENV=value` 形式的越界清单（空数组表示全部合法）；未出现在表中的字段跳过（只校验显式给出的键）
 * @param resolved - 已解析的字段表（键为 `ConfigKey`）
 * @returns 越界字段的 `ENV=value` 列表
 * @example collectIntRangeErrors({ port: 70000 }) // => ["PORT=70000"]
 */
export function collectIntRangeErrors(resolved: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const d of FIELDS) {
    if (d.int === undefined || !(d.key in resolved)) {
      continue;
    }
    const v = resolved[d.key] as number;
    const { min, max } = d.int;
    if (!Number.isInteger(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
      bad.push(`${d.env}=${v}`);
    }
  }
  return bad;
}

/**
 * @description 遍历 `FIELDS`，对 `source(env)` 返回的每个已给出的原始值调用字段的 `parse`：
 * 成功写入 `resolved[d.key]`，失败记入 `bad`（`ENV=value` 形式，空数组表示全部合法）；
 * 只收录显式提供的键——默认值回退与抛错留给调用方各自的后处理
 * （loadConfig 补 def/defaults 并另带文件错误消息）
 * @param source - 按 env 名取原始值的回调（返回 undefined 表示未提供）
 * @returns 已解析字段表 `resolved` 与非法项清单 `bad`
 * @example resolveFieldEntries((env) => rawCli[env] ?? explicitEnv[env] ?? fileEnv[env])
 */
export function resolveFieldEntries(source: (env: string) => string | undefined): {
  resolved: Record<string, unknown>;
  bad: string[];
} {
  const resolved: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const d of FIELDS) {
    // 显式给出的值（CLI 优先于 env）一律不允许静默丢弃：解析失败记入 bad，由调用方统一抛错
    const raw = source(d.env);
    if (raw === undefined) {
      continue;
    }
    const parsed = d.parse(raw);
    if (parsed === undefined) {
      bad.push(`${d.env}=${raw}`);
      continue;
    }
    resolved[d.key] = parsed;
  }
  return { resolved, bad };
}

/**
 * 交叉字段校验：开启鉴权时的组合必须能真正拦人（fail-closed，任一项不成立即阻止启动）
 * @description
 * - `authEnabled + none`：开了鉴权却不选方式 = 全部放行，属自相矛盾配置
 * - `authEnabled + basic/uid + 账号表为空`：无账号可比对时一律判否是徒劳的「拒绝一切」，
 *   真正原因是 AUTH_USERS_FILE 没配好（路径写错/文件为空），必须让启动失败而不是静默全拒
 * - `authEnabled + jwt + 空 JWT_SECRET`：无密钥的 JWT 校验没有意义
 * 抽成导出的纯函数便于单测（无需起子进程）。
 * @param cfg - 待校验组合（authEnabled / authType / accountCount / jwtSecret）
 * @throws {Error} 配置非法时抛 `配置校验失败: ...`
 * @example assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 0 }); // throws
 * @example assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 2 }); // ok
 */
export function assertAuthConfig(cfg: {
  authEnabled: boolean;
  authType: string;
  accountCount: number;
  jwtSecret?: string;
  /**
   * 账号表当前生效的**数据来源**。
   * @description 决定报错文案点名哪个键。`AUTH_USERS_FILE` 与 `AUTH_USERS_DB` 是**互斥生效**的
   * （驱动选哪个就读哪个），报错把运维指到一个**根本没被读**的键上，比不报错更坏：他会去检查
   * 那个文件、改它、然后发现毫无变化。与 `load.ts` 里「报错文案点名实际生效的那个路径」同一条纪律。
   */
  usersDriver?: string;
}): void {
  if (!cfg.authEnabled) {
    return;
  }
  if (cfg.authType === "none") {
    throw new Error(
      "配置校验失败: AUTH_ENABLED=true 但 AUTH_TYPE=none（不会校验任何凭证）；确需关闭鉴权请设 AUTH_ENABLED=false",
    );
  }
  if ((cfg.authType === "basic" || cfg.authType === "uid") && cfg.accountCount === 0) {
    // 键名跟着驱动走：sqlite 档下 `AUTH_USERS_FILE` 压根没被读，指过去等于把运维带偏。
    const usersKey = cfg.usersDriver === "sqlite" ? "AUTH_USERS_DB" : "AUTH_USERS_FILE";
    const what = cfg.usersDriver === "sqlite" ? "账号库里至少有一个账号" : "指向的文件是否存在且至少配置一个账号";
    throw new Error(
      `配置校验失败: 账号表为空（AUTH_ENABLED=true 且 AUTH_TYPE=${cfg.authType}）；请检查 ${usersKey} ${what}`,
    );
  }
  if (cfg.authType === "jwt" && !cfg.jwtSecret) {
    throw new Error("配置校验失败: JWT_SECRET 为空（AUTH_ENABLED=true 且 AUTH_TYPE=jwt）");
  }
}

/**
 * 管理面（控制面）的交叉字段校验：开着的那个面必须既占得到端口、也拦得住人
 * @description
 * - `managerPort === port`：两个 listener 抢同一个端口必然 EADDRINUSE，而那发生在**数据面
 *   已经在服务之后**，运维看到的是一次运行期崩溃而不是一条配置错误。0 是 `listen(0)` 的
 *   「由系统分配」语义（绕开 `loadConfig` 的 library 调用方能拿到这种值），两个 0 各自分配，
 *   不是冲突。
 *   判据**不看 `managerEnabled`**：范围校验也不看。把它藏到启用那天再炸，运维会归因成
 *   「我今天开了个开关结果进程起不来」，而真正的原因是那两项配置早就自相矛盾。
 * - `managerEnabled + 空 token`：这个面能读全量配置、增删账号与名单，空 token 等于「任何能
 *   连到该端口的人都是管理员」。与 `authEnabled + jwt + 空 secret` 同一条纪律：不 fail-closed
 *   就等于不设防。
 * - `managerCorsOrigins` 逐条是不是合法 origin：**判据不看 `managerEnabled`**，与端口撞车同一条
 *   纪律。白名单写坏了而进程照常起，故障现象是「跨源 GUI 连不上」——而那个症状在浏览器那侧
 *   只是一句 `CORS policy`，运维没有任何线索指向「我那个环境变量写错了」。启动期中止把它变成
 *   一条指着那个键名的配置错误。
 *
 * ## 为什么白名单的语法判据在**这里**而不在 `parse`
 * @description `resolveFieldEntries` 对 `parse` 失败的键记 `bad` 并让启动中止，那对本仓大多数字段
 * 是对的；而白名单若也走那条路，「非法 origin」与「这个键没配」会共用同一条报错路径，而后者
 * 是合法的。判据留在组合校验里，于是 `parse: parseStr` 永不失败、空串是合法的「不放行」。
 *
 * ## 为什么**禁**通配 `*` 与 `null`
 * @description 两者都不是「一个站点」：`null` 是 `file://` 与 sandbox iframe 的 origin
 * （即任何本地文件都算一个），而 `*` 在有人拿它当「先开着回头再收紧」的一档时，恰好把这个
 * 能改账号与名单的面开放给任意网页上的任意脚本。禁掉比放行后告警好：放行后告警的那段时间里
 * 它已经开着了。
 *
 * @param cfg - 待校验组合（port / managerEnabled / managerPort / managerToken / managerCorsOrigins）
 * @throws {Error} 配置非法时抛 `配置校验失败: ...`
 * @example assertManagerConfig({ port: 3000, managerEnabled: true, managerPort: 3010, managerToken: "", managerCorsOrigins: "" }); // throws
 * @example assertManagerConfig({ port: 3000, managerEnabled: true, managerPort: 3010, managerToken: "s3cr3t", managerCorsOrigins: "http://127.0.0.1:5173" }); // ok
 */
export function assertManagerConfig(cfg: {
  /** 数据面监听端口（`PORT`） */
  port: number;
  managerEnabled: boolean;
  managerPort: number;
  managerToken: string;
  /** 逗号分隔的精确 origin 列表；空串 = 不放行（合法） */
  managerCorsOrigins: string;
}): void {
  if (cfg.managerPort !== 0 && cfg.port !== 0 && cfg.managerPort === cfg.port) {
    throw new Error(
      `配置校验失败: MANAGER_PORT=${cfg.managerPort} 与 PORT=${cfg.port} 相同`
        + "（同一个端口上 bind 两个 listener 必然 EADDRINUSE）；请把 MANAGER_PORT 改成别的空闲端口",
    );
  }
  if (cfg.managerEnabled && !cfg.managerToken) {
    throw new Error(
      "配置校验失败: MANAGER_TOKEN 为空（MANAGER_ENABLED=true）"
        + "；管理面能读全量配置、增删账号与名单，空 token = 任何能连上该端口的人都是管理员。"
        + "请设 MANAGER_TOKEN=<随机串>（例：openssl rand -hex 32），确实不用这个面就设 MANAGER_ENABLED=false",
    );
  }
  if (!CORS_ORIGINS_SHAPE.test(cfg.managerCorsOrigins)) {
    throw new Error(
      "配置校验失败: MANAGER_CORS_ORIGINS 不是「逗号分隔的 origin 列表」"
        + `\n  实际值：${cfg.managerCorsOrigins}`
        + "\n  每条必须逐字是 http://host[:port] 或 https://host[:port]，即："
        + "\n    - 不得带路径 / 查询串 / 尾斜杠（http://a.com/ 不合法，http://a.com 合法）"
        + "\n    - 不得写通配 *（控制面能改账号与名单，通配等于对任意网页开放）"
        + "\n    - 不得写 null（那是 file:// 与 sandbox iframe 的 origin，不是一个站点）"
        + "\n    - 不得带凭据（http://u:p@a.com）"
        + "\n  例：MANAGER_CORS_ORIGINS=http://127.0.0.1:5173,https://ops.example.com"
        + "\n  留空 = 不发任何 CORS 头（默认；同源部署或前置反代收口时不需要它）",
    );
  }
}
