/**
 * 活体 socket 事实嗅探 - 只读 socket 自身暴露的地址字段，不做任何强转
 * 职责：
 * - `getSocketAddress`：远端地址（客户端 IP 展示、SOCKS 审计），统一 `"unknown"` 哨兵
 * - `getSocketLocalBinding`：本地绑定地址/端口（SOCKS 成功应答的 BND 字段）
 * 设计：
 * - 鸭子类型：真实 `net.Socket` / `tls.TLSSocket` 与测试替身都满足，不强转具体类型
 * - 字段缺失即「事实不存在」，返回 undefined / 省略该键，**不返回 "unknown" 之类哨兵**
 *   污染 SOCKS 应答的协议字段；只有面向日志/审计的 `getSocketAddress` 才用哨兵，
 *   以便下游区分「取不到」与「取到空值」
 * - 纯读取，无 IO、无日志、无配置依赖
 */

/** 从未知形状的套接字嗅探远端地址，非字符串或空串一律视为缺失 */
function socketAddress(sock: unknown): string | undefined {
  if (typeof sock === "object" && sock !== null && "remoteAddress" in sock) {
    const v = (sock as { remoteAddress?: unknown }).remoteAddress;
    if (typeof v === "string" && v) {
      return v;
    }
  }
  return undefined;
}

/** 本地绑定事实：两个字段各自可缺失（取不到就由调用方决定回退） */
export interface SocketLocalBinding {
  /** localAddress 原样文本（可能是 v4-mapped IPv6 `::ffff:a.b.c.d`，由调用方归一） */
  address?: string;
  /** localPort；非整数/越界一律视为缺失 */
  port?: number;
}

/**
 * 取套接字远端地址（统一 "unknown" 哨兵）
 * @description 转发层多处需要「客户端地址」展示（守卫路由、SOCKS 审计）：
 * 原先是各自内联的 `(socket as unknown as {remoteAddress?: string}).remoteAddress ?? "unknown"`，
 * 收敛到此一处，避免类型强转散落。哨兵 "unknown" 而非空串：日志/审计可区分「取不到」与「取到空值」
 * @param sock - 任意可能的套接字（真实 net/tls socket 或测试替身）
 * @returns remoteAddress 为非空字符串时返回它，否则返回 "unknown"
 * @example getSocketAddress(socket) // => "127.0.0.1" | "unknown"
 */
export function getSocketAddress(sock: unknown): string {
  return socketAddress(sock) ?? "unknown";
}

/**
 * 取套接字本地绑定地址/端口
 * @description SOCKS 成功应答的 BND.ADDR/BND.PORT（RFC1928 §6）要填服务端实际绑定地址，
 * 事实只存在于**出站 socket** 的 localAddress/localPort 上；取不到时返回空对象由调用方回退。
 * @param sock - 任意可能的套接字（真实 net/tls socket 或测试替身）
 * @returns 取到的本地绑定事实；缺失字段不出现（绝不返回 "unknown" 哨兵，那会污染协议字段）
 * @example getSocketLocalBinding(sock) // => { address: "::ffff:127.0.0.1", port: 54321 }
 */
export function getSocketLocalBinding(sock: unknown): SocketLocalBinding {
  if (typeof sock !== "object" || sock === null) {
    return {};
  }
  const local = sock as { localAddress?: unknown; localPort?: unknown };
  const binding: SocketLocalBinding = {};

  if (typeof local.localAddress === "string" && local.localAddress) {
    binding.address = local.localAddress;
  }
  if (
    typeof local.localPort === "number" &&
    Number.isInteger(local.localPort) &&
    local.localPort >= 0 &&
    local.localPort <= 0xffff
  ) {
    binding.port = local.localPort;
  }

  return binding;
}
