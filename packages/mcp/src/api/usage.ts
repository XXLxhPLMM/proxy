/**
 * @fileoverview `usage` 资源的两个端点 —— 全量账本 / 单个用户
 * @module api/usage
 * @description
 * ⚠️ **两条端点不同形**，这是这一层最容易被顺手写错的地方：全量那条的 `usage` 是**数组**，
 * 而 `GET /api/usage/:username` 的 `usage` 是**单个对象**。它们同名，所以「统一按数组处理」
 * 这种想当然的抽象在单用户那条上会静默炸掉 —— 故两个函数各自独立地校验自己的信封字段。
 *
 * 解包只发生在单用户那条：全量那条的出参是整个 `UsageBody`（`errors` / `lagMs` / `sideEffect`
 * / `note` 四段一并交出去，理由见 `types.ts` 里 `UsageOneBody` 的注释 —— 少了任何一段都会把
 * 「落文件的读取」当成纯读）。
 */

import { endpointPath, type ManagerHttp } from "../utils/request.js";
import { asRecord } from "./decode.js";
import type { UsageBody, UsageOneBody } from "./types.js";

const ALL_PATH = "/api/usage";
const ONE_TEMPLATE = "/api/usage/:username";
const ONE_WHAT = "GET /api/usage/:username 的 usage";

/** 读全量账本（**不解包**：`usage` 在这里就是数组，四段元信息一并返回） */
export async function getUsage(http: ManagerHttp): Promise<UsageBody> {
  const body = await http.request({ method: "GET", path: ALL_PATH });
  return body as unknown as UsageBody;
}

/** 读单个用户的账本行（解包后的 `usage` 对象） */
export async function getUsageFor(
  http: ManagerHttp,
  username: string,
): Promise<UsageOneBody["usage"]> {
  const path = endpointPath(ONE_TEMPLATE, username);
  const body = await http.request({ method: "GET", path });
  return asRecord(body["usage"], ONE_WHAT) as unknown as UsageOneBody["usage"];
}
