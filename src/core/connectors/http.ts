/**
 * connectors/http - 明文 TCP 上游拨号
 * 从 http-pipe.dialUpstream 搬迁而来，行为保持一致：net.connect + guardDialing
 * 本层零日志，观测经 guardDialing 的 onEvent 槽上抛
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { guardDialing } from "@/utils/proxy-helpers.js";
import type { DialGuardOptions } from "@/utils/proxy-helpers.js";
import type { DialCallback } from "@/core/types/connector.js";

export function dialHttpUpstream(
  clientSocket: Duplex,
  host: string,
  port: number,
  onConnect: DialCallback,
  guardOpts?: DialGuardOptions,
): void {
  const upstreamSocket = net.connect(port, host, () => {
    onConnect(upstreamSocket as unknown as Duplex, dial);
  });
  const dial = guardDialing(clientSocket, upstreamSocket as unknown as Duplex, {
    timeout: get("upstreamTimeout"),
    target: `${host}:${port}`,
    ...guardOpts,
  });
}
