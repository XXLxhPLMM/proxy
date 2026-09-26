/**
 * @fileoverview 上游连接器的**供给源**：协议 → 连接器的唯一映射，装配期注入
 * @module core/forward/upstream/connector/registry
 * @description
 * 六个 `ProxyProtocol` 映射到**四个**连接器类：TLS 承载是传输细节、不是协议身份，
 * 所以 `http` 与 `https` 共用 `HttpConnectConnector`（只差 `secure`）、
 * `sockss4`/`sockss5` 分别与 `socks4`/`socks5` 共用同一类。这张表是
 * 「协议 → 对接方式」的**唯一**定义处——四份拷贝是最容易漂移的形态。
 *
 * 出口只有 {@link createConnectorSource} 一个：它按 {@link ConnectorSource} 端口交出
 * 「直连 / 走上游」两个连接器，**由装配期造一次注入转发器**。⚠️ **「直连」不是特例**：
 * 它只是「不上游」的一个取值，与走上游同属那张表的行。
 *
 * ## 为什么在装配期解析（不是每请求查表）
 *
 * `UPSTREAM_PROTOCOL` 是 **startup 相位**字段（`FIELDS.keysByPhase().startup` 决定，
 * accessor 对它读 runtime 构造时的冻结值）。每请求重读它有两个问题：① 白读——startup 键
 * 构造后不再变；② 与「startup 键不随 store 热改变变」这条不变量正面冲突，那会让读代码的人
 * 误以为它是可热改的。端口把「用哪个」在装配期定死，请求路径只问「这一档要哪个」。
 *
 * ## fail-closed：请求期抛错，**不是**装配期抛错
 *
 * 未登记的协议**抛错**，绝不静默回落 direct。「上游协议配错 → 静默直连」是**流量旁路**：
 * 流量绕过上游直出，外部表现是「服务还在跑、请求还成功、但根本没走你配的链路」，
 * 比直接报错糟糕得多。
 *
 * 抛点**刻意留在请求期**（`upstream()` 第一次被调），不在 `createConnectorSource` 那一刻：
 * - ① **行为逐字不变**：护栏 `tests/integration/upstream-protocol-fail-closed.test.ts` 从
 *   **库路径**注入 `"ftp"`（`ConfigStore` 零校验，故该分支可达），断言的是**请求期**表现为
 *   `forward.error` + **源站零字节**。抛点前移会让那条 `forward.error` 事实消失、改成启动期
 *   异常——那是换掉了一个安全属性（从「静默旁路」变成「起不来」，运维可见性反而更差：
 *   一条都没发出去的代理比一条 `forward.error` 更难定位是哪个请求撞上了）。
 * - ② **server 模式部署不该为无关字段付代价**：`proxyMode: "server"` 下有效路由恒 direct，
 *   `upstream()` 一次都不会被调，上游那组字段**根本不被读**。装配期就为它抛，等于让
 *   「上游字段填错」打挂一个压根不上游的服务。
 * - ③ 想要「启动就报错」，正确位置是**配置校验层**——CLI 路径的 `FIELDS.parseEnum` 已经
 *   fail-fast，库路径的 `ConfigStore` 零校验是**库调用方自己的责任**。
 *   `createConnectorSource` 拿不到 `configDir`、也不该知道「这是一个 runtime 的装配根」，
 *   在这里加校验等于把承载体变成校验层，撕开「缺省解析与校验只发生在唯一组装根」那条纪律。
 *
 * 代价是每次进程生命周期内**至多查一次表**（记忆在闭包里），请求路径零次。
 *
 * ## ⚠️ 记忆化的正确性挂在「`UPSTREAM_PROTOCOL` 是 startup 相位」这条不变式上
 *
 * 一次 source 只问一次表、只认第一次看到的协议。这在**当前**是成立的：accessor 对 startup 键
 * 读 runtime 构造时的冻结值，进程活着的每一天它都返回同一个值，所以「第一次问」与「每次问」
 * 等价。**哪天 `UPSTREAM_PROTOCOL` 被重分类成 runtime 相位**（热改即时生效），这份记忆就
 * 立刻变成**第二真相源**——改完配置不重启，source 仍握着旧协议的连接器，且没有任何报错。
 * 那时必须删掉这里的记忆（每次问表），而不是「加个失效钩子」：一个能被热改的键，
 * 就该每次现读。改动 `FIELDS` 里 `UPSTREAM_PROTOCOL` 的 phase 时**必须**先看这一段。
 *
 * 回归护栏：`tests/integration/upstream-protocol-fail-closed.test.ts`（行为级）+
 * `tests/unit/connector-registry.test.ts`（单元级）。
 */

import type { CoreContext } from "@/core/context.js";
import type { ProxyProtocol } from "@/core/types/proxy.js";
import { DirectConnector } from "./direct.js";
import { HttpConnectConnector } from "./http-connect.js";
import { Socks4Connector } from "./socks4.js";
import { Socks5Connector } from "./socks5.js";
import type { ConnectorSource, UpstreamConnector } from "./types.js";

/** 连接器工厂（`secure` 在这张表的每个工厂里定死，本表是它唯一的决定者） */
type ConnectorFactory = (ctx: CoreContext) => UpstreamConnector;

/**
 * 6 种 `ProxyProtocol` → 4 个连接器类的完整映射
 *
 * @description
 * `satisfies Record<ProxyProtocol, ConnectorFactory>` 剥掉「查不到」那支做穷尽性护栏
 * （`ProxyProtocol` 新增成员而本表漏登记即**编译失败**），同时保留每个键的精确函数类型。
 *
 * **表里没有 `direct`**：直连不是 `ProxyProtocol` 的取值（它不与任何上游协议对话），
 * 由 {@link createConnectorSource} 直接 `new DirectConnector(ctx)`。端口上的「两行」
 * 说的是**形状**，不是这张表的内容。
 */
const PROTOCOL_FACTORIES = {
  http: (ctx: CoreContext) => new HttpConnectConnector(ctx, false),
  https: (ctx: CoreContext) => new HttpConnectConnector(ctx, true),
  socks4: (ctx: CoreContext) => new Socks4Connector(ctx, false),
  sockss4: (ctx: CoreContext) => new Socks4Connector(ctx, true),
  socks5: (ctx: CoreContext) => new Socks5Connector(ctx, false),
  sockss5: (ctx: CoreContext) => new Socks5Connector(ctx, true),
} satisfies Record<ProxyProtocol, ConnectorFactory>;

/**
 * 查表用的宽松视图
 *
 * @description
 * 运行时值可能绕过类型系统（配置错误、外部调用方强转），查表必须能表达「查不到」，
 * 否则 `if (!factory)` 会被 TS 判成恒假而失去 fail-closed 分支。
 */
const LOOKUP: Record<string, ConnectorFactory | undefined> = PROTOCOL_FACTORIES;

/**
 * 按 startup 相位的 `upstreamProtocol` 取「走上游」的连接器；未登记即 fail-closed 抛错
 *
 * @description
 * 报错文案**逐字不变**（`unsupported upstream protocol: <值>`）——它会经调用方的 catch
 * 进落盘日志与公共事件载荷，`tests/integration/upstream-protocol-fail-closed.test.ts`
 * 按 `unsupported upstream protocol` 子串断言成因。
 *
 * @param ctx - 依赖上下文；协议与上游地址/凭证/超时都经 `ctx.config` 读取
 * @returns 与该协议对接的连接器
 * @throws `upstreamProtocol` 未在 {@link PROTOCOL_FACTORIES} 内登记（**fail-closed**，
 *   绝不静默回落直连，理由见模块头）
 */
function resolveUpstream(ctx: CoreContext): UpstreamConnector {
  const protocol = ctx.config.get("upstreamProtocol");
  const factory = LOOKUP[protocol];

  if (!factory) {
    throw new Error(`unsupported upstream protocol: ${protocol}`);
  }

  return factory(ctx);
}

/**
 * 造一份「直连 / 走上游」的连接器供给源（**装配期一次**，跨请求复用）
 *
 * @description
 * - 映射：`http` → `HttpConnectConnector{secure:false}`、`https` → `{secure:true}`、
 *   `socks4` → `Socks4Connector{secure:false}`、`sockss4` → `{secure:true}`、
 *   `socks5` → `Socks5Connector{secure:false}`、`sockss5` → `{secure:true}`；
 * - **两个连接器各至多构造一次并记忆**在闭包里：连接器**无状态**——`kind`/`targetForm` 是
 *   编译期常量、`secure` 是构造期常量，而 `open()` / `transport()` /
 *   `upstreamAuthHeader()` / `selfLoopTarget()` 全部**每次现读 `ctx.config`**
 *   （`Dialer` 同样只持有一份 `ctx`）。故复用同一实例安全，还省掉每请求新建连接器/`Dialer`。
 *   隔离**由闭包天然保证**（每个 source 只闭包一份 `ctx`）——所以**别给「每请求查表」配一份
 *   `WeakMap<CoreContext, …>` 缓存表**：那只是给一件不该每请求做的事加了一层缓存，
 *   而每请求查表本身与「startup 键不随 store 热改变变」正面冲突。
 *   **⚠️ 记住「记忆协议」这件事正确性挂在 startup 相位上**（模块头有专段论证）：同一个
 *   source 永远只认第一次看到的 `upstreamProtocol`，热改相位会让它变成第二真相源。
 * - **本工厂零分配、零配置读取**：查表与构造都推迟到第一次真被问（记忆化）。`direct()` 恒成功；
 *   `upstream()` 惰性的理由（server 模式下上游字段根本不被读）见模块头「fail-closed」一节。
 *
 * @param ctx - 依赖上下文，必须显式注入（连接器的一切配置读取都经它）
 * @returns 装配期注入用的连接器来源
 * @example
 * const connectors = createConnectorSource(ctx);
 * connectors.upstream().targetForm; // => "origin"（upstreamProtocol = "socks5"）
 * connectors.direct().kind; // => "direct"
 */
export function createConnectorSource(ctx: CoreContext): ConnectorSource {
  let direct: DirectConnector | undefined;
  let upstream: UpstreamConnector | undefined;

  return {
    direct(): UpstreamConnector {
      direct ??= new DirectConnector(ctx);

      return direct;
    },

    upstream(): UpstreamConnector {
      // `??=` 在右侧抛错时**不赋值**：非法协议每次都重新查、每次都抛，绝不会出现
      // 「第一次抛、第二次悄悄给一个直连」那样的旁路——那正好是本模块要消灭的那类退化。
      upstream ??= resolveUpstream(ctx);

      return upstream;
    },
  };
}
