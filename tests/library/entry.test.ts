import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http, { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as sourceEntryModule from "@/index.js";
import type {
  // —— 库门面 ——
  ProxyRuntime,
  ProxyRuntimeOptions,
  RuntimeContext,
  RuntimeContextOptions,
  RuntimeServices,
  RuntimeWarning,
  StartupPreset,
  // —— 配置 ——
  AppConfig,
  AuthType,
  CacheType,
  ConfigAccessor,
  ConfigChangeListener,
  ConfigContext,
  ConfigKey,
  ConfigSourceMetadata,
  ConfigStoreReader,
  CreateConfigContextOptions,
  FieldDef,
  LoadConfigOptions,
  LogLevel,
  PreparedRuntimeConfig,
  ProxyPreset,
  UserPolicy,
  UserPolicyList,
  // —— 事件 ——
  AppEventMap,
  EventContext,
  EventEnvelope,
  EventHubOptions,
  EventListener,
  EventName,
  EventScope,
  EventSubscription,
  // —— 日志 / TLS ——
  Logger,
  LoggerImpl,
  LogFields,
  TlsKeyCert,
  // —— 代理核心 ——
  CoreServices,
  Lifecycle,
  LifecycleState,
  PipeEvent,
  PipeEventSink,
  PipeEventType,
  ProxyCore,
  ProxyForwardKind,
  ProxyOptions,
  ProxyProtocol,
  ProxyStats,
  // —— 依赖承载体 ——
  CoreContext,
  // —— 可插值端口 ① 身份 ——
  AuthAccount,
  IdentityContext,
  IdentityOptions,
  IdentityProvider,
  IdentityRequestLike,
  IdentityResult,
  ProxyAuthEvent,
  AccountIdentityOptions,
  JwtIdentityOptions,
  // —— 可插值端口 ② 访问控制 ——
  AccessClientInput,
  AccessControl,
  AccessDecision,
  AccessRouteDecision,
  AccessRouteInput,
  AccessTargetInput,
  AclConfig,
  AclList,
  // —— 可插值端口 ③ 流量配额 ——
  FlushLoopHandle,
  JsonlTrafficLedgerOptions,
  LedgerEntry,
  QuotaResolver,
  QuotaWindow,
  RestoredLedger,
  RestoredUsage,
  TrafficAccount,
  TrafficDirection,
  TrafficLedgerController,
  TrafficLedgerError,
  TrafficScope,
  TrafficSink,
  TrafficUsage,
  TrafficVerdict,
  TrafficWindowSource,
  // —— 可插值端口 ④ 上游接入 ——
  ConnectorSource,
  OpenContext,
  OpenedUpstream,
  UpstreamConnector,
  UpstreamKind,
  // —— 进程级 API ——
  ProcessPolicy,
  ProcessStartupPreset,
  ProxyServerOptions,
  RunServerOptions,
  SignalHost,
} from "@/index.js";
// 值位置的 type-only import：`typeof` 用它来断言**工厂的第一个形参就是 `CoreContext`**。
// 只在类型位置使用，运行期零成本。
import type { createConnectorSource, createIdentityFromConfig } from "@/index.js";
import { getFreePort } from "../helpers/net.js";
import { codeOnly } from "../helpers/source-scan.js";

/**
 * The package is the public boundary. Keep this smoke test independent of
 * whether a developer has run `build:lib` yet: a stale or absent lib/ is
 * skipped for the packaged-entry assertions, while the source entry remains
 * the fallback facade.
 */
const packageRoot = path.resolve(__dirname, "../..");
const libEntryPath = path.join(packageRoot, "lib", "index.js");
const libTypesPath = path.join(packageRoot, "lib", "index.d.ts");
const hasLibFiles = fs.existsSync(libEntryPath) && fs.existsSync(libTypesPath);
const requireFromTest = createRequire(__filename);

type Entry = Record<string, unknown>;

/** entry 上 `createProxyRuntime` 的最小结构（库消费方视角，不依赖内部类型） */
interface RuntimeFactory {
  (options: { config: { host: string; port: number } }): {
    runtimeId: string;
    context: { store: { get: (key: "port") => number } };
    events: {
      subscribe: (
        name: "runtime.started",
        listener: (e: { context: { runtimeId: string } }) => void,
      ) => unknown;
      listenerCount: (name?: string) => number;
    };
    start: () => Promise<void>;
    stop: () => Promise<void>;
  };
}

const { mkdtempSync, rmSync } = fs;
const { tmpdir } = os;

/** 启一个本地 origin 并回其端口 */
function listenOnFreePort(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** 经代理发一次绝对 form 请求，读取完整响应体 */
function getViaProxy(proxyPort: number, originPort: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: `http://127.0.0.1:${originPort}${path}`,
        method: "GET",
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          res.statusCode === 200 ? resolve(body) : reject(new Error(`status=${res.statusCode}`)),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

/**
 * 「进程级动作」可能落在哪些 `process` 事件上（守卫安装、信号、退出兜底三处各自挑事件）。
 * 收敛成一张表是因为靠人记必然漏。
 */
const watchedProcessEvents = [
  "uncaughtException",
  "uncaughtExceptionMonitor",
  "unhandledRejection",
  "warning",
  "SIGINT",
  "SIGTERM",
  "SIGBREAK",
  "SIGHUP",
  "exit",
  "beforeExit",
  "message",
] as const;

/**
 * 从 `src/index.ts` 抽出**全部被导出的名字**（值与 type 都算）。
 *
 * 口径：先 `codeOnly`（去注释、留代码与字符串字面量），再匹配 `export { … } from` / `export type { … } from`
 * 的名字列表。**只认 export 语句里的标识符**——模块说明里点名旧名来解释「为什么不留兼容层」是
 * 文档，不是别名，所以绝不能因此变红（那会逼下一个人删掉解释性文档才能加回兼容层）。
 *
 * ⚠️ **必须取 `as` 之后的那一侧**（`export { A as B }` 的对外名是 `B`）。只取原侧会造出一条
 * **恒绿的假护栏**：`AuthProvider` 作为别名混进导出面而断言照样通过 —— 恰恰是「不留兼容层」
 * 最典型的违规形态。（这条是真踩出来的：第一次写成只取原侧，加了别名跑一遍仍然 12 passed。）
 */
function exportedNamesOf(sourceEntryPath: string): Set<string> {
  const code = codeOnly(fs.readFileSync(sourceEntryPath, "utf8"));
  const names = new Set<string>();
  const stmt = /export\s+(?:type\s+)?\{([^}]*)\}\s*from/g;
  for (let match = stmt.exec(code); match !== null; match = stmt.exec(code)) {
    for (const rawName of match[1].split(",")) {
      // `A as B` / `type A as B` / `A` 三种形态统一收敛到「对外那一侧」
      const sides = rawName.replace(/^\s*type\s+/, "").split(/\s+as\s+/);
      const name = sides[sides.length - 1]!.trim();
      if (name.length > 0) {
        names.add(name);
      }
    }
  }
  return names;
}

const sourceEntryPath = path.join(packageRoot, "src", "index.ts");

/**
 * 全部「应当出现在包入口的**类型**名」，运行期可枚举。
 *
 * @description 为什么必须是**真数组**而不是从 `keyof PublicTypeSurface` 派生：
 * `Object.keys({} as Record<keyof PublicTypeSurface, true>)` 的类型是 `string[]`（无懈可击），
 * 而运行期值是 `{}` 的键 —— 也就是 **`[]`**。派生式的类型签名在骗人，护栏恒绿。
 * （实测踩过：先写成派生式，再从入口删掉 `CoreServices`，vitest 依然 12 passed。）
 *
 * 所以改成**真数组 + 编译期双向穷尽**（见 {@link TypeExportNamesMatchSurface}）：
 * 名单少一项 / 多一项，tsc 都会在 `expectTypeOf` 那条里红；入口少导一个名字，
 * {@link exportedNamesOf} 那条运行期断言红。两侧都兜住，且各自都不必相信对方。
 */
const requiredTypeExportNames = [
  // 库门面
  "ProxyRuntime",
  "ProxyRuntimeOptions",
  "RuntimeContext",
  "RuntimeContextOptions",
  "RuntimeServices",
  "RuntimeWarning",
  "StartupPreset",
  // 配置
  "AppConfig",
  "AuthType",
  "CacheType",
  "ConfigAccessor",
  "ConfigChangeListener",
  "ConfigContext",
  "ConfigKey",
  "ConfigSourceMetadata",
  "ConfigStoreReader",
  "CreateConfigContextOptions",
  "FieldDef",
  "LoadConfigOptions",
  "LogLevel",
  "PreparedRuntimeConfig",
  "ProxyPreset",
  "UserPolicy",
  "UserPolicyList",
  // 事件
  "AppEventMap",
  "EventContext",
  "EventEnvelope",
  "EventListener",
  "EventName",
  "EventSubscription",
  "EventHubOptions",
  "EventScope",
  // 日志 / TLS
  "Logger",
  "LoggerImpl",
  "LogFields",
  "TlsKeyCert",
  // 代理核心
  "CoreServices",
  "Lifecycle",
  "LifecycleState",
  "PipeEvent",
  "PipeEventType",
  "PipeEventSink",
  "ProxyCore",
  "ProxyForwardKind",
  "ProxyOptions",
  "ProxyProtocol",
  "ProxyStats",
  // 依赖承载体
  "CoreContext",
  // 可插值端口 ① 身份
  "IdentityProvider",
  "IdentityOptions",
  "IdentityContext",
  "IdentityRequestLike",
  "IdentityResult",
  "AuthAccount",
  "ProxyAuthEvent",
  "AccountIdentityOptions",
  "JwtIdentityOptions",
  // 可插值端口 ② 访问控制
  "AccessControl",
  "AccessDecision",
  "AccessRouteDecision",
  "AccessClientInput",
  "AccessTargetInput",
  "AccessRouteInput",
  "AclConfig",
  "AclList",
  // 可插值端口 ③ 流量配额
  "TrafficAccount",
  "TrafficDirection",
  "TrafficScope",
  "TrafficVerdict",
  "TrafficUsage",
  "QuotaResolver",
  "TrafficSink",
  "TrafficLedgerController",
  "TrafficLedgerError",
  "RestoredLedger",
  "RestoredUsage",
  "QuotaWindow",
  "TrafficWindowSource",
  "JsonlTrafficLedgerOptions",
  "LedgerEntry",
  "FlushLoopHandle",
  // 可插值端口 ④ 上游接入
  "ConnectorSource",
  "UpstreamConnector",
  "OpenContext",
  "OpenedUpstream",
  "UpstreamKind",
  // 进程级 API
  "ProcessPolicy",
  "ProcessStartupPreset",
  "ProxyServerOptions",
  "RunServerOptions",
  "SignalHost",
] as const;

/**
 * 编译期**双向穷尽**断言：上面的名单与 {@link PublicTypeSurface} 的键必须逐项相同。
 * 差集非空即 `never`，`expectTypeOf<…>().toEqualTypeOf<true>()` 当场红。
 */
type TypeExportNamesMatchSurface = [Exclude<(typeof requiredTypeExportNames)[number], keyof PublicTypeSurface>, Exclude<keyof PublicTypeSurface, (typeof requiredTypeExportNames)[number]>] extends [never, never] ? true : never;

// ---------------------------------------------------------------------------
// 公开导出面：值分三桶（函数 / 对象 / 数字），每一项都是「删掉就会红」的契约
// ---------------------------------------------------------------------------

const requiredFunctionExports = [
  // 库门面
  "createProxyRuntime",
  "buildDefaultServices",
  "RuntimeContext",
  // 具名装配
  "defineStartupPreset",
  "getStartupPreset",
  "listStartupPresets",
  "pickStartupPreset",
  "registerStartupPreset",
  // 配置
  "ConfigStore",
  "loadConfig",
  "configAccessorFromStore",
  "createConfigContext",
  "keysByPhase",
  "defaultEnvFileNames",
  "prepareRuntimeConfigStore",
  "applyPreset",
  "definePreset",
  "getPreset",
  "listPresets",
  "registerPreset",
  // 账号表 / 名单读取面
  "createJsonFileEventHandler",
  "loadAuthUsers",
  "loadUserPolicy",
  "loadUserQuota",
  "readAuthUsers",
  "readAuthUsersAsync",
  "validateAcl",
  "validateAuthUsers",
  // 事件
  "EventHub",
  "createRuntimeScope",
  "createConnectionScope",
  "createRequestScope",
  // 日志
  "createNoopLogger",
  "createConsoleLogger",
  "createLogger",
  // 代理核心
  "createProxy",
  // 可插值端口 ① 身份
  "createIdentity",
  "createIdentityFromConfig",
  "defaultJwtVerify",
  "FileAccountIdentity",
  "TokenIdentityBase",
  "noneIdentity",
  "basicIdentity",
  "uidIdentity",
  "jwtIdentity",
  // 可插值端口 ② 访问控制
  "createFileAccessControl",
  "bindAclFileEvents",
  "loadAcl",
  "readAcl",
  // 可插值端口 ③ 流量配额
  "createMemoryTrafficAccount",
  "inertTrafficAccount",
  "MemoryTrafficAccount",
  "JsonlTrafficLedger",
  "normalizeSlot",
  "quotaWindow",
  "windowKey",
  // 可插值端口 ④ 上游接入
  "createConnectorSource",
  "DirectConnector",
  "HttpConnectConnector",
  "Socks4Connector",
  "Socks5Connector",
  // 进程级 API
  "ProxyServer",
  "runServer",
  "cliPreset",
] as const;

const requiredObjectExports = [
  "defaults",
  // `FIELDS` 是 `Record<ConfigKey, FieldDef>`（env 名的唯一真相源；运行期是数组，故归对象桶）
  "FIELDS",
  "builtinPresets",
  "builtinStartupPresets",
  "cliProcessPolicy",
  "managedProcessPolicy",
] as const;

const requiredNumberExports = ["DEFAULT_LEDGER_COMPACT_BYTES"] as const;

/** 两个 `DEFAULT_*` 是**字符串**（窗口字面量 `"month"` / 槽位号 `"0"`），不是数字 */
const requiredStringExports = ["DEFAULT_QUOTA_WINDOW", "DEFAULT_TRAFFIC_SLOT"] as const;

const requiredValueExports = [
  ...requiredFunctionExports,
  ...requiredObjectExports,
  ...requiredNumberExports,
  ...requiredStringExports,
] as const;

/**
 * 「不留兼容层」的机器可读护栏：一个旧名都不许再出现在包入口。
 *
 * **为什么必须机器可读**：不留兼容层是口头纪律时，下一个人加一个 `export { X as Y }` 别名
 * 只是「顺手帮老调用方一把」，评审未必拦得住；而这里红一次的成本是零。
 */
const removedTypeNames = [
  // 身份端口去 Auth 化前的四个名字（现为 Identity*）
  "AuthProvider",
  "AuthOptions",
  "AuthContext",
  "AuthResult",
  // 访问控制端口化前的三个名字（闭合字面量集 + 判定层内部类型）
  "AclSource",
  "AclReason",
  "AclDecision",
  // 1.3b 整体删除的事件表与四个专属载荷
  "ProxyEventMap",
  "ProxyForwardEvent",
  "ProxyServerErrorEvent",
  "ProxyClientErrorEvent",
] as const;

const removedValueNames = [
  // 访问控制端口化前的三个逐函数入口（现为 createFileAccessControl 的三个方法）
  "checkClientIp",
  "checkTargetHost",
  "checkUpstreamRoute",
  // 连接器装配期化前的两个每请求入口（现为 ConnectorSource）
  "connectorFor",
  "directConnector",
  // 出站凭证判据的旧「从 config 猜」形态（现为 IdentityProvider.isOwnCredential 必填成员）
  "isProxyCredentialValue",
  // 配置驱动身份组件的旧名（现为 createIdentityFromConfig）
  "createAuthFromConfig",
  // 进程级批量配置入口的历史拼法
  "setupProcessGuards",
] as const;

function hasCompleteValueSurface(candidate: Entry | undefined): candidate is Entry {
  return (
    candidate !== undefined &&
    requiredFunctionExports.every((name) => typeof candidate[name] === "function") &&
    requiredObjectExports.every((name) => typeof candidate[name] === "object") &&
    requiredNumberExports.every((name) => typeof candidate[name] === "number") &&
    requiredStringExports.every((name) => typeof candidate[name] === "string")
  );
}

let packagedEntry: Entry | undefined;
if (hasLibFiles) {
  try {
    packagedEntry = requireFromTest("@b-hole/proxy") as Entry;
  } catch {
    // A stale or partially-written lib/ is equivalent to an unbuilt library.
    packagedEntry = undefined;
  }
}

const sourceEntry = sourceEntryModule as unknown as Entry;
const packagedEntryIsReady = hasCompleteValueSurface(packagedEntry);
const sourceEntryIsReady = hasCompleteValueSurface(sourceEntry);
const entry = packagedEntryIsReady ? packagedEntry : sourceEntry;
const entryIsReady = packagedEntryIsReady || sourceEntryIsReady;

function createRuntimeFromEntry(
  currentEntry: Entry,
  port: number,
): {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
} {
  const factory = currentEntry.createProxyRuntime as (options: {
    config: { host: string; port: number; proxyProtocol: "http" };
  }) => {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    isRunning: () => boolean;
  };
  return factory({
    config: { host: "127.0.0.1", port, proxyProtocol: "http" },
  });
}

describe("@b-hole/proxy library entry", () => {
  it.skipIf(!packagedEntryIsReady)("require() resolves to the packaged lib/index.js", () => {
    const resolved = requireFromTest.resolve("@b-hole/proxy");
    expect(path.resolve(resolved)).toBe(path.resolve(libEntryPath));
  });

  it.skipIf(!packagedEntryIsReady)("package exports block internal deep imports", () => {
    expect(() => requireFromTest("@b-hole/proxy/lib/core/index.js")).toThrow();
  });

  it.skipIf(!entryIsReady)("exposes the complete public value surface", () => {
    for (const name of requiredValueExports) {
      expect(entry).toHaveProperty(name);
    }
    for (const name of requiredFunctionExports) {
      expect(typeof entry?.[name]).toBe("function");
    }
    for (const name of requiredObjectExports) {
      expect(typeof entry?.[name]).toBe("object");
    }
    for (const name of requiredNumberExports) {
      expect(typeof entry?.[name]).toBe("number");
    }
    for (const name of requiredStringExports) {
      expect(typeof entry?.[name]).toBe("string");
    }
    // 全局配置单例面：包入口**没有**进程级 config 状态可读写
    for (const name of ["get", "getAll", "set", "defaultConfigStore", "globalConfigAccessor"]) {
      expect(entry).not.toHaveProperty(name);
    }
  });

  it("declares every required value export in the source entry too", () => {
    // ⚠️ **为什么上面那条运行期断言不够**：`entry` 优先取**打包产物** `lib/index.js`，而 `lib/` 是
    // gitignored 的、本机常年过期 —— 于是「刚把某个值导出从 `src/index.ts` 删掉、还没跑
    // `build:lib`」这个最常见的改动形态在 `pnpm test` 下**完全测不出来**（实测：删掉
    // `createConnectorSource` 后 12 passed，因为 `lib/` 里那份还在）。本条从**源码导出面**取事实，
    // 不依赖任何构建产物，所以「改了 src 就立刻红」。
    const exported = exportedNamesOf(sourceEntryPath);
    for (const name of requiredValueExports) {
      expect({ name, exported: exported.has(name) }).toEqual({ name, exported: true });
    }
  });

  it.skipIf(!entryIsReady)("keeps the public type surface strongly typed", () => {
    expectTypeOf<PublicTypeSurface>().toMatchTypeOf<object>();
    expectTypeOf<AppConfig>().toMatchTypeOf<object>();
    expectTypeOf<EventEnvelope>().toMatchTypeOf<object>();
    expectTypeOf<Logger>().toMatchTypeOf<object>();
    expectTypeOf<ConfigKey>().toMatchTypeOf<keyof AppConfig>();
  });

  it("covers every injectable port: interface + inputs + results + built-in implementation", () => {
    // 这一条是「库可装配」的**可编译**证据：四个可插值端口各自都能从包入口 import 到
    // 「接口 + 输入/结果类型 + 内置实现」，且 `ProxyOptions` 的注入位真的接得上。
    // 缺任何一个符号都会在这里编译期红 —— 而缺口若只写在文档里，下一个人是看不见的。
    expectTypeOf<IdentityProvider["identify"]>().returns.toEqualTypeOf<Promise<IdentityResult>>();
    expectTypeOf<AccessControl["checkClient"]>().returns.toEqualTypeOf<AccessDecision>();
    expectTypeOf<AccessControl["checkRoute"]>().returns.toEqualTypeOf<AccessRouteDecision>();
    expectTypeOf<TrafficAccount["consume"]>().returns.toEqualTypeOf<TrafficVerdict>();
    expectTypeOf<TrafficAccount["usage"]>().returns.toEqualTypeOf<TrafficUsage>();
    // `ConnectorSource` 刻意**不收协议参数**：「这个部署走上游是什么协议」是装配期的一个事实，
    // 逐请求换协议正是本端口要消灭的每请求查表（真要按目标分流 = 自己实现本接口）
    expectTypeOf<ConnectorSource["direct"]>().toEqualTypeOf<() => UpstreamConnector>();
    // 端口的依赖承载体可从包入口 import：几乎每个工厂第一个形参就是它
    expectTypeOf<Parameters<typeof createIdentityFromConfig>[0]>().toEqualTypeOf<CoreContext>();
    expectTypeOf<Parameters<typeof createConnectorSource>[0]>().toEqualTypeOf<CoreContext>();
    expectTypeOf<NonNullable<StartupPreset["connectors"]>>().toEqualTypeOf<
      (ctx: CoreContext) => ConnectorSource
    >();
    expectTypeOf<NonNullable<StartupPreset["protocol"]>>().toEqualTypeOf<ProxyProtocol>();
    // 装配位：`ProxyOptions` 的三个注入键 + 归一后的 core 服务包
    expectTypeOf<ProxyOptions>().toHaveProperty("identity");
    expectTypeOf<ProxyOptions>().toHaveProperty("access");
    expectTypeOf<ProxyOptions>().toHaveProperty("connectors");
    expectTypeOf<CoreServices>().toHaveProperty("identity");
    expectTypeOf<CoreServices>().toHaveProperty("access");
    expectTypeOf<CoreServices>().toHaveProperty("traffic");
    // runtime 侧的服务包三项齐（identity 已从 auth 改名）
    expectTypeOf<RuntimeServices>().toHaveProperty("identity");
    expectTypeOf<RuntimeServices>().not.toHaveProperty("auth");
    // 具名装配：预设只声明要改的那几项，且库那侧刻意不含进程字段
    expectTypeOf<StartupPreset>().toHaveProperty("protocol");
    expectTypeOf<StartupPreset>().toHaveProperty("services");
    expectTypeOf<StartupPreset>().toHaveProperty("connectors");
    expectTypeOf<StartupPreset>().not.toHaveProperty("process");
    expectTypeOf<ProcessStartupPreset>().toHaveProperty("process");
    // 进程级端口：forceExit 必填（三项可选项是「省略即不装」）
    expectTypeOf<ProcessPolicy>().toHaveProperty("forceExit");
    expectTypeOf<SignalHost>().toHaveProperty("gracefulStop");
    expectTypeOf<RunServerOptions>().toHaveProperty("trafficWorkerSlot");
    expectTypeOf<RunServerOptions>().toHaveProperty("processPolicy");
    expectTypeOf<ProxyServerOptions>().toHaveProperty("context");
    // 名单与 `PublicTypeSurface` 双向穷尽（差集非空即 `never`）
    expectTypeOf<TypeExportNamesMatchSurface>().toEqualTypeOf<true>();
  });

  it("exports no removed legacy name", () => {
    // ① 运行期：旧**值**名一律不存在
    for (const name of removedValueNames) {
      expect(entry).not.toHaveProperty(name);
    }
    // ② 导出面：旧**类型**名与旧值名都不许出现在 `export { … }` 列表里
    // （类型在运行期不可见，只能静态断言；值在 ① 已覆盖，此处一并兜住「加了别名」）
    for (const name of [...removedTypeNames, ...removedValueNames]) {
      expect(exportedNamesOf(sourceEntryPath)).not.toContain(name);
    }
    // ③ 入口**零 `export *`**：通配转发会让上面整套按名字的护栏全部失效 ——
    // 任何人在被转发的 barrel 里加一个符号，包入口就静默多出一个公开名（含旧名），
    // 而 `exportedNamesOf` 根本看不见它。要扩出口就逐个列名。
    expect(codeOnly(fs.readFileSync(sourceEntryPath, "utf8"))).not.toMatch(/export\s+\*/);
    // ④ **每一个声明过的类型名都必须真的在导出面上**。
    //
    // ⚠️ 这条存在的理由是 vitest **不做类型检查**：`pnpm test` 走 esbuild，类型全被擦除，
    // 所以「从入口删掉一个类型导出」在 `pnpm test` 下**完全无感**（实测：删掉 `CoreServices`
    // 后 vitest 照样 12 passed，只有 `pnpm typecheck` 报 TS2305）。派生式照看两类失败：
    // 入口少导一个 → ④ 红；`PublicTypeSurface` 少声明一个 → tsc 在 import 那行就红。
    // 名单由 `keyof PublicTypeSurface` 派生，与那份类型声明**同一真相源**，不会各抄一份漂移。
    const exported = exportedNamesOf(sourceEntryPath);
    for (const name of requiredTypeExportNames) {
      expect({ type: name, exported: exported.has(name) }).toEqual({ type: name, exported: true });
    }
  });

  it("keeps process guards and config logging behind lazy dynamic import", () => {
    // **为什么这条必须是源码级、且为什么它不是「多此一举」**：
    // `process-guards.ts` 与 `log/config-log.ts` **今天都没有模块顶层副作用**（前者只导出一个
    // `setupProcessGuards` 函数、后者只导出一个 `logConfig`），而两者的**调用点**都在显式动作里
    // （`installGuards(logger)` / `start()`）。所以把动态 import 改成静态 import **当下什么副作用都测不出来**
    // ——监听器不会被装，import 期依然干净。
    // 这条断言是那条**纪律的绊线**：一旦有人日后在这两个模块里加一行顶层 `process.on`（它们本来就是
    // 「进程级动作」的家，写起来最自然），静态 import 就会让守卫在 `import "这个包"` 那一刻装上，
    // 而**下面那条行为断言仍会是绿的**（它量的是监听器数量，不是「谁在 import 期执行了什么」）。
    // 两层分工别混：源码层钉「动态 import 这个形态」，行为层钉「import 期的可观测后果」。
    const entryCode = codeOnly(fs.readFileSync(sourceEntryPath, "utf8"));
    const serverCode = codeOnly(fs.readFileSync(path.join(packageRoot, "src", "server", "index.ts"), "utf8"));
    const policyCode = codeOnly(fs.readFileSync(path.join(packageRoot, "src", "server", "process.ts"), "utf8"));

    // 入口本身不许静态引到任何 server 内部实现。
    // ⚠️ 必须锚在 `@/server/` 上：`@/core/server/factory.js`（`createProxy` 的出处）是**合法**的，
    // 不加锚点这条断言会误伤它 —— 而一条恒红的护栏等于没有护栏。
    expect(entryCode).not.toMatch(/@\/server\/(?!index\.js")/);
    // 进程守卫：只允许 `await import("./process-guards.js")`
    expect(policyCode).toContain('await import("./process-guards.js")');
    expect(policyCode).not.toMatch(/^\s*import\s.*process-guards\.js/m);
    // 配置快照打印：同样只能动态
    expect(serverCode).toContain('await import("./log/config-log.js")');
    expect(serverCode).not.toMatch(/^\s*import\s.*config-log\.js/m);
  });

  it.skipIf(!packagedEntryIsReady)("installs no process listener at import time", () => {
    // 行为侧的「零 import 期副作用」：整包 require 一遍，`process` 上不得多出任何监听器。
    // 覆盖面比上面的源码断言更广（连 core/runtime/config 的任何一条静态边都算进去）。
    //
    // ⚠️ **必须在子进程里观测**。本文件在 vitest 下运行时：
    // ① 顶部的 `requireFromTest("@b-hole/proxy")` 已经把模块执行过一遍，`process` 上已有它装的监听器；
    // ② `createRequire` 拿到的是**框架垫片**，`req.cache` 既不等于 `Module._cache`、也压根不含
    //    解析出来的那个路径（实测 `resolved in req.cache === false`），所以 `delete req.cache[id]`
    //    清不掉任何东西，第二次 require 直接命中垫片注册表、**模块体压根不再执行**。
    // 两条叠起来的结果是：增量恒为 0，**这条断言恒绿**（实测：往 `server/index.ts` 顶层加
    // `process.on("warning")` 并重跑 `build:lib`，同进程内观测的版本照样全绿）。
    //
    // 判据是**「require 前后完全相同」**，不是「require 之后为 0」——**Node 自己的 bootstrap 就装着
    // 一个 `warning` 监听器**（`process.listeners("warning")` → `[onWarning]`），所以裸 `node -e`
    // 起进程时 `warning` 计数已经是 1。写「绝对为 0」会得到一条与被测包无关的红。
    const script = `
      const watched = ${JSON.stringify(watchedProcessEvents)};
      const fp = () => process.eventNames()
        .map((n) => String(n) + ":" + process.listenerCount(n))
        .sort()
        .join("|");
      const before = Object.fromEntries(watched.map((e) => [e, process.listenerCount(e)]));
      const beforeFp = fp();
      require(${JSON.stringify(libEntryPath)});
      const after = Object.fromEntries(watched.map((e) => [e, process.listenerCount(e)]));
      process.stdout.write(JSON.stringify({
        before,
        after,
        added: watched.filter((e) => after[e] !== before[e]),
        fingerprintChanged: fp() !== beforeFp,
        fp: fp(),
      }));
    `;
    const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const observed = JSON.parse(out) as {
      before: Record<string, number>;
      after: Record<string, number>;
      added: string[];
      fingerprintChanged: boolean;
      fp: string;
    };

    // ① 被盯的每个事件：require 前后计数必须逐项相同
    expect(observed.after).toEqual(observed.before);
    expect(observed.added).toEqual([]);
    // ② 整个 `process` 事件表逐字未变（兜住表外事件，也兜住「同一事件多装/少装」互相抵消）
    expect({ fingerprintChanged: observed.fingerprintChanged, fp: observed.fp }).toEqual({
      fingerprintChanged: false,
      fp: observed.fp,
    });
  });

  it.skipIf(!entryIsReady)("starts and stops a minimal HTTP runtime", async () => {
    const port = await getFreePort();
    expect(port).toBeGreaterThan(1024);

    const runtime = createRuntimeFromEntry(entry as Entry, port);
    try {
      await runtime.start();
      expect(runtime.isRunning()).toBe(true);
    } finally {
      await runtime.stop();
    }

    expect(runtime.isRunning()).toBe(false);
  });

  it.skipIf(!entryIsReady)("forwards a real request through the runtime-owned proxy", async () => {
    // 端到端护栏：库起的代理必须真能把流量送到目标，而不只是「端口在监听」
    const origin = createHttpServer((_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.end("hello-from-origin");
    });
    const originPort = await listenOnFreePort(origin);
    const proxyPort = await getFreePort();

    const runtime = createRuntimeFromEntry(entry as Entry, proxyPort);
    try {
      await runtime.start();
      expect(await getViaProxy(proxyPort, originPort, "/probe")).toBe("hello-from-origin");
    } finally {
      await runtime.stop();
      await closeServer(origin);
    }
  });

  it.skipIf(!entryIsReady)("keeps two runtimes isolated in config, events and port", async () => {
    // 多实例护栏：库模式最核心的承诺——两个代理互不串号
    const origin = createHttpServer((_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.end("ok");
    });
    const originPort = await listenOnFreePort(origin);
    const portA = await getFreePort();
    const portB = await getFreePort();

    const factory = (entry as Entry).createProxyRuntime as unknown as RuntimeFactory;
    const runtimeA = factory({ config: { host: "127.0.0.1", port: portA } });
    const runtimeB = factory({ config: { host: "127.0.0.1", port: portB } });

    const bStarted: string[] = [];
    runtimeB.events.subscribe("runtime.started", (e) => {
      bStarted.push(e.context.runtimeId);
    });

    try {
      await runtimeA.start();
      // 基线**必须**取在 A 自己 start 之后：A.start() 会给自己的总线挂上 `pipe` 与
      // `lifecycle.changed` 两个订阅（`runtime.ts:activateSubscriptions`），拿 start 之前的
      // 计数当基线，量到的其实是「A 自己的订阅」而不是「B 带来的增量」，于是这条断言在
      // `lib/` 与 `src/` 对齐（即跑过 build:lib）之后必然变红。
      const listenersOnA = runtimeA.events.listenerCount();
      await runtimeB.start();

      // 身份与总线互相独立
      expect(runtimeA.runtimeId).not.toBe(runtimeB.runtimeId);
      expect(runtimeA.events).not.toBe(runtimeB.events);
      // 配置互相独立
      expect(runtimeA.context.store.get("port")).toBe(portA);
      expect(runtimeB.context.store.get("port")).toBe(portB);
      // 事件归属正确：B 只收到自己那条，且 context 指向 B
      expect(bStarted).toEqual([runtimeB.runtimeId]);
      // A 的总线不因 B 的启动而增加任何监听
      expect(runtimeA.events.listenerCount()).toBe(listenersOnA);
      // 两个实例都真能转发
      expect(await getViaProxy(portA, originPort, "/a")).toBe("ok");
      expect(await getViaProxy(portB, originPort, "/b")).toBe("ok");
    } finally {
      await runtimeA.stop();
      await runtimeB.stop();
      await closeServer(origin);
    }
  });

  it.skipIf(!entryIsReady)("loadConfig resolves explicit env without polluting the host", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "proxy-lib-cfg-"));
    const envBefore = JSON.stringify(Object.entries(process.env).sort());

    try {
      const load = (entry as Entry).loadConfig as unknown as (options: {
        env: Record<string, string>;
        envFiles: string[];
        argv: string[];
        cwd: string;
        skipFileValidation: boolean;
      }) => Promise<{
        store: { get: (key: "port") => number };
        accessor: { get: (key: "port") => number };
        warnings: string[];
      }>;

      const context = await load({
        env: { PORT: "19191" },
        envFiles: [],
        argv: [],
        cwd: sandbox,
        skipFileValidation: true,
      });

      expect(context.store.get("port")).toBe(19191);
      expect(context.accessor.get("port")).toBe(19191);
      expect(context.warnings).toEqual([]);
      expect(process.env.PORT).toBeUndefined();
      expect(JSON.stringify(Object.entries(process.env).sort())).toBe(envBefore);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

/**
 * 公开类型面的**逐项声明**：每个键都必须能从包入口 import 到。
 *
 * ⚠️ 这里刻意**逐个**列出而不只列代表性的几个：编译期只在「某个名字 import 不进来」时红，
 * 而「忘了把 `CoreServices` 之类的新端口类型加进来」在运行期完全无感（类型擦除）。
 * 声明本身就是那份「可插值端口清单」的机器可读副本。
 */
type PublicTypeSurface = {
  // 库门面
  ProxyRuntime: ProxyRuntime;
  ProxyRuntimeOptions: ProxyRuntimeOptions;
  RuntimeContext: RuntimeContext;
  RuntimeContextOptions: RuntimeContextOptions;
  RuntimeServices: RuntimeServices;
  RuntimeWarning: RuntimeWarning;
  StartupPreset: StartupPreset;
  // 配置
  AppConfig: AppConfig;
  AuthType: AuthType;
  CacheType: CacheType;
  ConfigAccessor: ConfigAccessor;
  ConfigChangeListener: ConfigChangeListener;
  ConfigContext: ConfigContext;
  ConfigKey: ConfigKey;
  ConfigSourceMetadata: ConfigSourceMetadata;
  ConfigStoreReader: ConfigStoreReader;
  CreateConfigContextOptions: CreateConfigContextOptions;
  FieldDef: FieldDef;
  LoadConfigOptions: LoadConfigOptions;
  LogLevel: LogLevel;
  PreparedRuntimeConfig: PreparedRuntimeConfig;
  ProxyPreset: ProxyPreset;
  UserPolicy: UserPolicy;
  UserPolicyList: UserPolicyList;
  // 事件
  AppEventMap: AppEventMap;
  EventContext: EventContext;
  EventEnvelope: EventEnvelope;
  EventListener: EventListener<keyof AppEventMap>;
  EventName: EventName;
  EventSubscription: EventSubscription;
  EventHubOptions: EventHubOptions;
  EventScope: EventScope;
  // 日志 / TLS
  Logger: Logger;
  LoggerImpl: LoggerImpl;
  LogFields: LogFields;
  TlsKeyCert: TlsKeyCert;
  // 代理核心
  CoreServices: CoreServices;
  Lifecycle: Lifecycle;
  LifecycleState: LifecycleState;
  PipeEvent: PipeEvent;
  PipeEventType: PipeEventType;
  PipeEventSink: PipeEventSink;
  ProxyCore: ProxyCore;
  ProxyForwardKind: ProxyForwardKind;
  ProxyOptions: ProxyOptions;
  ProxyProtocol: ProxyProtocol;
  ProxyStats: ProxyStats;
  // 依赖承载体
  CoreContext: CoreContext;
  // 可插值端口 ① 身份
  IdentityProvider: IdentityProvider;
  IdentityOptions: IdentityOptions;
  IdentityContext: IdentityContext;
  IdentityRequestLike: IdentityRequestLike;
  IdentityResult: IdentityResult;
  AuthAccount: AuthAccount;
  ProxyAuthEvent: ProxyAuthEvent;
  AccountIdentityOptions: AccountIdentityOptions;
  JwtIdentityOptions: JwtIdentityOptions;
  // 可插值端口 ② 访问控制
  AccessControl: AccessControl;
  AccessDecision: AccessDecision;
  AccessRouteDecision: AccessRouteDecision;
  AccessClientInput: AccessClientInput;
  AccessTargetInput: AccessTargetInput;
  AccessRouteInput: AccessRouteInput;
  AclConfig: AclConfig;
  AclList: AclList;
  // 可插值端口 ③ 流量配额
  TrafficAccount: TrafficAccount;
  TrafficDirection: TrafficDirection;
  TrafficScope: TrafficScope;
  TrafficVerdict: TrafficVerdict;
  TrafficUsage: TrafficUsage;
  QuotaResolver: QuotaResolver;
  TrafficSink: TrafficSink;
  TrafficLedgerController: TrafficLedgerController;
  TrafficLedgerError: TrafficLedgerError;
  RestoredLedger: RestoredLedger;
  RestoredUsage: RestoredUsage;
  QuotaWindow: QuotaWindow;
  TrafficWindowSource: TrafficWindowSource;
  JsonlTrafficLedgerOptions: JsonlTrafficLedgerOptions;
  LedgerEntry: LedgerEntry;
  FlushLoopHandle: FlushLoopHandle;
  // 可插值端口 ④ 上游接入
  ConnectorSource: ConnectorSource;
  UpstreamConnector: UpstreamConnector;
  OpenContext: OpenContext;
  OpenedUpstream: OpenedUpstream;
  UpstreamKind: UpstreamKind;
  // 进程级 API
  ProcessPolicy: ProcessPolicy;
  ProcessStartupPreset: ProcessStartupPreset;
  ProxyServerOptions: ProxyServerOptions;
  RunServerOptions: RunServerOptions;
  SignalHost: SignalHost;
};
