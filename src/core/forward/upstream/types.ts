/**
 * upstream/types - 上游 HTTP 语义层契约
 * 每种上游协议一个文件实现此接口，forward/http 薄分发层按 upstreamProtocol 委派
 */

import type http from "node:http";
import type { TargetParts } from "@/core/proxy-helpers.js";
import type { PipeEventSink } from "@/core/types/pipe.js";

export interface UpstreamHandler {
  forward(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    target: TargetParts,
    onEvent?: PipeEventSink,
  ): void;
}
