/**
 * @fileoverview 访问控制名单的**驱动注册表**与装配读面
 * @module datasource/acl/registry
 * @description
 * 一张表回答「`ACL_DRIVER=<名字>` 背后是谁」，判据是**注册表里有没有这一项**而不是名字在某个枚举里
 * （理由见 `@/datasource/driver.ts`）。未注册驱动**在装配时抛错并列出全部已注册项**——
 * 绝不静默回落到 `json` 档：那会让 `ACL_DRIVER=mysql` 变成「以为接上了数据库，实际读的是 acl.json」，
 * 而**没有任何信号**。
 *
 * ⚠️ **注册是模块级的可变全局状态**，它带来一条真实的顺序约束：
 * **库调用方必须先注册、再建 runtime**。反过来不会崩，但那次装配解析不到新驱动，抛
 * 「驱动未注册」并列出**当时**已注册的项。判据刻意只在装配时报——
 * 「谁还没注册」只有装配那一刻才知道。
 *
 * ## 工厂吃「定位串闭包」而不是 `ConfigAccessor`
 *
 * 这样本层与配置层**零耦合**：`locator` 由装配层（`@/config/acl-locator.ts`）现取并注入，
 * 库调用方可以完全不经过 `loadConfig` 就用一份名单（这正是数据源独立于配置层的意义）。
 *
 * ## 记忆表只记「哪个驱动」，绝不记「哪份数据」
 * @see ./json-source.ts 里 locator 闭包现取的理由
 */

import { createSourceRegistry } from "@/datasource/registry.js";
import type { JsonFileRead } from "@/utils/json-file/index.js";
import { JsonAclSource } from "./json-source.js";
import type {
  AclConfig,
  AclLocator,
  AclReadOptions,
  AclSource,
  AclSourceFactory,
} from "./types.js";

/**
 * 名单驱动注册表（内置项只有 `json`）
 * @description `createSourceRegistry` 是三张同形表的唯一构造入口；内置项在**构造时**写入，
 * 故 `list()` 首次即含 `json`，而不必等某个模块被 import 到。
 */
const registry = createSourceRegistry<AclSourceFactory>("访问控制名单", {
  json: (locator) => new JsonAclSource(locator),
});

/**
 * 注册一个名单驱动名
 * @param driver - 驱动名。**大小写与前缀一律自负**（本仓不规范化）
 * @param factory - 该驱动的实现器工厂，接收定位串闭包
 * @param options - `override: true` 才允许覆盖已有注册项
 * @returns 幂等的退订函数
 * @throws 重名且未给 `override` 时抛错（**不静默替换**）
 * @example
 * ```ts
 * const off = registerAclSource("etcd", (locator) => new EtcdAclSource(locator));
 * off();  // 幂等；已被别人覆盖过则不删
 * ```
 */
export function registerAclSource(
  driver: string,
  factory: AclSourceFactory,
  options?: { override?: boolean },
): () => void {
  return registry.register(driver, factory, options);
}

/** 全部已注册驱动名（含内置项），供错误信息与诊断用 */
export function listAclSourceDrivers(): string[] {
  return registry.list();
}

/** 该驱动名是否已注册（装配前的自查用，避免靠捕获异常判断） */
export function hasAclSourceDriver(driver: string): boolean {
  return registry.has(driver);
}

/**
 * 按驱动名取工厂，**未注册即抛错**
 * @throws 错误文本点名驱动名并列出全部已注册项
 */
export function resolveAclSource(driver: string): AclSourceFactory {
  return registry.resolve(driver);
}

/** 实现器记忆表：`(接线, 驱动名) → 实现器` */
const sourceCaches = new WeakMap<AclLocator, Map<string, AclSource>>();

/**
 * 按配置面解析出该用哪个名单实现器（**带记忆**）
 * @description
 * 用 `WeakMap` 而不是 `Map<string, …>`：记忆跟着接线的生命周期走，它被回收时条目一起消失，
 * 不留悬垂引用。**记忆的只有「实现器是哪一个」**——定位串由闭包现取；反过来做
 * （把定位串烤进实现器再记忆）会让「热改名单路径」静默失效。
 *
 * ⚠️ **未注册驱动必须抛错，绝不落到 `json` 那一支**：驱动名是开放集合，
 * 而 `else → JsonAclSource` 会把 `ACL_DRIVER=mysql` 变成「静默按 json 跑」。判据在本函数
 * （装配点）而不是配置层，因为「有哪些驱动」是注册表这个运行时事实。
 *
 * @param locator - 装配接线（驱动名与位置都现取）
 * @param path - 显式定位覆盖（**一次性**：带了它就不进记忆表，那个实现器带着一次性的位置，
 *   不该被后续调用复用）
 */
export function aclSourceFor(locator: AclLocator, path?: string): AclSource {
  const driver = locator.driver();
  let byDriver = sourceCaches.get(locator);
  if (byDriver === undefined) {
    byDriver = new Map<string, AclSource>();
    sourceCaches.set(locator, byDriver);
  }
  const cached = byDriver.get(driver);
  if (cached !== undefined && path === undefined) {
    return cached;
  }
  const created = resolveAclSource(driver)(() => path ?? locator.path());
  if (path === undefined) {
    byDriver.set(driver, created);
  }
  return created;
}

/** `read` 的调用形态（`locator` 必填：决定读哪个驱动、哪份数据） */
export interface ReadAclOptions extends AclReadOptions {
  /** 必填装配接线：未显式给 `path` 时读它现取的位置。 */
  readonly locator: AclLocator;
}

/**
 * 读整份名单（判定期唯一读入口）
 * @throws `locator` 缺失时抛错；驱动未注册时经 `resolveAclSource` 抛错
 * @description `path` **不**转发给实现器：它已经被烤进那份一次性实现器的定位闭包里了。
 * 两处各说一次「读哪儿」就会有两个答案，而实现器不必猜该信哪个。
 */
export function readAcl(opts: ReadAclOptions): JsonFileRead<AclConfig> {
  if (!opts.locator) {
    throw new Error("readAcl 必须显式传入 locator");
  }
  return aclSourceFor(opts.locator, opts.path).read({
    force: opts.force,
    onEvent: opts.onEvent,
  });
}

/** 读整份名单只要 `value`（坏内容时是上一份有效值 / 空名单） */
export function loadAcl(locator: AclLocator, onEvent?: AclReadOptions["onEvent"]): AclConfig {
  return readAcl({ locator, onEvent }).value;
}

/**
 * 「配了访问控制」的**数据事实**判定：三组名单任一组非空即算配了。
 *
 * @description
 * 与 `runtime/services.ts:hasConfiguredQuota` **同构**（它也是「数据是否配了的唯一出口」）：
 * `runtime.start()` 启动期要报一条 `acl-inert` 告警，而**告警与判定必须是同一个函数**。
 * **判据是数据事实而不是配置猜测**：名单路径有没有被显式设置、跑的是哪个协议，都答不出
 * 「名单里有没有内容」；只有读才能答。
 *
 * ### 复用既有读取路径（**绝不许另开一个 `read()` 调用点**）
 *
 * 走的就是上面的 `loadAcl` → 实现器的 `read`；另开一个调用点会造成**两份节流缓存、两份解析、
 * 两套坏文件处理**并互相污染同一缓存键。纪律的变异测试（断言 `json-source.ts` 全文
 * `readJsonCached` 恰好一处）见 `../../../tests/unit/acl-configured.test.ts`。
 *
 * ### 读失败即 false
 *
 * 读不到名单（数据缺失 / 名单全空 / 统计或读取错误 / 坏内容且无历史）一律 `false`，
 * 于是**读不到名单时不告警**。语义是「**压根不知道配没配**」，不是「配了却没生效」——
 * 报出来是**误报**。宁可少报也不误报：一条会误报的告警被无视一次之后就再也起不到作用。
 * 真正读不到数据时**已经有别的可见信号**：`read` 经 `onEvent` 报 `error`、
 * runtime 转成 `config.file-error` 公共事件、CLI 落一条日志。
 *
 * @param locator - 必填装配接线（决定读哪个驱动、哪份数据）
 * @param onFileEvent - 状态观察面；与 `loadAcl` 同一份，用于发 `config.file-*` 事件
 * @returns 任一组的 whitelist 或 blacklist 非空即 `true`；缺失 / 全空 / 读失败即 `false`
 */
export function hasConfiguredAcl(
  locator: AclLocator,
  onFileEvent?: AclReadOptions["onEvent"],
): boolean {
  const acl = loadAcl(locator, onFileEvent);
  return (
    acl.clientIp.whitelist.length > 0 ||
    acl.clientIp.blacklist.length > 0 ||
    acl.target.whitelist.length > 0 ||
    acl.target.blacklist.length > 0 ||
    acl.upstream.whitelist.length > 0 ||
    acl.upstream.blacklist.length > 0
  );
}