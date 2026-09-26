/**
 * @fileoverview 启动预设 = 一份**具名的装配决策**
 * @module runtime/presets
 * @description
 * ⚠️ **与 `@/config/presets.ts` 的 `ProxyPreset` 是两样东西，名字刻意全部错开。**
 *
 * | | `config/presets.ts:ProxyPreset` | 本文件 `StartupPreset` |
 * |---|---|---|
 * | 是什么 | **配置值**打包（`name + Partial<AppConfig>`） | **装配**决策（用哪个协议服务器 / 哪些服务替身 / 哪套上游接入） |
 * | 消费点 | `applyPreset()` → 灌进 `ConfigStore`，之后经 accessor 现读 | `createProxyRuntime({ assembly })` 的**消费点在构造期**（协议与连接器都是 startup 事实，构造后不再变） |
 * | 形状稳定性 | 值是数据，谁都能自己拼一个对象 | 里面装的是**服务实例工厂**（`Partial<RuntimeServices>` + 连接器工厂函数），不是数据 |
 *
 * 两者**没有任何关系**，只是都叫「预设」。本文件所有符号一律带 `Startup` / `startup` 前缀，
 * 就是为了让读代码的人一眼分清「我在动配置值，还是在动装配」。
 *
 * ## 边界：库层只收「装配」，不碰「进程」
 *
 * `StartupPreset` **刻意没有 `process` 字段**（cluster 槽位 / 信号策略 / 优雅退出预算
 * 那些进程级决策）。理由是依赖方向：`ProcessPolicy` 住在 `src/server/`，而
 * `runtime → server` 是**被禁方向**（`core → server` 早就禁过一次，理由是 core 要能被
 * 库调用方单独使用）。哪怕用 `import type` 擦除掉运行期依赖，也会留下一个「库层的
 * 公开类型里出现进程层类型」的**阅读陷阱**：下一个人看到 `StartupPreset.process`
 * 会以为 runtime 会用它，于是要么在 runtime 里写一段永远不执行的消费代码，要么
 * 把它挪成运行期 import。**由 server 侧另设 `ProcessStartupPreset extends StartupPreset`
 * 加那个字段**，方向自然是 `server → runtime`（已被允许的那一侧），两边都不将就。
 *
 * ## 导入期零副作用
 *
 * 模块加载只创建内置字面量与一张内存 `Map`（本文件唯一的模块级可变状态）。不读
 * env / argv / 文件、不动态 `require` / `import` 插件、不注册进程事件、不产生日志 / IO。
 * `pickStartupPreset` 同理：**零 `process.env`**。
 */

import type { ConfigContext } from "@/config/index.js";
import type { CoreContext } from "@/core/context.js";
import type { ConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { ProxyProtocol } from "@/core/types/proxy.js";
import { isProxyProtocol } from "./runtime.js";
import type { RuntimeServices } from "./types.js";

/** 启动预设 = 一份具名的装配决策。全部字段可选：只声明要改的那几项。 */
export interface StartupPreset {
  /** 唯一名（如 `"sockss5"` / `"platform-gateway"`），注册表 key。 */
  readonly name: string;
  /** 人类可读描述（列出用途）。 */
  readonly description?: string;
  /**
   * 组装出哪个协议服务器。缺省 = 现读配置的 `proxyProtocol`。
   * @description 这是 startup 相位事实：它在**构造期**定死，core 侧协议核心的实例化
   * 只有这一次机会。
   */
  readonly protocol?: ProxyProtocol;
  /**
   * 服务覆盖（`identity` / `access` / `traffic` / `trafficLedger`）。
   * @description 与显式 `options.services` 是**逐字段合并**关系（显式那份赢），
   * 不是整体替换 —— 四项服务彼此正交。
   */
  readonly services?: Partial<RuntimeServices>;
  /**
   * 上游接入来源工厂（缺省 = `createConnectorSource(ctx)`）。
   * @description **是工厂而不是实例**：连接器的一切配置读取都经 `CoreContext`，
   * 而 `ctx` 只有在装配期（`this.dependencies` 建好之后）才存在。收工厂而不是收实例，
   * 才能让预设**声明意图**（「我要一套自己的上游接入」）而不绑死某次运行的依赖三件套。
   */
  readonly connectors?: (ctx: CoreContext) => ConnectorSource;
}

/**
 * 定义一个启动预设（identity 函数，仅提供类型推导与链式友好；**不做运行时校验**）
 * @description 值域合法性由各端口自己的类型与 `createProxy` 兜底：协议是字面量联合
 * （表外值连编译期都过不去），服务项是四个具体端口类型。
 */
export function defineStartupPreset(preset: StartupPreset): StartupPreset {
  return preset;
}

/**
 * 六个内置协议预设
 * @description
 * `satisfies Record<ProxyProtocol, StartupPreset>` 是**穷尽性护栏**：`ProxyProtocol`
 * 新增成员而本表漏登记即**编译失败**。这不是负担而是提醒——新增入站协议的人一定会
 * 被迫想一遍「要不要给它一个具名预设」，而答案是「要」（下面注释解释了为什么）。
 *
 * ## 为什么只有 6 个，且每个只声明 `protocol` + `description`
 *
 * 内置预设的**全部**价值是「省得每次手写 `protocol: "sockss5"`」——就这一件事。
 * 服务覆盖与进程策略是**调用方的部署决策**：同一个 `sockss5` 协议，匿名网关与
 * 带鉴权 + 每人配额的网关是两套装配；把它们预置成 `"sockss5-secure"` /
 * `"sockss5-quota"` 这种组合预设，只会得到一份**没人维护的菜单**——六个协议 × N 种服务
 * 组合 × M 种进程策略的笛卡尔积，每加一个服务就多一批要改的预设，而且没有任何一个
 * 预设真的描述了谁在用。`@/config/presets.ts` 的四个配置预设是同样克制的规模
 * （`development` / `socks5-basic` / `secure-http-auth` / `https-tls`，且都是**配置值**，
 * 不是实例），本文件与它保持同一个尺度。
 *
 * **要组合就直接写**：`registerStartupPreset({ name: "my-gateway", protocol: "sockss5",
 * services: { identity, traffic } })`。组合是调用方三行代码的事，不该由库方预置成菜单。
 *
 * ⚠️ **这张表不是协议判据的真相源**：`pickStartupPreset` 用的 `isProxyProtocol` 住在
 * `./runtime.js`（**全目录唯一一份**，由 `protocolFor` 与本文件共用）。本表仍带
 * `satisfies Record<ProxyProtocol, StartupPreset>`，但那是**「每个协议都得有一个具名预设」这条
 * 决策**的穷尽性护栏，与「什么值算合法协议」是两件事——**别再从本表的键派生一份判据**，
 * 两份派生迟早在某次新增协议时只改一处。
 */
const PROTOCOL_PRESET_TABLE = {
  http: defineStartupPreset({
    name: "http",
    protocol: "http",
    description: "明文正向代理（HTTP forward / CONNECT 隧道）",
  }),
  https: defineStartupPreset({
    name: "https",
    protocol: "https",
    description: "TLS 承载的正向代理，需配 TLS 证书",
  }),
  socks4: defineStartupPreset({
    name: "socks4",
    protocol: "socks4",
    description: "SOCKS4/4a 明文代理",
  }),
  socks5: defineStartupPreset({
    name: "socks5",
    protocol: "socks5",
    description: "SOCKS5 明文代理",
  }),
  sockss4: defineStartupPreset({
    name: "sockss4",
    protocol: "sockss4",
    description: "SOCKS4 over TLS 代理，需配 TLS 证书",
  }),
  sockss5: defineStartupPreset({
    name: "sockss5",
    protocol: "sockss5",
    description: "SOCKS5 over TLS 代理，需配 TLS 证书",
  }),
} satisfies Record<ProxyProtocol, StartupPreset>;

/** 静态注册表：模块加载期只创建内存 Map，不读文件/env，也不动态加载插件。 */
const startupPresetRegistry = new Map<string, StartupPreset>([
  [PROTOCOL_PRESET_TABLE.http.name, PROTOCOL_PRESET_TABLE.http],
  [PROTOCOL_PRESET_TABLE.https.name, PROTOCOL_PRESET_TABLE.https],
  [PROTOCOL_PRESET_TABLE.socks4.name, PROTOCOL_PRESET_TABLE.socks4],
  [PROTOCOL_PRESET_TABLE.socks5.name, PROTOCOL_PRESET_TABLE.socks5],
  [PROTOCOL_PRESET_TABLE.sockss4.name, PROTOCOL_PRESET_TABLE.sockss4],
  [PROTOCOL_PRESET_TABLE.sockss5.name, PROTOCOL_PRESET_TABLE.sockss5],
]);

/**
 * 内置启动预设注册表；只读类型是对外的静态视图，实际注册统一走
 * {@link registerStartupPreset}。
 */
export const builtinStartupPresets: ReadonlyMap<string, StartupPreset> = startupPresetRegistry;

/**
 * 注册/覆盖一个启动预设（供库用户扩展；返回幂等的 unregister 退订函数）。
 * @description 默认禁止重名；`override: true` 时允许替换当前注册项。退订函数**只移除
 * 自己的当前注册项**——旧退订函数不能误删后来覆盖同一名字的新注册项。
 * 与 `@/config/presets.ts:registerPreset` 同一形状（刻意照抄，不重新发明）。
 */
export function registerStartupPreset(
  preset: StartupPreset,
  options?: { override?: boolean },
): () => void {
  if (options?.override !== true && startupPresetRegistry.has(preset.name)) {
    throw new Error(`Startup preset already registered: ${preset.name}`);
  }

  startupPresetRegistry.set(preset.name, preset);
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (startupPresetRegistry.get(preset.name) === preset) {
      startupPresetRegistry.delete(preset.name);
    }
  };
}

/** 列出所有已注册启动预设名（含内置项）。 */
export function listStartupPresets(): string[] {
  return [...startupPresetRegistry.keys()];
}

/** 按名取得已注册启动预设；未注册时返回 undefined。 */
export function getStartupPreset(name: string): StartupPreset | undefined {
  return startupPresetRegistry.get(name);
}

/**
 * 选一份启动预设（**纯函数、零 `process.env`**）
 *
 * @description
 * - 给了 `name` → 取已注册那份；**未注册直接抛**（fail-closed，不静默回落配置值）。
 *   静默回落是最坏的一种失败形态：调用方点名要 `"sockss5"`，拼错成 `"socks5s"`,
 *   于是服务起来了但跑的是配置里那个协议——**「配错了、没报错、还起来了」**。
 *   抛错让拼错在启动那一刻就可见。
 * - 没给 `name` → 按**已经落进 store 的** `proxyProtocol` 现合成一份
 *   `{ name: "protocol:<proto>", protocol: <proto> }`。
 *
 * ## 为什么这里绝不读 `process.env`（这条纪律值得写透）
 *
 * **env 的影响全部收敛在 `loadConfig`**。它是本仓唯一读 env / argv / env 文件的入口，
 * 且所有校验通过后**一次** merge 进 `ConfigStore`。库层再读一次 `process.env` 就是
 * 「协议由两处决定」的第二真相源，形态如下：容器里 `PROXY_PROTOCOL=socks5` 起服务，
 * 库代码里 `pickStartupPreset(context)` 又读到宿主 env 的另一个值（或者更糟：调用方
 * 构造时**故意**在 `ConfigStore` 里放了 `sockss5`，而库层从 env 读回 `http`）——
 * 于是「配置里写的协议」与「实际跑的协议」不一致，且**没有任何一处日志或事件**能解释
 * 这个差异。`upstreamProtocol` 那次已经付过学费：记忆化的 `ConnectorSource` 一旦读到
 * 热改后的第二个值就成第二真相源（见 `core/forward/upstream/connector/registry.ts` 模块头）。
 *
 * **正确的两条路**：① 选协议服务器用 `PROXY_PROTOCOL`——它本来就是这个职责的 env 键，
 * 由 `loadConfig` 收进 store，`context.accessor.get("proxyProtocol")` 读它；
 * ② 要**具名**装配（同时换协议 + 换服务替身 + 换上游接入）就**程序化**传
 * `createProxyRuntime({ assembly })`，那份决策写在代码里，读者一眼看得见。
 *
 * @param context - 已加载的配置上下文（CLI 路径是 `await loadConfig(...)` 的结果）
 * @param name - 具名预设名；省略则按 `proxyProtocol` 现合成
 * @throws `name` 给了但未注册
 */
export function pickStartupPreset(context: ConfigContext, name?: string): StartupPreset {
  if (name !== undefined) {
    const preset = getStartupPreset(name);
    if (preset === undefined) {
      throw new Error(`Startup preset not found: ${name}`);
    }
    return preset;
  }

  const raw: unknown = context.accessor.get("proxyProtocol");
  // 非法值（`ConfigStore` 零校验，库路径能把 `"ftp"` 塞进来）**不在这 throw**：
  // 合成出的那份**不带 `protocol`**，于是 `createProxyRuntime` 落回
  // `protocolFor(config)` 那条 fail-closed 路径并报出「未知代理协议: ftp」。
  // 在这里 throw 等于把这个错误信息在两个地方各写一份。
  if (isProxyProtocol(raw)) {
    return { name: `protocol:${raw}`, protocol: raw };
  }
  return { name: `protocol:${String(raw)}` };
}
