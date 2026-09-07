/**
 * connectors/http - 明文 TCP 上游拨号
 * 从 forward/shared.dialUpstream 搬迁而来，行为保持一致：net.connect + guardDialing
 * 本层零日志，观测经 guardDialing 的 onEvent 槽上抛
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { guardDialing } from "@/core/proxy-helpers.js";
import type { DialGuardOptions } from "@/core/proxy-helpers.js";
import type { DialResult } from "@/core/types/connector.js";

export function dialHttpUpstream(
  clientSocket: Duplex,
  host: string,
  port: number,
  guardOpts?: DialGuardOptions,
): Promise<DialResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const upstreamSocket = net.connect(port, host, () => {
      settled = true;
      resolve({ socket: upstreamSocket as unknown as Duplex, dial });
    });
    const dial = guardDialing(clientSocket, upstreamSocket as unknown as Duplex, {
      timeout: get("upstreamTimeout"),
      target: `${host}:${port}`,
      ...guardOpts,
      onError: (err) => {
        guardOpts?.onError?.(err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      },
      onTimeout: () => {
        guardOpts?.onTimeout?.();
        if (!settled) {
          settled = true;
          reject(new Error(`[http] upstream timeout ${host}:${port}`));
        }
      },
    });
    upstreamSocket.once("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
