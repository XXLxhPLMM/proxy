/**
 * AuthChain - 链式鉴权穿透
 * 职责：
 * - 本级需鉴权(authEnabled=true)：校验 incoming token，成功则剥离 Proxy-Authorization 再转发，上游若需鉴权则由上游策略另行注入
 * - 本级放行(authEnabled=false)：原样透传 incoming 的 Proxy-Authorization，多级无鉴权节点持续穿透直到遇鉴权节点消费
 * 关联：core/auth (AuthProvider/TokenExtractor), client/forward-proxy
 */

import type http from "node:http";
import type { Duplex } from "node:stream";
import type { AuthProvider } from "../core/auth.js";
import { getToken } from "../core/auth.js";
import { getLogger } from "../utils/logger.js";

export interface ChainAuthOptions {
  localAuth: AuthProvider;
  /** 上游是否需鉴权时要注入的头值（Basic xxx），由 forward-proxy 按 remoteUsername/password 预计算 */
  upstreamAuthHeader?: string;
}

export class AuthChain {
  private readonly log = getLogger("AuthChain");
  constructor(private readonly opts: ChainAuthOptions) {}

  /**
   * 处理入站鉴权，返回是否放行及需要转发给上游的 headers 调整
   * @param ctx - 鉴权上下文（req + socket + authority）
   * @returns passed 是否放行，strip 是否剥离入站 Proxy-Authorization，inject 是否需注入上游头
   */
  async process(ctx: {
    req: http.IncomingMessage;
    socket: Duplex;
    authority: string;
    protocol: string;
  }): Promise<{ passed: boolean; strip: boolean; injectUpstream: boolean; incomingToken?: string }> {
    const { localAuth, upstreamAuthHeader } = this.opts;
    // 无鉴权：直接透传
    // 通过 isEnabled 判断，避免直接读 store，也便于测试注入 Auth{enabled:false}
    const enabled = (localAuth as unknown as { isEnabled?: boolean })?.isEnabled ?? true;
    // 若类型为 none，即使 enabled 异常也视为放行
    const type = (localAuth as unknown as { authType?: string })?.authType;
    if (!enabled || type === "none") {
      // 不校验，透传 incoming
      const t = await getToken(ctx as never).catch(() => undefined);
      return { passed: true, strip: false, injectUpstream: !t && !!upstreamAuthHeader, incomingToken: t };
    }

    const incomingToken = await getToken(ctx as never).catch(() => undefined);
    const passed = await localAuth.authenticate(ctx as never);
    if (!passed) return { passed: false, strip: false, injectUpstream: false, incomingToken };

    // 本级消费成功，剥离入站头，避免泄露到上游
    // 上游若需鉴权，注入新的头
    return { passed: true, strip: true, injectUpstream: !!upstreamAuthHeader, incomingToken };
  }

  /** 从 req 剥离 Proxy-Authorization（同时清理 proxy-authorization 小写变体） */
  static stripProxyAuth(req: http.IncomingMessage): void {
    delete (req.headers as Record<string, unknown>)["proxy-authorization"];
    delete (req.headers as Record<string, unknown>)["Proxy-Authorization"];
  }
}
