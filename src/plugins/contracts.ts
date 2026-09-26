/**
 * @fileoverview 插件契约全集 - 每个能力域一个 Provider 接口 + 一个注册表
 * @module plugins/contracts
 * @description
 * 「万物为插件」的操作性定义就在本文件：**每个能力域声明一个 Provider 接口
 * （API 形状），若干实现注册进同形状的注册表（可替换），组合根按配置/预设
 * 决定挂哪些实现并排出加载顺序。**
 *
 * ```
 * 能力域            契约              注册表键            现有实现 → 目标实现
 * ─────────────────────────────────────────────────────────────────────────
 * 配置              ConfigProvider    （无，实例唯一）      initConfig 产出的 scope
 * 日志              LoggerProvider    （无，实例唯一）      每实例一个 Logger
 * 鉴权              AuthProvider      AuthType            none/basic/jwt/uid 各一个
 * 访问控制          AccessControlProvider （无，实例唯一）  acl.json 判定
 * 路由              RoutingProvider   （无，实例唯一）      直连/上游决策
 * 传输              ForwarderProvider ForwardTransport     direct/http-upstream/socks-upstream
 * 入站协议          ProtocolProvider  ProxyProtocol        http/https/socks4/5/sockss4/5
 * 集群              ClusterProvider   （CLI 边界）          Node cluster 编排
 * ```
 *
 * 三条硬约束（破坏任一即退回「换汤不换药」）：
 *
 * 1. **注册表是唯一的可替换性来源**。禁止再出现「按枚举 switch 建实例」
 *    （`core/server/factory.ts` 的六路 switch）或「类字段里 `new` 死实现」
 *    （`forward/*.ts` 的 `new XxxForwarder(sink)`）——那两处正是 v5 遗产里
 *    「加一种要改核心源码」的病根。
 *
 * 2. **Provider 不许读全局**。所有配置经 `ConfigScope` 显式注入，所有本实例
 *    事实经构造参数注入。此前 `utils/log/level.ts` 无参调 `currentLevel()`、
 *    `proxy-helpers.isSelfLoop()` 内部 `get("host")`，都是这条的反例。
 *
 * 3. **注册表只做「按键取实现」，不承载生命周期**。资源创建/释放一律
 *    `ctx.effect()`（Cordis fiber），注册表只是不可变查找表——这样同一份
 *    注册表可以被多个 Context 共享而互不干扰，符合多实例诉求。
 *
 * 加载顺序由 Cordis 的 `inject` 声明式依赖表达（被依赖者先就绪），不靠注册
 * 顺序猜测、不靠字符串 type 比较。
 *
 * @example
 * ```ts
 * const forwarders = createPluginRegistry<ForwardTransport, ForwarderProvider>([
 *   [ "direct-stream",   new DirectStreamForwarderPlugin() ],
 *   [ "http-upstream",   new HttpUpstreamForwarderPlugin() ],
 *   [ "socks-upstream",  new SocksUpstreamForwarderPlugin() ],
 * ]);
 * const chosen = forwarders.require(plan.transport); // 换策略 = 换注册项，不改调用方
 * ```
 */

import type { AppConfig, ConfigKey } from "@/config/types.js";
import type { ConfigScope } from "@/config/scope.js";
import type { LogLevel } from "@/utils/log/level.js";
import type { Logger } from "@/utils/log/logger.js";
import type {
  AclDecision,
  AclReason,
  AclScope,
  UpstreamRouteDecision,
} from "@/config/resources/acl/eval.js";
import type {
  AuthAccount,
  AuthContext,
  AuthResult,
  ProxyCore,
  ProxyOptions,
  ProxyProtocol,
} from "@/core/types/proxy.js";
import type {
  ForwarderContext,
  ForwardTransport,
  RoutingInput,
  RoutingOutcome,
} from "@/core/types/plan.js";

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/**
 * 插件注册表 - 「同类插件、不同实现、相同 API」的唯一载体
 * @description
 * 不可变查找表：构造时灌入实现，之后只读。**刻意不承载生命周期**——
 * 资源的创建/清理由 Cordis `ctx.effect()` 负责，注册表只回答「这个键对应
 * 哪个实现」。这样一个注册表可以被多个 Context（多实例）共享而不串味。
 *
 * @typeparam K - 插件身份键（协议标识 / 传输策略 / 鉴权类型…）
 * @typeParam V - 该身份对应的实现，必须满足对应能力域的 Provider 接口
 * @example forwarders.require("socks-upstream")
 */
export interface PluginRegistry<K extends string, V> {
  /** 取实现；未注册返回 undefined */
  get(key: K): V | undefined;
  /**
   * 取实现；未注册抛错。
   * 刻意与 `get` 分开：请求路径上的键缺失是**配置/装配错误**（fail-fast），
   * 静默回落默认值会把装配 bug 变成难查的运行时行为。
   */
  require(key: K): V;
  /** 该键是否已注册 */
  has(key: K): boolean;
  /** 已注册的全部键（供启动摘要与「哪些插件已挂载」事件） */
  keys(): K[];
}

/**
 * 构造插件注册表
 * @param entries - 键值对；重复键在构造期即抛错（装配错误必须早于运行暴露）
 * @throws 键重复
 */
export function createPluginRegistry<K extends string, V>(
  entries: ReadonlyArray<readonly [K, V]>,
): PluginRegistry<K, V> {
  const table = new Map<K, V>();

  for (const [key, value] of entries) {
    if (table.has(key)) {
      throw new Error(`插件注册表构建失败: 重复注册 ${String(key)}`);
    }
    table.set(key, value);
  }

  return {
    get: (key) => table.get(key),
    require: (key) => {
      const found = table.get(key);
      if (found === undefined) {
        throw new Error(`插件未注册: ${String(key)}（已注册: ${[...table.keys()].join(", ")}）`);
      }
      return found;
    },
    has: (key) => table.has(key),
    keys: () => [...table.keys()],
  };
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 配置重载结果：只报告实际变化的字段 */
export interface ConfigReloadResult {
  readonly changed: readonly ConfigKey[];
}

/**
 * 配置插件契约
 * @description
 * 每个实例**恰好一个**配置插件（配置天然是实例级唯一物，注册表在这里没有意义）。
 * 它是「活」的：`reload` 成功后 `scope.get()` 立刻看到新值，因此鉴权/ACL/路由
 * 的每请求读取自动获得热更新，不需要各自实现失效逻辑。
 */
export interface ConfigProvider {
  /** 本实例配置作用域；下游插件一律经它读值，禁止再有任何模块级读取入口 */
  readonly scope: ConfigScope;
  /** 全量快照（浅拷贝） */
  snapshot(): AppConfig;
  /** 事务式热重载 runtime 字段；startup 字段整批拒绝；失败保留旧值并抛出 */
  reload(patch: Partial<AppConfig>): Promise<ConfigReloadResult>;
  /** 字段生效阶段查询 */
  phaseOf(key: ConfigKey): "startup" | "runtime";
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

/**
 * 日志插件契约
 * @description
 * 每实例**恰好一个**。存在的理由很硬：日志等级与落盘路径此前是全局单例
 * （`utils/log/level.ts` 直接 `get("logLevel")`），同进程跑两个实例时，
 * A 实例调 debug 会把 B 也调成 debug。每实例一个 Logger 才能真正隔离。
 */
export interface LoggerProvider {
  /** 派生子日志器（`父:子` prefix），继承本实例的双通道等级与落盘基址 */
  child(prefix: string): LoggerProvider;
  /** 本实例的底层 logger（结构化字段、稳定事件码的唯一渲染路径） */
  readonly logger: Logger;
  /** 等齐本实例全部在途落盘；显式退出路径必须在 `process.exit` 前调用 */
  flush(): Promise<void>;
  /** 本实例控制台等级（供启动摘要与诊断输出） */
  readonly consoleLevel: LogLevel;
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

/** 鉴权类型标识 = 注册表键（与 `config/types.ts:AuthType` 同域，刻意独立命名以免配置层反向依赖插件层） */
export type AuthKind = "none" | "basic" | "jwt" | "uid";

/**
 * 鉴权插件契约
 * @description
 * 注册表键 = `AuthType`。`basic`/`jwt`/`uid` 各自是独立实现，
 * **新增一种鉴权方式（如 mTLS、OAuth introspection）= 往注册表加一项**，
 * 不再需要改 `core/auth.ts` 里的 type switch。
 *
 * 实现约定：`authenticate` 内部异常一律转 deny（不得把异常抛给数据面），
 * 审计经 `ctx.onAuthEvent` 上抛，插件自身零日志。
 */
export interface AuthProvider {
  /** 本实现的鉴权类型（注册表键回显，便于诊断与事件负载） */
  readonly kind: AuthKind;
  /** 鉴权总开关；关闭时实现可选择直接放行（但仍需过 `isEnabled` 判定入口） */
  readonly isEnabled: boolean;
  /** 校验一次请求；永不抛错，失败即 `passed: false` */
  authenticate(ctx: AuthContext): Promise<AuthResult>;
  /**
   * 判定一个 `Authorization` 头值是否为本代理自身的凭证（出站剥离用）。
   * 与 `authenticate` 共用判据是硬要求——两者漂移会让代理凭证泄漏到目标站。
   */
  isOwnCredential(value: string): boolean;
}

/**
 * 鉴权实现的构造参数
 * @description 鉴权实现与其它插件有一处关键差异：它**必须持有配置**
 * （账号表 / JWT 密钥），而配置是实例级的。因此注册表里存的是**工厂**而不是
 * 已配置实例——注册表本身保持无状态、可被任意多个实例共享，每个实例用自己
 * 的 scope 调工厂产出自己的实现。
 * @param accounts - 本实例账号表快照（视为只读）
 * @param jwtSecret - 本实例 JWT 密钥
 * @param enableLogging - 是否发鉴权审计事件
 */
export interface AuthFactoryOptions {
  readonly accounts: readonly AuthAccount[];
  readonly jwtSecret: string;
  readonly enableLogging: boolean;
}

/**
 * 鉴权插件工厂 - 注册表的值类型
 * @description 组合根按本实例的 `authType` 取工厂、传本实例配置、调出实现。
 * 「换一种鉴权」= 往注册表加一项（或整表替换），不碰任何既有代码。
 */
export type AuthProviderFactory = (options: AuthFactoryOptions) => AuthProvider;

// ---------------------------------------------------------------------------
// 访问控制
// ---------------------------------------------------------------------------

/**
 * 访问控制插件契约
 * @description
 * 每实例**恰好一个**（读本实例的 acl.json，并叠加各账号自己的名单）。三个判定入口保持
 * 分离而不是合成一个 `check(kind, value)`：判定**顺序**（clientIp → auth → target）
 * 是安全边界的一部分，合并成参数化调用后调用点就能随便换顺序。
 *
 * 三个方法都收**可选的 `user`**（已鉴权用户名）：它让同一份契约同时服务
 * 「全局名单」与「该账号自己的名单」两道闸门。`user` 缺省（未鉴权 / `AUTH_ENABLED=false`）
 * 表示**没有身份**——此时只判实例级名单。实现**不得**把两份名单的条目做 union/intersection
 * 再算一个总结果（那会丢掉「是哪一道拦下的」这个唯一有运维价值的事实），必须按固定顺序
 * 各判一次、任一命中即拒，并用 `AclDecision.scope` 如实报出来源。
 * 判定顺序与收口见 `config/resources/acl/resolve.ts`。
 */
export interface AccessControlProvider {
  /**
   * 客户端 IP 判定（按 TCP 对端地址；刻意不看 XFF——客户端可伪造）
   * @param user - 已鉴权用户名；无则只判实例级名单
   */
  checkClientIp(addr: string, user?: string): AclDecision;
  /**
   * 目标主机判定（客户端请求的目标，端口不参与）
   * @param user - 已鉴权用户名；无则只判实例级名单
   */
  checkTargetHost(host: string, user?: string): AclDecision;
  /**
   * 上游路由判定（仅 client 模式有意义；动作语义与上面两组相反）
   * @param user - 已鉴权用户名；无则只判实例级名单
   */
  checkUpstreamRoute(host: string, user?: string): UpstreamRouteDecision;
}

// ---------------------------------------------------------------------------
// 流量配额
// ---------------------------------------------------------------------------

/**
 * 流量计量窗口（`users.json` 内联 `quota.period` 的取值）
 * @description
 * `total` = 进程生命周期累计，**不是**跨重启的终身额度：计量状态活在进程内存里，
 * 重启即归零。四个取值都不跨重启（`hourly`/`daily`/`monthly` 靠窗口起点判定自然翻页，
 * 翻页同样是进程内状态）。
 */
export type QuotaPeriod = "hourly" | "daily" | "monthly" | "total";

/**
 * 配额判定结果（建链前的准入）
 * @param allowed - 是否放行；`false` 表示该账号在当前窗口内已用尽
 * @param limit - 该账号的窗口上限字节数（无配额账号恒 `undefined`）
 * @param used - 判定时刻该窗口内已用字节数
 */
export interface QuotaReservation {
  allowed: boolean;
  limit?: number;
  used?: number;
}

/**
 * 配额用量只读快照（启动摘要 / 诊断）
 * @param used - 当前窗口内已用字节数
 * @param limit - 窗口上限字节数
 * @param period - 计量窗口
 * @param windowStart - 当前窗口起点（epoch 毫秒；`total` 为进程启动时刻）
 */
export interface UsageSnapshot {
  used: number;
  limit: number;
  period: QuotaPeriod;
  windowStart: number;
}

/**
 * 流量配额插件契约
 * @description
 * 每实例**恰好一个**。它与 `AccessControlProvider` 分开而不是合并，理由是**有状态**：
 * 名单判定是纯函数（同一输入恒同一输出、可任意并发调用），配额必须跨请求累计——
 * 把累计状态塞进访问控制插件会让那三个判定方法不再是纯判定，也没法替换存储实现
 * （内存 / 未来的文件 / Redis）。它只被入站侧「拨号前准入」与「会话结束记账」两个点调用。
 *
 * 两条**刻意的不做**（避免做出「看起来在限制、实际限制不住」的东西）：
 * - **不掐进行中的传输**：只在 `reserve` 阶段拒绝**新**请求，已建链的会话不因超额被 destroy
 *   （那会让下载场景在「配额还剩 1MB」时把传输拦腰砍断）。总量配额在物理上无法预估单请求大小，
 *   因此只能做准入判定。
 * - **不提供速率限制**：`rate`/令牌桶是另一个维度（时间窗内的瞬时速率），与总量正交；
 *   混进同一契约只会让人说不清是哪个在起作用。要速率限制应新增一种实现而不是给本契约加字段。
 */
export interface UsageProvider {
  /**
   * 建链前准入：额度已用尽则拒绝（调用方回 429 + `[quota-exhausted]` 事实）
   * @param user - 已鉴权用户名；无身份或该账号无配额时恒放行
   */
  reserve(user: string | undefined): QuotaReservation;
  /**
   * 会话结束记账：把本次实际传输的字节数归属到该用户
   * @param user - 已鉴权用户名；无身份或该账号无配额时是 no-op
   * @param bytes - 本次会话的字节数（入站 + 出站，口径见 `core/forward/meter.ts`）
   */
  settle(user: string | undefined, bytes: number): void;
  /**
   * 取某账号的用量快照（只读；无配额账号返回 `undefined`）
   * @param user - 已鉴权用户名
   */
  snapshot(user: string): UsageSnapshot | undefined;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/**
 * 路由插件契约 - 「走直连还是走上游」的唯一决策入口
 * @description
 * 这是本轮重构最关键的一刀。此前 `resolveRoute()` / `resolveForwardTargets()`
 * 既是决策者又现场 `get("proxyMode")` / `get("upstreamHost")` / `get("upstreamPort")`，
 * 于是「选上游」与「连上游」死锁在同一处，既换不掉路由策略，也无法让同进程
 * 两个实例走不同上游。
 *
 * 契约收紧为：输入 `RoutingInput`，输出**自包含**的 `ForwardPlan`（或拒绝）。
 * 路由插件**不碰 socket、不碰字节流**——只做判定。
 */
export interface RoutingProvider {
  /** 决策一次转发；返回计划或拒绝，调用方穷尽两种分支 */
  plan(input: RoutingInput): RoutingOutcome;
}

// ---------------------------------------------------------------------------
// 传输
// ---------------------------------------------------------------------------

/**
 * 转发策略插件契约 - 注册表键 = `ForwardTransport`
 * @description
 * 「转发器只处理『拿到已决定的目标后怎么搬字节』」的落点。
 * 不变量：
 * - **不读配置**：上游地址/超时/凭证全在 `plan` 里冻结完毕
 * - **不认协议**：应答经 `ctx.responder`（由入站协议插件注入），因此同一个
 *   策略实现可同时服务 http/tunnel/upgrade/socks 四种入站
 * - **不做决策**：超时/拒绝/目标非法一律发 `emit` 事实，成败应答交给调用方
 * - 不抛未处理异常；失败经 `ctx.responder.fail()` 收尾
 */
export interface ForwarderProvider {
  /** 传输策略标识（注册表键回显） */
  readonly transport: ForwardTransport;
  /** 执行一次转发；resolve 表示「计划已执行完毕」，协议应答由本实现调 responder 发出 */
  forward(ctx: ForwarderContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// 入站协议
// ---------------------------------------------------------------------------

/**
 * 协议插件的构造依赖 - 由组合根一次性备齐并注入
 * @description
 * 刻意**显式列字段**而不是塞一个 `ctx`/service locator：协议插件是唯一需要
 * 编排全栈的一层，它理应知道所有依赖；而转发器/鉴权等底层插件只拿自己那几项。
 */
export interface ProtocolDeps {
  /** 本实例配置作用域 */
  readonly config: ConfigProvider;
  /** 本实例日志器 */
  readonly logger: LoggerProvider;
  /** 鉴权（按配置从注册表选出的那一个实现） */
  readonly auth: AuthProvider;
  /** 访问控制 */
  readonly acl: AccessControlProvider;
  /** 流量配额（拨号前准入 + 会话结束记账） */
  readonly usage: UsageProvider;
  /** 路由决策 */
  readonly routing: RoutingProvider;
  /** 传输策略注册表（按 `plan.transport` 取实现） */
  readonly forwarders: PluginRegistry<ForwardTransport, ForwarderProvider>;
}

/**
 * 入站协议插件契约 - 注册表键 = `ProxyProtocol`
 * @description
 * 职责被刻意收窄为**协议适配与服务生命周期**：监听端口、解析协议、回协议应答。
 * 用户/鉴权/ACL/路由/日志策略一概不归它管（那些是别的插件）。
 * 新增第 7 种协议 = 实现本接口 + 往注册表加一项，**不改任何既有代码**。
 */
export interface ProtocolProvider {
  /** 协议标识（注册表键回显） */
  readonly protocol: ProxyProtocol;
  /** 是否 TLS 承载（决定装配时是否需要证书，以及 SOCKS 会话 tag） */
  readonly secure: boolean;
  /** 按依赖装配一个可启停的内核实例；返回的实例自行管理 listener 与连接集合 */
  create(options: ProxyOptions, deps: ProtocolDeps): ProxyCore;
}

// ---------------------------------------------------------------------------
// 集群
// ---------------------------------------------------------------------------

/** 集群角色 */
export type ClusterRole = "master" | "worker" | "standalone";

/**
 * 集群插件契约
 * @description
 * 集群是**进程级**编排而非实例级能力，因此不进协议/转发注册表：它在 CLI
 * 边界决定「本进程要起哪几个实例」，master 只管 worker 生命周期与 IPC。
 * 放在契约里是为了让「实例 × worker」的乘法关系有一处显式声明，而不是散在
 * `cluster.ts` 的 fork 循环里。
 */
export interface ClusterProvider {
  /** 本进程角色 */
  readonly role: ClusterRole;
  /**
   * 规划「本 worker 要起哪几个实例」。
   * @param workerCount - 总 worker 数（1 = 不启用 cluster）
   * @param workerIndex - 本 worker 序号（standalone/master 恒为 0）
   * @param requested - 请求的实例描述（来自预设/配置）
   */
  planInstances(
    workerCount: number,
    workerIndex: number,
    requested: readonly InstanceRequest[],
  ): readonly ResolvedInstance[];
}

/** 实例请求（来自预设或配置，尚未绑定端口/角色） */
export interface InstanceRequest {
  readonly name: string;
  readonly protocol: ProxyProtocol;
  readonly overrides: Partial<AppConfig>;
}

/** 解析后的实例（端口已分配、配置已合并） */
export interface ResolvedInstance {
  readonly name: string;
  readonly options: Required<Pick<AppConfig, "proxyProtocol" | "host" | "port">>;
  readonly overrides: Partial<AppConfig>;
}

export type { AclReason, AclScope };
export type { AclDecision, UpstreamRouteDecision } from "@/config/resources/acl/eval.js";
