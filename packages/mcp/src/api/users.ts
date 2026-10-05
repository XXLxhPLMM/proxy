/**
 * @fileoverview `users` 资源的五个端点 —— 列表 / 单条 / 新建 / 改 / 删
 * @module api/users
 * @description
 * 出参一律是**解包后的领域值**：服务端对单条用 `{account: X}`、对列表用 `{accounts: [...]}`，
 * 而这一层直接把 `X` / `[...]` 交出去。理由是消费面（`src/tools/`）不该每处都记得剥一层信封，
 * 且剥掉之后「模型看到的东西」与服务端业务对象同形，字段缺失时读得出「缺」而不是「空对象」。
 *
 * ⚠️ **写操作的请求体逐字段挑白名单**：`POST /api/users` 的服务端对未知键直接 400
 * （见根仓 `src/manager/routes/users.ts`），而模型给的参数常常带着服务端不认的额外键。
 * 挑白名单而不是整体转发，是把「哪些键合法」的知识收在这一层，不散到每个 tool 里。
 */

import { endpointPath, type ManagerHttp } from "../utils/request.js";
import { asArray, asRecord } from "./decode.js";
import type { AccountBody, AccountCreateInput, AccountUpdateInput, ChangeBody } from "./types.js";

const LIST_PATH = "/api/users";
const ONE_TEMPLATE = "/api/users/:username";

const LIST_WHAT = "GET /api/users 的 accounts";
const ONE_WHAT = "GET /api/users/:username 的 account";

/** 列出全部账号（解包后的 `accounts`） */
export async function listAccounts(http: ManagerHttp): Promise<readonly AccountBody[]> {
  const body = await http.request({ method: "GET", path: LIST_PATH });
  return asArray(body["accounts"], LIST_WHAT) as readonly AccountBody[];
}

/** 读单个账号（解包后的 `account`） */
export async function getAccount(http: ManagerHttp, username: string): Promise<AccountBody> {
  const path = endpointPath(ONE_TEMPLATE, username);
  const body = await http.request({ method: "GET", path });
  return asRecord(body["account"], ONE_WHAT) as unknown as AccountBody;
}

/**
 * 新建账号（成功 201；`validateStatus: () => true` 让 2xx 全算成功，故不必在此判状态码）
 * @description ⚠️ 回包**不解包**：写操作的响应体本身就是 `ChangeBody`。`changed: false` 是
 * 成功的 no-op 而非失败，不许翻成异常。
 */
export async function createAccount(
  http: ManagerHttp,
  input: AccountCreateInput,
): Promise<ChangeBody> {
  const body = await http.request({
    method: "POST",
    path: LIST_PATH,
    body: createBody(input),
  });
  return body as unknown as ChangeBody;
}

/**
 * 改单个账号（PATCH 语义但走 `PUT` —— 服务端按「出现的键就是要改的」处理）
 * @description ⚠️ **空 patch 会被服务端 400**：本层不替调用方兜一个空 `{}`，那会用一个
 * 远端 400 掩盖「调用方压根没说要改什么」。
 */
export async function updateAccount(
  http: ManagerHttp,
  username: string,
  patch: AccountUpdateInput,
): Promise<ChangeBody> {
  const path = endpointPath(ONE_TEMPLATE, username);
  const body = await http.request({
    method: "PUT",
    path,
    body: updateBody(patch),
  });
  return body as unknown as ChangeBody;
}

/** 删单个账号；⚠️ 不带 body（服务端不接受，而多余的空 body 会被读成 Content-Type 不一致） */
export async function deleteAccount(http: ManagerHttp, username: string): Promise<ChangeBody> {
  const path = endpointPath(ONE_TEMPLATE, username);
  const body = await http.request({ method: "DELETE", path });
  return body as unknown as ChangeBody;
}

/**
 * 挑出白名单里**当前有值**的键
 * @description ⚠️ 用 `undefined` 过滤而不是把 `undefined` 塞进 body：JSON 里不该出现
 * 「这个字段存在但没有值」这种东西，服务端分不清它是「不设置」还是「显式清空」
 * （显式清空有专属的 `"clear"` 字面量，见 `AccountUpdateInput`）。
 */
function createBody(input: AccountCreateInput): Record<string, unknown> {
  const picked: Record<string, unknown> = { username: input.username, password: input.password };
  pick(picked, "quotaBytes", input.quotaBytes);
  pick(picked, "quotaWindow", input.quotaWindow);
  pick(picked, "expiresAt", input.expiresAt);
  pick(picked, "disabled", input.disabled);
  pick(picked, "targetWhitelist", input.targetWhitelist);
  pick(picked, "targetBlacklist", input.targetBlacklist);
  return picked;
}

function updateBody(patch: AccountUpdateInput): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  pick(picked, "password", patch.password);
  pick(picked, "quotaBytes", patch.quotaBytes);
  pick(picked, "quotaWindow", patch.quotaWindow);
  pick(picked, "expiresAt", patch.expiresAt);
  pick(picked, "disabled", patch.disabled);
  pick(picked, "targetWhitelist", patch.targetWhitelist);
  pick(picked, "targetBlacklist", patch.targetBlacklist);
  return picked;
}

function pick(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
