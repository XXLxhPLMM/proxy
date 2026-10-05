/**
 * @fileoverview `GET /api/config` —— 全量配置，逐键标相位与来源
 * @module api/config
 * @description
 * ⚠️ **只有读**：服务端刻意没有配置写端点（改了要么改 `.env*` 要么改 argv）。所以这一层
 * 只有一个函数，且它返回的是「值**可能已被打码**」的快照 —— `secret: true` 的键其 `value`
 * 不是明文，不要把它当「读回来就能改回去」的凭据。
 *
 * 同样不解包：`ConfigBody` 就是顶层对象。
 */

import type { ManagerHttp } from "../utils/request.js";
import { asRecord } from "./decode.js";
import type { ConfigBody } from "./types.js";

const PATH = "/api/config";
const WHAT = "GET /api/config 的响应体";

/**
 * 读全量配置视图
 * @description `phase === "startup"` 的键改完必须重启进程才生效 —— 这一层不判断怎么改，
 * 只负责把「改不改得重启」这个事实原样带到模型面前。
 */
export async function getConfig(http: ManagerHttp): Promise<ConfigBody> {
  const body = await http.request({ method: "GET", path: PATH });
  return asRecord(body, WHAT) as unknown as ConfigBody;
}
