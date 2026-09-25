/**
 * @fileoverview 拨号前置守卫：自环 + 目标名单，命中即发事件并收尾
 * @module core/helpers/predial
 * @description
 * 收敛四个转发器（http/tunnel/websocket/socks）在「目标已解析、**尚未拨号**」处的
 * 重复判定。放在拨号之前是刻意的：自环与名单都是零 IO 的本地判定，拦住就不该
 * 建连接（代理环路会一路拨回自己，名单违规则根本不该出网）。
 *
 * 职责：
 * - `isSelfLoop`：目标是否指向自身监听地址（委托同目录 `self-loop.ts:isSelfLoopAddr`，
 *   从显式配置访问器读 `host/port`）
 * - `guardPreDial`：自环 → 目标名单的顺序判定，命中发 `loop-detected` /
 *   `target-denied` 事件，再以状态码（自环 502 / 名单 403）调 `deny` 收尾闭包
 *
 * 不负责：
 * - **不做** `isValidTargetHost`：HTTP 路径由 `parseTargetParts`/`parseAuthority`
 *   解析时收口，SOCKS 原始字节在字节边界单独校验（见 `socks.connect`）
 * - 不解析目标（`target.ts`）、不判路由（`route.ts`）、不拨号
 * - 不打日志：事件上抛（`PipeEvent`），落盘收在 `src/server/index.ts`
 * - 不自己发协议应答：应答形态由协议自理（`deny(status)` 把状态码交回调用方）
 *
 * 依赖：`@/core/access-control.js`（`checkTargetHost`）+ `@/core/types/proxy.js`
 * （`PipeEvent`）+ `./self-loop.js`（自环纯判定）+ `@/utils/constants/index.js` +
 * `@/config/index.js`（类型）。
 *
 * 使用示例：
 * ```ts
 * if (guardPreDial({ emit: this.emit, req, dial, dest, deny: (s) => this.failEarly(res, s), config })) return;
 * ```
 */

import type http from "node:http";
import type { ConfigAccessor } from "@/config/index.js";
import { checkTargetHost } from "@/core/access-control.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { STATUS_BAD_GATEWAY, STATUS_FORBIDDEN } from "@/utils/constants/index.js";
import { isSelfLoopAddr } from "./self-loop.js";

/**
 * 判断是否为指向自身监听地址的自环请求
 * @description 委托同目录 `self-loop.ts:isSelfLoopAddr`，从显式配置访问器读取 `host/port`
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
 * @param deny - 拒绝收尾闭包，入参为应答状态码（自环 502 / 名单 403），报文形态由协议自理
 * @param config - 配置访问器，必须由调用方显式注入；用于自环与目标名单判定
 */
export interface PreDialOptions {
  emit: (e: PipeEvent) => void;
  req?: http.IncomingMessage;
  clientAddr?: string;
  dial: { host: string; port: number };
  dest: { host: string; port: number };
  deny: (status: number) => void;
  config: ConfigAccessor;
}

/**
 * 拨号前置守卫：自环 → 目标名单，命中即发事件并执行拒绝收尾
 * @description
 * 收敛四个转发器（http/tunnel/websocket/socks）在「目标已解析、尚未拨号」处的重复判定：
 * - 自环命中发 `loop-detected`、名单拒绝发 `target-denied`（带 `req` 或 `client` 供日志定位），
 *   随后以状态码调用 `deny` 收尾——HTTP 转发器回 403/502 报文，SOCKS 回失败应答，Upgrade 写原始状态行；
 * - **不做** `isValidTargetHost`：HTTP 路径由 `parseTargetParts`/`parseAuthority` 解析时收口，
 *   SOCKS 原始字节（不过 HTTP 解析器）在字节边界单独校验（见 `socks.connect`）
 * @param opts - 见 {@link PreDialOptions}
 * @returns true 表示已拒绝，调用方应立即 return
 * @example
 * ```ts
 * if (guardPreDial({ emit: this.emit, req, dial, dest, deny: (s) => this.failEarly(res, s), config })) return;
 * ```
 */
export function guardPreDial(opts: PreDialOptions): boolean {
  const { config } = opts;
  const extra = {
    ...(opts.req ? { req: opts.req } : {}),
    ...(opts.clientAddr ? { client: opts.clientAddr } : {}),
  };

  if (isSelfLoop(opts.dial.host, opts.dial.port, config)) {
    opts.emit({
      type: "loop-detected",
      target: `${opts.dial.host}:${opts.dial.port}`,
      ...extra,
    });
    opts.deny(STATUS_BAD_GATEWAY);
    return true;
  }

  const acl = checkTargetHost(opts.dest.host, config);

  if (!acl.allowed) {
    opts.emit({
      type: "target-denied",
      target: `${opts.dest.host}:${opts.dest.port}`,
      host: opts.dest.host,
      reason: acl.reason,
      ...extra,
    });
    opts.deny(STATUS_FORBIDDEN);
    return true;
  }

  return false;
}
