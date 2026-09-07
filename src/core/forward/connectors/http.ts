/**
 * connectors/http - 明文 TCP 上游拨号（HttpUpstreamConnector）
 * 从 forward/shared.dialUpstream 搬迁而来，行为保持一致：net.connect + guardDialing
 * 差异点只有 open()，dial 全流程在基类（connectors/base）
 * 本层零日志，观测经 guardDialing 的 onEvent 槽上抛
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseUpstreamConnector } from "./base.js";

export class HttpUpstreamConnector extends BaseUpstreamConnector {
  readonly protocol = "http" as const;

  protected open(host: string, port: number, onConnected: () => void): Duplex {
    return net.connect(port, host, onConnected);
  }
}
