/**
 * @fileoverview 路由插件默认实现 - 「走直连还是走上游」的唯一决策点
 * @module plugins/routing-provider
 * @description
 * 本文件是 `RoutingProvider` 的默认实现，也是**整个转发链路上唯一允许读配置做
 * 决策的地方**。它在「目标已解析、尚未拨号」处被调用一次，产出一个自包含的
 * `ForwardPlan`；此后所有转发器只消费这份计划，一个配置项都不再读。
 *
 * 它取代了此前散落在 `proxy-helpers.ts` 的 `resolveRoute()` +
 * `resolveForwardTargets()` + `guardPreDial()` 三处半状态判定——那三处各自读全局
 * store，于是「选上游」与「连上游」死锁在同一个函数里，既换不掉路由策略，也
 * 无法让同进程的两个实例走不同的上游。
 *
 * 判定顺序（**安全边界的一部分，不得调换**）：
 * ```
 * 1. 路由决策  mode 决定 dial 是真实目标还是上游端点
 * 2. 自环判定  看 dial —— client 模式下拨的是上游，上游指回自身监听会成环
 * 3. 目标名单  看 dest —— 客户端请求的目标；上游地址永不进名单
 * ```
 * 客户端 IP 名单、流量配额与鉴权**不在这里**：它们发生在进入本插件之前
 * （协议插件的连接与请求入口处、以及入站侧拨号前的最后一道闸门），早于目标解析。
 * 把它们塞进来会让「谁能进来」和「往哪走」变成同一个判定，安全顺序就说不清了。
 *
 * 自环 → 502、名单 → 403，两者的状态码语义不同，**绝不能合并**（合并成 400 是
 * 一次真实的行为回归，见 `core/AGENTS.md` 的判定顺序条）。配额用尽是第三条路
 * → 429（入站侧 `InboundForwarderBase.admit` 判定，不在本插件）。
 */

import type { ConfigScope } from "@/config/scope.js";
import { isSelfLoop, isSocksProto, isTlsUpstreamProto } from "@/core/proxy-helpers.js";
import type {
  ForwardPlan,
  ForwardTarget,
  RoutingInput,
  RoutingOutcome,
  UpstreamEndpoint,
} from "@/core/types/plan.js";
import type { AccessControlProvider, RoutingProvider } from "./contracts.js";

/**
 * 上游协议 → 传输策略标识
 * @description SOCKS 系走 SOCKS 握手（`socks-upstream`），其余走 CONNECT
 * （`http-upstream`）。这是「传输方式」维度的唯一映射，集中在纯函数里便于单测；
 * **不要**在调用点按字符串散判。
 */
function transportForUpstream(protocol: string): ForwardPlan["transport"] {
  return isSocksProto(protocol) ? "socks-upstream" : "http-upstream";
}

/**
 * 上游端点的 TLS 承载 = 显式配置 **或** 协议本身没有明文形态
 * @description
 * 两个来源必须取并集，缺一不可：
 *
 * - **`upstreamSecure`（显式）**：`UPSTREAM_URL=https://…` 经 `applyUpstreamUrl` 会同时
 *   写 `upstreamProtocol=https` + `upstreamSecure=true`，也会有人手工设 `UPSTREAM_SECURE=true`
 *   却把协议留成 `http`。两种都得尊重。
 * - **`isTlsUpstreamProto(protocol)`（推导）**：`sockss4`/`sockss5` 按定义就是
 *   **SOCKS over TLS，没有明文形态**。只配 `UPSTREAM_PROTOCOL=sockss5` 而不碰
 *   `UPSTREAM_SECURE`（默认 `false`）是完全正常的配置，丢掉推导就等于把用户静默
 *   降级成「往 TLS 端口发明文 SOCKS 握手」——连不上，且没有任何报错说明原因。
 *
 * 旧内核的 `tunnel.ts` 是硬编码分支（`proto === "https"` → 恒 TLS），
 * `UPSTREAM_SECURE` 实际上**无人读取**，是个声称可配、实际不生效的死配置；
 * 重构把它接上了，却没同时保留协议推导，两头都丢。**并集是唯一正确形态**：
 * 既修回推导，也修好那个死配置。
 */
function secureForUpstream(protocol: string, explicit: boolean): boolean {
  return explicit || isTlsUpstreamProto(protocol);
}

/** `http-request` 载荷只对普通 HTTP 请求方法成立；隧道/升级/SOCKS 一律裸流。 */
function payloadForInbound(inbound: RoutingInput["inbound"]): ForwardPlan["payload"] {
  return inbound === "http" ? "http-request" : "raw-stream";
}

/**
 * 创建路由插件的默认实现
 *
 * @param scope - 本实例配置作用域（活的，热重载后判定自动跟随）
 * @param acl - 本实例访问控制插件
 * @returns 路由插件；可安全地被多个并发连接调用（内部无状态）
 */
export function createRoutingProvider(
  scope: ConfigScope,
  acl: AccessControlProvider,
): RoutingProvider {
  return {
    plan(input: RoutingInput): RoutingOutcome {
      const { inbound, target, username } = input;
      const listen = { host: scope.get("host"), port: scope.get("port") };

      // ---- 1. 路由决策：先定有效模式，才知道 dial 到底是谁 ----
      const mode = scope.get("proxyMode");
      let transport: ForwardPlan["transport"];
      let upstream: UpstreamEndpoint | undefined;
      let routeReason: string | undefined;
      let routeScope: "instance" | "user" | undefined;

      if (mode !== "client") {
        // server 配置：恒直连，且**刻意不查 upstream 组**（零开销短路）
        transport = "direct-stream";
      } else {
        // 身份（username）透传给名单判定：账号自己的 upstream 组是**第二道**独立闸门，
        // 与实例级的那一道在 acl 实现里按固定顺序串联（不合并两份名单）
        const decision = acl.checkUpstreamRoute(target.host, username);
        if (decision.direct) {
          // 命中路由名单 → 回落按 server 语义处理（拨号目标/凭证/Host 回写全部自然直连）
          transport = "direct-stream";
          routeReason = decision.reason;
          routeScope = decision.scope;
        } else {
          // 上游端点在**决策时一次冻结**：转发器据此选 net.connect / tls.connect，
          // 再也不读配置。protocol 读一次复用（transport 与 secure 两个投影都依赖它）。
          const protocol = scope.get("upstreamProtocol");
          const username = scope.get("upstreamUsername");
          transport = transportForUpstream(protocol);
          upstream = {
            protocol,
            host: scope.get("upstreamHost"),
            port: scope.get("upstreamPort"),
            secure: secureForUpstream(protocol, scope.get("upstreamSecure")),
            // 凭证只在显式配置了用户名时存在；空串不携带，绝不产出 `Basic ` 空值头
            ...(username ? { username, password: scope.get("upstreamPassword") } : {}),
          };
        }
      }

      // dial 目标：直连就是真实目标，经上游就是上游端点
      const dial: ForwardTarget =
        upstream === undefined
          ? target
          : { host: upstream.host, port: upstream.port, path: input.requestPath || "/" };

      // ---- 2. 自环判定：看 dial（client 模式下即上游）----
      if (isSelfLoop(dial.host, dial.port, listen)) {
        return {
          ok: false,
          rejection: {
            reason: "loop-detected",
            status: 502,
            detail: `${dial.host}:${dial.port}`,
          },
        };
      }

      // ---- 3. 目标名单判定：看 dest（客户端请求的目标，上游永不进名单）----
      // 两道独立闸门（实例级 → 账号级）在 AccessControlProvider 内部串联；
      // `scope` 如实报出是哪一道拦下的，绝不在这里合并两份名单
      const aclDecision = acl.checkTargetHost(target.host, username);
      if (!aclDecision.allowed) {
        return {
          ok: false,
          rejection: {
            reason: "target-denied",
            status: 403,
            detail: aclDecision.reason,
            ...(aclDecision.scope === undefined ? {} : { scope: aclDecision.scope }),
          },
        };
      }

      // ---- 4. 计划自包含：目标 + 上游 + 传输方式 + 超时 + 出站 TLS 策略 + 自环基准全冻结 ----
      // upstreamTls 是 runtime 字段（热加载须立即生效）：每次 plan() 现读 scope 生成新计划，
      // 因此「冻结进计划」不损失热更新能力——改完配置对新请求即生效。
      return {
        ok: true,
        plan: {
          inbound,
          transport,
          target,
          ...(upstream === undefined ? {} : { upstream }),
          payload: payloadForInbound(inbound),
          timeoutMs: scope.get("upstreamTimeout"),
          listen,
          upstreamTls: {
            insecure: scope.get("upstreamInsecure"),
            ca: scope.get("upstreamCa"),
          },
          ...(routeReason === undefined ? {} : { routeReason }),
          ...(routeScope === undefined ? {} : { routeScope }),
        },
      };
    },
  };
}
