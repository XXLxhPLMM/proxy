/**
 * @fileoverview 代理实例 - 库消费方的唯一入口，一个实例 = 一套完整隔离的状态
 * @module instance
 * @description
 * **库优先原则的落点。** 库消费方（不 spawn CLI、直接 `import`）拿到的是本文件
 * 导出的 `ProxyInstance`，而不是「进程 + 全局配置」。同进程可以创建任意多个实例，
 * 它们之间**不共享任何可变状态**：
 *
 * | 状态         | 隔离方式                                        |
 * | ------------ | ----------------------------------------------- |
 * | 配置         | 每个实例一份 `ConfigScope`，`reload` 只影响本实例 |
 * | 日志         | 每个实例一个 `Logger`，等级与落盘基址互不干扰    |
 * | 鉴权         | 每个实例按自己的 `authType` 从注册表选实现       |
 * | 访问控制     | 每个实例读自己的 `aclFile`                       |
 * | 路由/上游    | 每个实例用自己的 `upstreamHost`/`proxyMode`      |
 * | 连接集合     | 每个 `ProxyCore` 一份 `ConnRegistry`             |
 * | 资源 notice  | 每个实例一条 `subscribeConfigNotices` 订阅，`dispose()` 释放 |
 *
 * 进程退出（signal / `process.exit`）是**进程级**职责，不在实例内：实例默认
 * `allowProcessExit=false`，库消费方的进程绝不会被代理的 rollback/stop 路径杀掉。
 * 需要退出兜底的宿主（CLI）显式传 `allowProcessExit: true`。
 *
 * 装配顺序即依赖顺序（插件图的拓扑序）：
 * ```
 * ConfigScope → LoggerProvider → AccessControlProvider → RoutingProvider
 *             → ForwarderRegistry → AuthRegistry → ProtocolRegistry → ProxyCore
 * ```
 * 与 plan §3.1 的 `ConfigPlugin → LoggerPlugin → ErrorPolicyPlugin → User/Auth/
 * ACL/Routing/Forwarding → ProtocolPlugin` 一致：被依赖者先就绪，消费者后构建。
 * **加载顺序由依赖关系表达，不靠注册顺序或字符串比较猜测。**
 *
 * @example
 * ```ts
 * // 同进程两个实例：8080 走 basic 鉴权直连，9090 走 jwt 鉴权并串联上游
 * const a = createProxyInstance({ name: "edge-a", config: { port: 8080, authType: "basic" } });
 * const b = createProxyInstance({
 *   name: "edge-b",
 *   config: { port: 9090, authType: "jwt", proxyMode: "client", upstreamHost: "10.0.0.2" },
 * });
 * // 注意：start() 返回 Promise<void>，句柄要单独握住——解构 Promise.all 的结果是 undefined
 * await Promise.all([a.start(), b.start()]);
 * await a.reload({ authEnabled: false });   // 只改 a，b 的鉴权策略不受影响
 * await Promise.all([a.stop(), b.stop()]);
 * a.dispose(); b.dispose();                  // 释放实例级订阅（配置资源 notice）
 * ```
 */

import { createConfigScope, type ConfigScope } from "@/config/scope.js";
import { initConfig, prepareRuntimeConfig, type InitConfigOptions } from "@/config/load.js";
import { keysByPhase } from "@/config/schema/fields.js";
import { createInstanceLogger, type Logger } from "@/utils/log/logger.js";
import { checkClientIp, checkTargetHost, checkUpstreamRoute } from "@/config/resources/acl/eval.js";
import { subscribeConfigNotices } from "@/config/resources/notice.js";
import { readAuthUsers } from "@/config/resources/users/reader.js";
import { NoneAuthProvider } from "@/core/auth.js";
import { createProtocolRegistry } from "@/core/server/protocols.js";
import type { AppConfig } from "@/config/types.js";
import type { ProxyCore, ProxyProtocol } from "@/core/types/proxy.js";
import type { ForwardTransport } from "@/core/types/plan.js";
import { ProxyServer } from "@/server/index.js";
import { createAuthProviderRegistry } from "@/plugins/auth-providers.js";
import { createForwarderRegistry } from "@/plugins/forwarders.js";
import { createRoutingProvider } from "@/plugins/routing-provider.js";
import type {
  AccessControlProvider,
  AuthKind,
  AuthProvider,
  AuthProviderFactory,
  ConfigProvider,
  ConfigReloadResult,
  ForwarderProvider,
  LoggerProvider,
  PluginRegistry,
  ProtocolDeps,
  ProtocolProvider,
  RoutingProvider,
} from "@/plugins/contracts.js";

/** 实例构造选项 */
export interface ProxyInstanceOptions {
  /**
   * 实例标识。多实例时用于日志前缀与事件归属，缺省 `"proxy"`。
   * 它是**纯标识**：不进任何判定，也不影响端口/鉴权/路由。
   */
  readonly name?: string;
  /**
   * 本实例配置。缺省字段回退 `defaults`；这是**不读 env/CLI** 的直接构造路径，
   * 库消费方用它做「配置即代码」。需要走 env/CLI/preset 完整校验链请用
   * {@link createProxyInstanceFromEnv}。
   */
  readonly config?: Partial<AppConfig>;
  /**
   * 是否允许 server-owned 路径 `process.exit`（rollback hard-exit、stop hard-exit、
   * signal graceful）。默认 **false**：库消费方不会被代理的失败路径杀掉进程。
   * CLI 显式传 true 保留退出兜底。cluster 的 fork/IPC 不受此 gate 影响。
   */
  readonly allowProcessExit?: boolean;
  /**
   * 插件覆盖点。缺省用本文件装配的默认实现（6 个协议、3 个传输策略、4 种鉴权）。
   * 传入自定义实现即完成「替换某个能力而不改核心源码」——这正是插件化的验收点。
   */
  readonly plugins?: Partial<InstancePlugins>;
}

/** 一个实例可替换的插件集合 */
export interface InstancePlugins {
  /** 入站协议注册表（键 = ProxyProtocol） */
  readonly protocols: PluginRegistry<ProxyProtocol, ProtocolProvider>;
  /** 传输策略注册表（键 = ForwardTransport） */
  readonly forwarders: PluginRegistry<ForwardTransport, ForwarderProvider>;
  /** 鉴权注册表（键 = AuthKind，值为工厂；无状态可跨实例共享） */
  readonly auths: PluginRegistry<AuthKind, AuthProviderFactory>;
  /** 路由插件（单例） */
  readonly routing: RoutingProvider;
  /** 访问控制插件（单例） */
  readonly acl: AccessControlProvider;
}

/**
 * 代理实例句柄 - 库消费方持有的生命周期与配置视图
 * @description
 * 所有方法都是**实例级**的：没有 `ProxyInstance.get(key)` 这样的全局读取入口，
 * 配置只能经 {@link config} 作用域访问，从而在类型层面就杜绝「读到别人的配置」。
 */
export interface ProxyInstance {
  /** 实例标识 */
  readonly name: string;
  /** 本实例配置插件（唯一合法配置读取入口） */
  readonly config: ConfigProvider;
  /** 本实例日志插件 */
  readonly logger: LoggerProvider;
  /** 装配出的协议内核；`start()` 之前是未启动状态，`stop()` 之后仍可用于读统计 */
  readonly core: ProxyCore;
  /** 启动（幂等；停机在途时以 `ERR_PROXY_STOP_IN_PROGRESS` 拒绝） */
  start(): Promise<void>;
  /** 停止（幂等；重复调用复用同一轮等待视图） */
  stop(graceMs?: number): Promise<void>;
  /**
   * 等待真实 full stop 兑现。
   * `stop()` 的公开视图有界超时后，实例仍可能持有真实 core stop ownership；
   * 此时要重启必须先等它 settle，否则会撞上 `ERR_PROXY_STOP_IN_PROGRESS`。
   */
  waitForStopSettled(): Promise<void>;
  /**
   * 释放实例级订阅（当前只有配置资源 notice，即 `cfg/*.json` 热加载四态日志）
   *
   * **刻意不挂在 `stop()` 上**：订阅生命周期 = 实例生命周期（构造 → `dispose()`），
   * 所以 `start()` → `stop()` → `start()` 的重入期间资源 notice 始终在位，不存在
   * 「停了之后要重新订阅」这个中间态。库消费方自己管进程生命周期，不调 `dispose()`
   * 就等于把自己也留在资源事件总线的订阅者列表里。
   *
   * 终态操作且幂等：调用后本实例不再落盘资源四态 notice，若还要再 `start()` 请重建
   * 实例。**不**关停 core、不 flush 日志、不改任何配置（那些是 `stop()` 的事）。
   */
  dispose(): void;
  /** 事务式热重载 runtime 字段（startup 字段整批拒绝）；失败保留旧值并抛出 */
  reload(patch: Partial<AppConfig>): Promise<ConfigReloadResult>;
  /** 读取本实例协议内核（未启动为 null） */
  getCore(): ProxyCore | null;
  /**
   * 显式接管进程信号（`SIGINT`/`SIGTERM`，win32 另加 `SIGBREAK` + worker IPC shutdown）
   *
   * 进程信号是**进程级**资源：库消费方（把代理嵌进 web 服务器）有自己的 SIGINT 语义，
   * 代理默默抢走等于越权，所以本方法默认不调用、实例也全程不碰 `process` 的信号事件。
   * CLI（确实要让 Ctrl+C 停机的那一侧）在 `start()` **之前**显式调用即可。
   * 幂等；`stop()` 收口会摘掉 listener，之后可再次调用重新接管。
   */
  attachSignals(): void;
}

// ---------------------------------------------------------------------------
// 默认插件装配
// ---------------------------------------------------------------------------

/**
 * 配置插件工厂：把 `ConfigScope` 包成可 reload 的 Provider
 *
 * **刻意导出**（不进 `src/index.ts` 公共面）：cluster master 只做进程编排，不装配
 * 协议内核，但 `runAsMaster` 仍需要一份 `ConfigProvider` + `LoggerProvider`。让 CLI 在
 * master 分支复用这两个工厂，好过在 CLI 里另写一份适配器——那份适配器会成为第二份
 * reload 校验逻辑，而 reload 的真相源只能是 `prepareRuntimeConfig` + `scope.commit`。
 *
 * @param scope 本实例（或本进程）配置作用域
 */
export function createInstanceConfigProvider(scope: ConfigScope): ConfigProvider {
  return {
    scope,
    snapshot: () => scope.getAll(),
    async reload(patch) {
      // 候选构造与全部校验（含两个 JSON 资源强制重读）都在 loader 里，
      // 这里只负责事务提交与「实际变化」计算——不复制任何校验规则。
      const current = scope.getAll();
      const candidate = prepareRuntimeConfig(current, patch);
      const changed = (Object.keys(candidate) as (keyof AppConfig)[]).filter(
        (key) => !Object.is(candidate[key], current[key]),
      );
      if (changed.length === 0) {
        return { changed: Object.freeze([]) as readonly (keyof AppConfig)[] };
      }
      scope.commit(candidate);
      return { changed: Object.freeze(changed) };
    },
    phaseOf(key) {
      // 阶段是**静态表**信息，不随配置值变化，直接查字段表即可
      const phases = keysByPhase();
      if (phases.startup.includes(key)) {
        return "startup";
      }
      if (phases.runtime.includes(key)) {
        return "runtime";
      }
      throw new Error(`配置服务: 未知配置字段 ${String(key)}`);
    },
  };
}

/** 访问控制插件：本实例 aclFile 的三个判定入口。 */
function createAccessControlProvider(scope: ConfigScope): AccessControlProvider {
  return {
    // 每次现取路径：aclFile 是 runtime 字段，热重载后自动指向新文件
    checkClientIp: (addr) => checkClientIp(scope.get("aclFile"), addr),
    checkTargetHost: (host) => checkTargetHost(scope.get("aclFile"), host),
    checkUpstreamRoute: (host) => checkUpstreamRoute(scope.get("aclFile"), host),
  };
}

/**
 * 日志插件工厂：包住本作用域的 Logger，并把 child 收敛回 Provider 形态
 *
 * 与 {@link createInstanceConfigProvider} 同理由导出：master 分支要日志器但不要内核。
 *
 * @param scope 日志等级与落盘基址的真相源（活的，热重载自动跟随）
 * @param name 实例标识，出现在每行日志的 prefix 里
 */
export function createInstanceLoggerProvider(scope: ConfigScope, name: string): LoggerProvider {
  const root = createInstanceLogger(scope, { prefix: `[${name}]` });
  return {
    logger: root,
    consoleLevel: scope.get("logLevel"),
    child: (prefix) => {
      const childLogger = root.child(prefix);
      return {
        logger: childLogger,
        consoleLevel: scope.get("logLevel"),
        child: (nested) => createLoggerProviderFrom(childLogger, nested, scope),
        flush: () => childLogger.flush(),
      };
    },
    flush: () => root.flush(),
  };
}

function createLoggerProviderFrom(
  base: Logger,
  prefix: string,
  scope: ConfigScope,
): LoggerProvider {
  const child = base.child(prefix);
  return {
    logger: child,
    consoleLevel: scope.get("logLevel"),
    child: (nested) => createLoggerProviderFrom(child, nested, scope),
    flush: () => child.flush(),
  };
}

/** 按本实例的 authEnabled/authType 从注册表选出鉴权实现（配置错误在此 fail-fast）。 */
function selectAuthProvider(
  scope: ConfigScope,
  registry: PluginRegistry<AuthKind, AuthProviderFactory>,
): AuthProvider {
  const kind = scope.get("authType");
  if (!scope.get("authEnabled") || kind === "none") {
    return new NoneAuthProvider();
  }

  const accounts = readAuthUsers({ path: scope.get("authUsersFile") }).value;
  // 空账号表的 fail-fast 在 loader 的 assertAuthConfig 里已做过；这里是热重载后
  // 账号被清空的情形，同样必须显式拒绝而不是放行（否则等于静默全放行）。
  if ((kind === "basic" || kind === "uid") && accounts.length === 0) {
    throw new Error(`鉴权插件装配失败: ${kind} 需要非空账号表`);
  }

  return registry.require(kind)({
    accounts,
    jwtSecret: scope.get("jwtSecret"),
    enableLogging: scope.get("authLogging"),
  });
}

// ---------------------------------------------------------------------------
// 构造入口
// ---------------------------------------------------------------------------

/**
 * 创建一个代理实例（不读 env/CLI，不校验外部资源）
 *
 * 适合「配置即代码」的库消费方：配置以对象形式给出，缺省字段回退 `defaults`。
 * 需要 env/CLI/preset 的完整加载与交叉校验（以及 users.json / acl.json 的启动期
 * 强校验）请用 {@link createProxyInstanceFromEnv}。
 *
 * @param options - 实例选项
 * @returns 尚未启动的实例句柄；调 `start()` 才监听端口
 * @throws 配置字段未知、鉴权装配失败（账号表为空）等**装配期**错误
 * @example createProxyInstance({ name: "a", config: { port: 8080, proxyProtocol: "socks5" } })
 */
export function createProxyInstance(options: ProxyInstanceOptions = {}): ProxyInstance {
  const name = options.name ?? "proxy";
  const scope = createConfigScope(options.config);

  const configProvider = createInstanceConfigProvider(scope);
  const loggerProvider = createInstanceLoggerProvider(scope, name);

  // 配置资源 notice 订阅（唯一 notice 呈现路径，`resources/notice.ts`）：进程内
  // 总线是单例，订阅按实例创建，事件用**本实例**的 Logger 落盘。
  // 刻意早于任何资源读取安装：下面 `selectAuthProvider` 会读账号表，那一轮四态
  // 事件（error/missing/recovered/reloaded）也归本实例呈现。
  // 路径集合是函数而非数组：`authUsersFile`/`aclFile` 是 runtime 字段，reload 后
  // 指向新文件，现取才能判对归属（详见 notice.ts 的 `ConfigNoticeOptions`）。
  const disposeNotices = subscribeConfigNotices({
    logger: loggerProvider.logger,
    paths: () => [scope.get("authUsersFile"), scope.get("aclFile")],
  });

  try {
    const aclProvider = options.plugins?.acl ?? createAccessControlProvider(scope);
    const routingProvider = options.plugins?.routing ?? createRoutingProvider(scope, aclProvider);
    const forwarders =
      options.plugins?.forwarders ??
      (createForwarderRegistry() as PluginRegistry<ForwardTransport, ForwarderProvider>);
    const auths = options.plugins?.auths ?? createAuthProviderRegistry();

    const deps: ProtocolDeps = {
      config: configProvider,
      logger: loggerProvider,
      auth: selectAuthProvider(scope, auths),
      acl: aclProvider,
      routing: routingProvider,
      forwarders,
    };

    const protocols = options.plugins?.protocols ?? createProtocolRegistry();
    const coreOptions = {
      port: scope.get("port"),
      host: scope.get("host"),
      upstreamTimeout: scope.get("upstreamTimeout"),
    };
    // 协议内核由注册表按 proxyProtocol 选出；未知协议在 require() 处 fail-fast
    const protocolProvider = protocols.require(scope.get("proxyProtocol"));
    const core = protocolProvider.create(coreOptions, deps);

    const server = new ProxyServer({
      allowProcessExit: options.allowProcessExit === true,
      name,
      config: configProvider,
      logger: loggerProvider,
      acl: aclProvider,
      routing: routingProvider,
      auth: deps.auth,
      forwarders,
      protocols,
    });

    return {
      name,
      config: configProvider,
      logger: loggerProvider,
      core,
      start: async () => {
        await server.start();
      },
      stop: (graceMs?: number) => server.stop(graceMs),
      waitForStopSettled: () => server.waitForStopSettled(),
      dispose: disposeNotices,
      reload: (patch) => configProvider.reload(patch),
      getCore: () => server.getProxy(),
      attachSignals: () => server.attachProcessSignals(),
    };
  } catch (error) {
    // 装配失败（协议 require、鉴权空表）时没有人会调 dispose()：不释放等于让一个
    // 从未存在过的实例永远挂在进程内资源总线的订阅者列表上，还钉住它的 Logger 与 scope。
    disposeNotices();
    throw error;
  }
}

/** 从外部来源（env 文件 / CLI argv / preset）加载并创建实例的选项 */
export interface ProxyInstanceFromEnvOptions extends InitConfigOptions {
  readonly name?: string;
  /** 覆盖加载结果的字段（优先级：initConfig 结果 > 这里的覆盖值） */
  readonly overrides?: Partial<AppConfig>;
  readonly allowProcessExit?: boolean;
  readonly plugins?: Partial<InstancePlugins>;
}

/**
 * 走完整加载链（env 文件 → 终端 env → CLI argv → preset → defaults）后创建实例
 *
 * 校验强度与 CLI 启动完全一致：字段范围、UPSTREAM_URL 派生、users.json / acl.json
 * 的启动期强校验、auth 跨字段守卫（启用 basic/uid 但账号表为空即 abort）。
 *
 * **库消费方必须传 `argv: []`**（或显式给出自己的参数数组），否则宿主进程
 * （例如某个 web 服务器）的 argv 会被当作代理配置解析。
 *
 * @param options - 加载选项
 * @returns 尚未启动的实例句柄
 * @example createProxyInstanceFromEnv({ argv: [], overrides: { port: 9000 } })
 */
export function createProxyInstanceFromEnv(
  options: ProxyInstanceFromEnvOptions = { argv: [] },
): ProxyInstance {
  const scope = initConfig({ argv: options.argv });
  if (options.overrides !== undefined) {
    // 覆盖走同一个事务边界：缺字段由 commitConfig 报错，不留半批字段
    scope.commit({ ...scope.getAll(), ...options.overrides } as AppConfig);
  }
  return createProxyInstance({
    name: options.name,
    config: scope.getAll(),
    allowProcessExit: options.allowProcessExit,
    plugins: options.plugins,
  });
}
