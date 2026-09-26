/**
 * @fileoverview 上游协议 → 上游连接器 的唯一映射点
 * @module core/forward/upstream/connector/registry
 * @description
 * 六个 `ProxyProtocol` 映射到**四个**连接器类：TLS 承载是传输细节、不是协议身份，
 * 所以 `http` 与 `https` 共用 `HttpConnectConnector`（只差 `secure`）、
 * `sockss4`/`sockss5` 分别与 `socks4`/`socks5` 共用同一类。这张表是
 * 「协议 → 对接方式」的**唯一**定义处（此前四个转发器各写一份四连等分支，最容易漂移）。
 *
 * **fail-closed**：收到未登记的协议**抛错**，绝不静默回落 direct。
 * 「上游协议配错 → 静默直连」是**流量旁路**：对一个代理服务，那意味着流量绕过上游直出，
 * 表现为「服务还在跑、请求还成功、但根本没走你配的链路」——比直接报错糟糕得多。
 * 这个分支**可达**：CLI 路径的 `upstreamProtocol` 经 `FIELDS.parseEnum` fail-fast，
 * 但**库路径不经**——`createProxyRuntime({ config })` 走 `new ConfigStore(...)`，
 * 而 `ConfigStore` **零校验**（不跑 FIELDS 解析/范围/交叉校验），非法值能被直接注入。
 * 要不要 catch、怎么降级是 **channel** 的决定；registry 自己收到非法值就必须喊出来。
 *
 * **单例缓存按 `CoreContext` 隔离**：连接器**无状态**——`kind`/`targetForm` 是编译期常量、
 * `secure` 是构造期常量，而 `open()` / `upstreamAuthHeader()` / `selfLoopTarget()`
 * 全部**每次现读 `ctx.config`**（`Dialer` 同样只持有一份 `ctx`）。故同一 context 下复用
 * 同一实例是安全的，还省掉每请求新建连接器/`Dialer`。
 * 缓存键必须是 `CoreContext` 对象本身（`WeakMap`）：不同 runtime 派生不同 accessor，
 * 串用会让一个 runtime 的连接器读到另一个 runtime 的配置。
 */

import type { CoreContext } from "@/core/context.js";
import type { ProxyProtocol } from "@/core/types/proxy.js";
import { DirectConnector } from "./direct.js";
import { HttpConnectConnector } from "./http-connect.js";
import { Socks4Connector } from "./socks4.js";
import { Socks5Connector } from "./socks5.js";
import type { UpstreamConnector } from "./types.js";

/** 连接器工厂（`secure` 在此闭包里定死，registry 是它唯一的决定者） */
type ConnectorFactory = (ctx: CoreContext) => UpstreamConnector;

/** 缓存键：六个上游协议 + `direct`（直连不是 `upstreamProtocol` 的取值，故单列） */
type ConnectorKey = ProxyProtocol | "direct";

/**
 * 6 种 `ProxyProtocol`（外加 `direct`）→ 4 个连接器类的完整映射
 *
 * @description
 * `satisfies Record<ProxyProtocol, ConnectorFactory>` 剥掉 `direct` 那一行做穷尽性护栏
 * （`ProxyProtocol` 新增成员而本表漏登记即**编译失败**），同时保留每个键的精确函数类型。
 */
const PROTOCOL_FACTORIES = {
  http: (ctx: CoreContext) => new HttpConnectConnector(ctx, false),
  https: (ctx: CoreContext) => new HttpConnectConnector(ctx, true),
  socks4: (ctx: CoreContext) => new Socks4Connector(ctx, false),
  sockss4: (ctx: CoreContext) => new Socks4Connector(ctx, true),
  socks5: (ctx: CoreContext) => new Socks5Connector(ctx, false),
  sockss5: (ctx: CoreContext) => new Socks5Connector(ctx, true),
} satisfies Record<ProxyProtocol, ConnectorFactory>;

/** 完整映射（含 `direct`） */
const CONNECTOR_FACTORIES: Record<ConnectorKey, ConnectorFactory> = {
  ...PROTOCOL_FACTORIES,
  direct: (ctx: CoreContext) => new DirectConnector(ctx),
};

/**
 * 查表用的宽松视图
 *
 * @description
 * 运行时值可能绕过类型系统（配置错误、外部调用方强转），查表必须能表达「查不到」，
 * 否则 `if (!factory)` 会被 TS 判成恒假而失去 fail-closed 分支。
 */
const LOOKUP: Record<string, ConnectorFactory | undefined> = CONNECTOR_FACTORIES;

/** 每个 context 一张「键 → 连接器」表；context 被回收即随之回收（`WeakMap` 不阻止 GC） */
const CACHE = new WeakMap<CoreContext, Map<ConnectorKey, UpstreamConnector>>();

/** 按 context 取缓存表（缺则建空表并登记） */
function cacheFor(ctx: CoreContext): Map<ConnectorKey, UpstreamConnector> {
  let byKey = CACHE.get(ctx);

  if (!byKey) {
    byKey = new Map<ConnectorKey, UpstreamConnector>();
    CACHE.set(ctx, byKey);
  }

  return byKey;
}

/** 按键取/建连接器（缓存命中即复用；未登记的键 fail-closed 抛错） */
function resolve(key: ConnectorKey, ctx: CoreContext): UpstreamConnector {
  const byKey = cacheFor(ctx);
  const hit = byKey.get(key);

  if (hit) {
    return hit;
  }

  const factory = LOOKUP[key];

  if (!factory) {
    throw new Error(`unsupported upstream protocol: ${key}`);
  }

  const connector = factory(ctx);

  byKey.set(key, connector);

  return connector;
}

/**
 * 取「按上游协议对接」的连接器
 *
 * @description
 * - 映射：`http` → `HttpConnectConnector{secure:false}`、`https` → `{secure:true}`、
 *   `socks4` → `Socks4Connector{secure:false}`、`sockss4` → `{secure:true}`、
 *   `socks5` → `Socks5Connector{secure:false}`、`sockss5` → `{secure:true}`；
 * - 同一 context 下缓存单例（连接器无状态，见模块头说明）；
 * - 未知协议**抛错**（fail-closed，见模块头「流量旁路」论证；由调用方的 try/catch 决定怎么应答）。
 *
 * @param protocol - `upstreamProtocol` 的取值
 * @param ctx - 依赖上下文，必须显式注入（连接器的一切配置读取都经它）
 * @returns 与该协议对接的连接器
 * @throws protocol 未在映射表内登记
 * @example connectorFor("socks5", ctx).targetForm // => "origin"
 */
export function connectorFor(protocol: ProxyProtocol, ctx: CoreContext): UpstreamConnector {
  return resolve(protocol, ctx);
}

/**
 * 取「直连真实目标」的连接器
 *
 * @description
 * 与 {@link connectorFor} 共用同一张缓存（`direct` 是它的一个键）。
 * 语义提醒：**「用 direct 连接器」与「有效路由是 direct」是同一件事**——
 * `resolveRoute` 已判定 `route.route === "direct"` ⟺ 该拨真实目标，
 * 所以这里既不需要也不接受额外的「是否经上游」标志位。
 *
 * @param ctx - 依赖上下文，必须显式注入
 * @returns 直连连接器
 */
export function directConnector(ctx: CoreContext): DirectConnector {
  return resolve("direct", ctx) as DirectConnector;
}
