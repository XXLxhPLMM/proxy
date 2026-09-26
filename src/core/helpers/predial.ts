/**
 * @fileoverview 拨号前置守卫：自环 + 目标名单，命中即发事件并收尾
 * @module core/helpers/predial
 * @description
 * 收敛四个转发器（http/tunnel/websocket/socks）在「目标已解析、**尚未拨号**」处的
 * 重复判定。放在拨号之前是刻意的：自环与名单都是零 IO 的本地判定，拦住就不该
 * 建连接（代理环路会一路拨回自己，名单违规则根本不该出网）。
 *
 * 职责：
 * - `isSelfLoop`：目标是否指向自身监听地址（委托同目录 `self-loop.js:isSelfLoopAddr`，
 *   从显式配置访问器读 `host/port`）
 * - `guardPreDial`：自环 → 目标名单的顺序判定，命中发 `loop-detected` /
 *   `target-denied` 事件，再以状态码（自环 502 / 名单 403）调 `deny` 收尾闭包。
 *   名单判定合**两层**（全局 `acl.json` + 该用户 `users.json` 的个人名单），
 *   身份由调用方经 `user` 形参逐次传入——**本模块不读任何全局/实例状态**
 *
 * 不负责：
 * - **不做** `isValidTargetHost`：HTTP 路径由 `parseTargetParts`/`parseAuthority`
 *   解析时收口，SOCKS 原始字节在字节边界单独校验（见 `socks.connect`）
 * - 不解析目标（`target.js`）、不判路由（`route.js`）、不拨号
 * - 不打日志：事件上抛（`PipeEvent`），落盘收在 `src/server/index.ts`
 * - 不自己发协议应答：应答形态由协议自理（`deny(status)` 把状态码交回调用方）
 *
 * 依赖：`@/core/types/proxy.js`（`AccessControl` / `PipeEvent`，**均 type-only**）
 * + `./self-loop.js`（自环纯判定）+ `@/utils/constants/index.js` + `@/config/index.js`（类型）。
 * **判定走注入的 `access` 端口，不再 import `core/access-control.ts`**——与 `route.ts` 同一
 * 条纪律：`helpers/` 不反向依赖策略层，工具层压在策略层上面会让判定层一改就牵动工具层。
 *
 * 使用示例：
 * ```ts
 * if (guardPreDial({ emit: scope.emit, req, dial, dest, deny: (s) => fail(s), config, access })) return;
 * ```
 */

import type http from "node:http";
import type { ConfigAccessor } from "@/config/index.js";
import type { AccessControl, PipeEvent } from "@/core/types/proxy.js";
import { STATUS_BAD_GATEWAY, STATUS_FORBIDDEN } from "@/utils/constants/index.js";
import { isSelfLoopAddr } from "./self-loop.js";

/**
 * 判断是否为指向自身监听地址的自环请求
 * @description 委托同目录 `self-loop.js:isSelfLoopAddr`，从显式配置访问器读取 `host/port`
 * @param h - 目标主机名/IP
 * @param p - 目标端口
 * @param config - 配置访问器，必须由调用方显式注入；其 `host/port` 应承载启动快照语义
 * @returns 是否为自环（命中则应直接拒绝，避免代理环路）
 * @example isSelfLoop("127.0.0.1", 7890, config) // 若当前监听 127.0.0.1:7890 则为 true
 */
export function isSelfLoop(h: string, p: number, config: ConfigAccessor): boolean {
  return isSelfLoopAddr(h, p, config.get("host"), config.get("port"));
}

/**
 * 拨号前置守卫选项
 * @param emit - 事件汇（命中发 `loop-detected` / `target-denied`）
 * @param req - 原始请求（随事件带给日志；裸 socket 场景由 `clientAddr` 承担定位）
 * @param clientAddr - 客户端对端地址（SOCKS 等无 req 的场景）
 * @param dial - 拨号目标：**自环看的是它**（client 模式拨的是上游，上游指回自身监听地址会成环）
 * @param dest - 客户端请求的目标：**名单看的是它**（与 `proxyMode` 无关，上游永不进名单）
 * @param user - 已鉴权用户名：传给 `access.checkTarget` 判该用户的**个人名单**。
 *   省略即个人层中性放行，等价于只有全局名单生效
 * @param deny - 拒绝收尾闭包，入参为应答状态码（自环 502 / 名单 403），报文形态由协议自理
 * @param config - 配置访问器，必须由调用方显式注入；**只用于自环**（读 `host/port`）
 * @param access - 访问控制端口（名单判定），必须由调用方显式注入。**必填、无 `?`、无缺省档**
 */
export interface PreDialOptions {
  emit: (e: PipeEvent) => void;
  req?: http.IncomingMessage;
  clientAddr?: string;
  dial: { host: string; port: number };
  dest: { host: string; port: number };
  user?: string;
  deny: (status: number) => void;
  config: ConfigAccessor;
  access: AccessControl;
}

/**
 * 拨号前置守卫：自环 → 目标名单，命中即发事件并执行拒绝收尾
 * @description
 * 收敛四个转发器（http/tunnel/websocket/socks）在「目标已解析、尚未拨号」处的重复判定：
 * - 自环命中发 `loop-detected`、名单拒绝发 `target-denied`（带 `req` 或 `client` 供日志定位），
 *   随后以状态码调用 `deny` 收尾——HTTP 转发器回 403/502 报文，SOCKS 回失败应答，Upgrade 写原始状态行；
 * - **判定对象分两路**：`dial` 判自环（防代理环路），`dest` 判名单（全局 ∩ 该用户个人两层，
 *   经 `opts.access.checkTarget({ host, user })`）。**名单永不判上游**——上游地址只来自
 *   `upstream` 组，不受名单约束；
 * - **不做** `isValidTargetHost`：HTTP 路径由 `parseTargetParts`/`parseAuthority` 解析时收口，
 *   SOCKS 原始字节（不过 HTTP 解析器）在字节边界单独校验（见 `socks.connect`）
 * @param opts - 见 {@link PreDialOptions}
 * @returns true 表示已拒绝，调用方应立即 return
 * @example
 * ```ts
 * if (guardPreDial({ emit: scope.emit, req, dial, dest, deny: (s) => fail(s), config, access })) return;
 * ```
 */
export function guardPreDial(opts: PreDialOptions): boolean {
  const extra = {
    ...(opts.req ? { req: opts.req } : {}),
    ...(opts.clientAddr ? { client: opts.clientAddr } : {}),
  };

  if (isSelfLoop(opts.dial.host, opts.dial.port, opts.config)) {
    opts.emit({
      type: "loop-detected",
      target: `${opts.dial.host}:${opts.dial.port}`,
      ...extra,
    });
    opts.deny(STATUS_BAD_GATEWAY);
    return true;
  }

  // 身份经参数逐次传入（`ForwarderBase.preDial` 从 `RequestScope` 取 `scope.user` 注入）：
  // 本模块**不**读任何全局/实例状态，身份只在这一条链上流动
  const acl = opts.access.checkTarget({ host: opts.dest.host, user: opts.user });

  if (!acl.allowed) {
    opts.emit({
      type: "target-denied",
      target: `${opts.dest.host}:${opts.dest.port}`,
      host: opts.dest.host,
      reason: acl.reason,
      // 放行路径不写该键；拒绝路径它恒有值（判定层两关都带 source），缺失即「未知来源」
      ...(acl.source ? { source: acl.source } : {}),
      ...extra,
    });
    opts.deny(STATUS_FORBIDDEN);
    return true;
  }

  return false;
}
