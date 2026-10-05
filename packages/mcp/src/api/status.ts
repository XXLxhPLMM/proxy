/**
 * @fileoverview `GET /api/status` —— 本进程事实 + 数据面活状态 + 数据源事实
 * @module api/status
 * @description
 * 这一层**不解包**：服务端的 `reply()` 直接把 `StatusBody` 摆在顶层，没有信封。校验只到
 * 「顶层是对象」（由 `expectObject` 在请求层兜住），往下按 `types.ts` 断言。
 */

import type { ManagerHttp } from "../utils/request.js";
import { asRecord } from "./decode.js";
import type { StatusBody } from "./types.js";

const PATH = "/api/status";
const WHAT = "GET /api/status 的响应体";

/**
 * 读本进程与数据面状态
 * @description ⚠️ 返回体里的 `data.accounts` / `data.acl` / `data.usage` 是**路径**，
 * 不是内容 —— 要看内容得各自再打一次对应端点，本函数不做隐式多发。
 */
export async function getStatus(http: ManagerHttp): Promise<StatusBody> {
  const body = await http.request({ method: "GET", path: PATH });
  return asRecord(body, WHAT) as unknown as StatusBody;
}
