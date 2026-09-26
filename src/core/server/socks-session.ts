/**
 * SOCKS 会话处理器 - 四个 SOCKS server 共用的 onConn 主体
 * 职责：
 * - 把 socks4/socks5/sockss4/sockss5 四份逐字重复的「握手解析 → 鉴权 → 委派转发」收敛为一处
 * - 以 SocksSessionHost 最小接口注入 server 能力（protocol/forwarder/identity/authenticate/
 *   replyAndClose），使会话逻辑不依赖具体 server 类，明文与 TLS 分支共用同一份逻辑
 * - 明文与 TLS 的差异只在 host.protocol（协议名）上体现，故 authority 由协议名拼装：
 *   socks4 系带 `${protocol} host:port` 后缀，socks5 系为裸协议名
 * 设计：
 * - 不持有连接状态（登记/销毁由 socks-base.ts 负责），纯编排
 * - 失败收尾统一走 host.replyAndClose（桥接 writeReplyAndClose，写完延时销毁）
 * - socks5 的「无 token 审计」必须保留：客户端不支持 USER_PASS 时仍经 authorize 走 [auth] 审计
 */import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ProxyProtocol } from "@/core/types/proxy.js";
import type { IdentityProvider, IdentityResult } from "@/core/types/identity.js";
import type { SocksForwarder } from "@/core/forward/channel/socks.js";
import type { SocksHandshakeReader } from "@/core/forward/channel/socks-reader.js";
import type { InboundCredentials } from "@/core/server/admission.js";
import type { RequestScope } from "@/core/request-scope.js";
import type { RequestTerminal } from "@/core/request-terminal.js";
import {
  SOCKS4_REPLY_FAILURE,
  SOCKS5_AUTH_FAILURE,
  SOCKS5_AUTH_REJECT,
  SOCKS5_AUTH_SUCCESS,
  SOCKS5_METHOD_NO_AUTH,
  SOCKS5_METHOD_USER_PASS,
  SOCKS5_NO_AUTH,
  SOCKS5_SELECT_USERPASS,
} from "@/utils/constants/index.js";
import { buildProxyAuthValue, encodeBasicCredentials } from "@/core/helpers/index.js";

/**
 * 会话宿主：把 server 骨架能力以最小接口注入会话处理器
 * @param protocol - 本连接的协议标识（socks4/socks5/sockss4/sockss5），决定 authority 形态
 * @param forwarder - 复用的 SOCKS 转发器（握手解析 + 拨号建隧）；**跨会话共享单例**
 * @param identity - 身份端口，**只读 `isEnabled`** 决定 SOCKS5 选鉴方法分支
 *   （口径 = 「本实例会不会拒绝任何人」，`none` 模式已并入；**不要**在这里再判一次 `kind`，
 *   那是把同一个事实抄成第二份真相）
 * @param authenticate - **准入层阶段 B 的鉴权半段**（桥接 `InboundAdmission.authenticate`：
 *   关联 id 由它注入，凭证不通过时它已按 `respond` 回完应答并结算 `auth` 终态）。
 *   SOCKS 的凭证是握手状态机的产物（RFC1929 子协商 / SOCKS4 USERID），故只有它知道该合成
 *   什么样的 `req`；准入层只管「判定 + 终态」，两边职责正交
 * @param replyAndClose - 回失败应答并延时销毁，桥接 writeReplyAndClose
 * @param terminal - 当前连接的请求终态 guard；握手、建隧和失败应答共享同一实例
 * @param scopeFor - 准入层阶段 B 的 scope 半段（桥接 `InboundAdmission.scopeFor`：全仓唯一的
 *   `createRequestScope` 调用点）。握手阶段调用**不带 user**（此时还没鉴权），
 *   鉴权命中用户名后再要一条带 user 的——逐次传入，绝不落 forwarder 字段
 */
export interface SocksSessionHost {
  protocol: ProxyProtocol;
  forwarder: SocksForwarder;
  identity: IdentityProvider;
  authenticate(credentials: InboundCredentials, respond: () => void): Promise<IdentityResult>;
  replyAndClose(socket: Duplex, reply: Buffer): void;
  terminal: RequestTerminal;
  scopeFor(user?: string): RequestScope;
}

/**
 * 会话处理器：完成一次 SOCKS 会话（握手 → 鉴权 → 委派转发）
 */
export type SocksSessionRunner = (
  host: SocksSessionHost,
  socket: Duplex,
  reader: SocksHandshakeReader,
) => Promise<void>;

/**
 * SOCKS4/SOCKS4a 会话主体（socks4 与 sockss4 的 onConn 合并）
 * @description 解析请求（USERID 承载 token）→ 统一鉴权（authority 带 host:port）→
 * 解析/鉴权失败均回 SOCKS4_REPLY_FAILURE，成功交 forwarder.serveSocks4 建隧
 * @param host - 会话宿主
 * @param socket - 客户端双工流
 * @param reader - 共享握手读取器
 */
export async function runSocks4Session(
  host: SocksSessionHost,
  socket: Duplex,
  reader: SocksHandshakeReader,
): Promise<void> {
  /** 失败收尾：解绑读取器并回指定失败应答（桥接 writeReplyAndClose，写完延时销毁） */
  const fail = (reply: Buffer): void => {
    reader.dispose();
    host.replyAndClose(socket, reply);
  };

  const parsed = await host.forwarder.parseSocks4(reader, host.scopeFor());

  if (!parsed) {
    fail(SOCKS4_REPLY_FAILURE);
    host.terminal.reject("invalid-socks4-request", "parse");
    return;
  }

  const ok = await host.authenticate(
    {
      protocol: host.protocol,
      req: {
        headers: { "proxy-authorization": parsed.userid },
        socket,
      } as unknown as IncomingMessage,
      socket,
      authority: `${host.protocol} ${parsed.host}:${parsed.port}`,
    },
    () => fail(SOCKS4_REPLY_FAILURE),
  );

  if (!ok.passed) {
    return;
  }

  host.terminal.setContext({
    target: `${parsed.host}:${parsed.port}`,
    ...(ok.username !== undefined ? { user: ok.username } : {}),
  });
  host.forwarder.serveSocks4(socket, parsed, reader, host.scopeFor(ok.username));
}

/**
 * SOCKS5 会话主体（socks5 与 sockss5 的 onConn 合并）
 * @description 先读 greeting（兼容分段/流水线）→ 依 authEnabled 走选鉴分支：
 * - authEnabled 且不支持 USER_PASS：回 0xFF 后经 authorize 走 no-token 审计再销毁（审计不可省）
 * - authEnabled 且支持：回 0x02 走 RFC1929 子协商，失败回 0x01 0x01，成功回 0x01 0x00
 * - 非 authEnabled：不支持 NO_AUTH 则回 0xFF，否则回 0x05 0x00
 * 成功后委派 forwarder.serveSocks5Connect 读 CONNECT 建隧
 * @param host - 会话宿主
 * @param socket - 客户端双工流
 * @param reader - 共享握手读取器
 */
export async function runSocks5Session(
  host: SocksSessionHost,
  socket: Duplex,
  reader: SocksHandshakeReader,
): Promise<void> {
  /** 失败收尾：解绑读取器并回指定失败应答（桥接 writeReplyAndClose，写完延时销毁） */
  const fail = (reply: Buffer): void => {
    reader.dispose();
    host.replyAndClose(socket, reply);
  };

  // 先读 greeting，禁止未读就回 0x05 0xFF
  const methods = await host.forwarder.readGreeting(reader, host.scopeFor());

  if (!methods) {
    reader.dispose();
    socket.destroy();
    host.terminal.reject("invalid-socks5-greeting", "parse");
    return;
  }

  /**
   * 本部署是否启用身份识别：**只读 `isEnabled` 一个字段**
   *
   * @description ⚠️ **只读 `isEnabled`、绝不加判 `host.auth.authType !== "none"`。**
   *   之所以值得把「加错那条的代价」写在代码里：
   * - 那种写法**不会红、不会报错、行为也仍然等价**（`FileAccountIdentity.isEnabled` 的定义
   *   已含「会不会拒绝任何人」= `enabled && kind !== "none"`，两个条件是同一个事实的两次表达）。
   *   也就是说，改错了没有任何自动化信号——护栏不会亮、`tsc` 不会红、集成测试全绿。
   * - 但它错在一个**契约层**：`authType` 是 `Auth` 那个四合一实现的历史字段名，身份端口
   *   一旦可插值（自定义插件可能给任意 `kind`，见 `IdentityProvider.kind` 的注释），
   *   「`kind !== "none"`」就成了 core 内对插件取值的**硬编码假设**。插件给 `"off"` / `"disabled"`
   *   之类自定义值时，旧写法会把它当成「启用了」——**静默地把一个显式关闭身份识别的部署
   *   推进 RFC1929 子协商**，客户端在 greeting 阶段就被回 0xFF，且 `authenticate` 那次
   *   审计会记成「尝试识别但失败」而不是「未启用识别」。
   * - 单字段读法把这条假设**消掉在编译期之外、语义上**：端口的 `isEnabled` 就是给消费方
   *   的唯一答案（`identity/factory.ts` 与 `identity/modes.ts` 的注释都写着「消费方只读
   *   `isEnabled` 一个字段，不要自己判一次 `kind`」）。**这才是那条纪律真正的价值：
   *   它让「插件可以自定 `kind`」这件事不需要 core 跟着改。**
   */
  const authEnabled = !!host.identity.isEnabled;
  const hasNoAuth = methods.includes(SOCKS5_METHOD_NO_AUTH);
  const hasUserPass = methods.includes(SOCKS5_METHOD_USER_PASS);
  /** 已鉴权用户名：仅走过 RFC1929 子协商时才有值，无鉴权模式恒为 undefined */
  let authUser: string | undefined;

  if (authEnabled) {
    if (!hasUserPass) {
      // 经准入层的鉴权半段走统一 [auth] 审计（无 token → no-token），req 带 socket 才能取客户端地址。
      // 凭证必然不通过，准入层会按 respond 回 0xFF 并结算 `auth` 终态（审计不可省）
      await host.authenticate(
        {
          protocol: host.protocol,
          req: { headers: {}, socket } as unknown as IncomingMessage,
          socket,
          authority: host.protocol,
        },
        () => fail(SOCKS5_AUTH_REJECT),
      );
      return;
    }

    socket.write(SOCKS5_SELECT_USERPASS);

    const creds = await host.forwarder.readUserPass(reader);

    if (!creds) {
      // 非法 RFC1929 帧：这是**握手解析**失败、不是凭证判定失败，故不进准入层
      fail(SOCKS5_AUTH_FAILURE);
      host.terminal.reject("invalid-auth-message", "auth");
      return;
    }

    const b64 = encodeBasicCredentials(creds.user, creds.pass);
    const ok = await host.authenticate(
      {
        protocol: host.protocol,
        req: {
          headers: { "proxy-authorization": buildProxyAuthValue(b64) },
          socket,
        } as unknown as IncomingMessage,
        socket,
        authority: host.protocol,
      },
      () => fail(SOCKS5_AUTH_FAILURE),
    );

    if (!ok.passed) {
      return;
    }

    authUser = ok.username;
    if (authUser !== undefined) {
      host.terminal.setContext({ user: authUser });
    }
    socket.write(SOCKS5_AUTH_SUCCESS);
  } else {
    if (!hasNoAuth) {
      fail(SOCKS5_AUTH_REJECT);
      host.terminal.reject("proxy-auth-required", "auth");
      return;
    }

    socket.write(SOCKS5_NO_AUTH);
  }

  // 鉴权成功，读 CONNECT 包（复用同一 reader 承接流水线/分段）
  await host.forwarder.serveSocks5Connect(socket, reader, host.scopeFor(authUser));
}
