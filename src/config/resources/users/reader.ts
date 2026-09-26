/**
 * users.json 读盘 - 节流热加载的唯一入口
 *
 * 职责：把「调用方传入的路径」变成「该实例当前生效的账号表」，并把读取层的
 * 状态迁移桥到资源事件总线。结构校验在 `schema.ts`，日志呈现由
 * `resources/notice.ts` 统一订阅，本文件不得直接写日志。
 *
 * 语义：
 * - **路径必填**：由调用方从自己的配置作用域取出，本读取器不回读任何进程级
 *   单例，因此同进程多个实例各自指向自己的账号表而互不串味
 * - 文件缺失 = 空账号表（是否放行由 `schema/guards.assertAuthConfig` 决定）
 * - 内容非法 = 保留上一份有效值
 * - 返回值视为只读，调用方不得原地修改（缓存共享同一实例）
 */
import { readJsonCached, type JsonFileRead } from "@/utils/file/json.js";
import type { AuthAccount } from "@/core/types/proxy.js";
import { createJsonFileEventBridge } from "../events.js";
import { validateAuthUsers } from "./schema.js";

/** 空账号表（只读哨兵，文件缺失时使用） */
const EMPTY_ACCOUNTS: AuthAccount[] = [];

/** 账号资源事件桥；与 acl 即使指向同一路径也拥有独立缓存身份。 */
const emitAuthUsersEvent = createJsonFileEventBridge("authUsers");

/**
 * 读取账号文件（带节流缓存）
 * @param opts.path - 账号文件路径；由调用方从自己的配置作用域取出（必填）
 * @param opts.force - 跳过节流强制重读（启动期校验用）
 * @returns 读取结果：value 为生效账号表，error 为最近一次失败原因
 */
export function readAuthUsers(opts: {
  path: string;
  force?: boolean;
}): JsonFileRead<AuthAccount[]> {
  return readJsonCached(opts.path, validateAuthUsers, {
    label: "用户账号文件",
    fallback: EMPTY_ACCOUNTS,
    resource: "authUsers",
    force: opts.force,
    onEvent: emitAuthUsersEvent,
  });
}

/**
 * 取当前生效账号表（供鉴权与凭据剥离使用）
 * @param path - 账号文件路径；由调用方从自己的配置作用域取出
 * @returns 账号数组（只读）；文件缺失或非法时为空数组/上一份有效值
 */
export function loadAuthUsers(path: string): AuthAccount[] {
  return readAuthUsers({ path }).value;
}
