/**
 * acl.json 读盘 - 节流热加载的唯一入口
 *
 * 职责：把「store 里的路径」变成「当前生效的 ACL 配置」，并把读取层的状态迁移
 * 桥到资源事件总线。结构校验在 `schema.ts`，判定在 `eval.ts`，日志呈现由
 * `resources/notice.ts` 统一订阅，本文件不得直接写日志。
 *
 * 语义：文件缺失 = 全部放行（fail-open，绝不改成 fail-closed）；内容非法 = 保留
 * 上一份有效值。
 */
import { get } from "../../store.js";
import { readJsonCached, type JsonFileRead } from "@/utils/file/json.js";
import { createJsonFileEventBridge } from "../events.js";
import { EMPTY_LIST, validateAcl, type AclConfig } from "./schema.js";

/** 空配置（只读哨兵，文件缺失时使用；三组共享同一个空名单实例） */
const EMPTY_ACL: AclConfig = {
  clientIp: EMPTY_LIST,
  target: EMPTY_LIST,
  upstream: EMPTY_LIST,
};

/** ACL 资源事件桥；与 authUsers 即使指向同一路径也拥有独立缓存身份。 */
const emitAclEvent = createJsonFileEventBridge("acl");

/**
 * 读取 acl 文件（带节流缓存）
 * @param opts.force - 跳过节流强制重读（启动期校验用）
 * @param opts.path - 显式路径覆盖（initConfig 写 store 之前用解析值校验时必须传）
 * @returns 读取结果：value 为生效配置，error 为最近一次失败原因
 */
export function readAcl(opts?: { force?: boolean; path?: string }): JsonFileRead<AclConfig> {
  return readJsonCached(opts?.path ?? get("aclFile"), validateAcl, {
    label: "访问控制名单文件",
    fallback: EMPTY_ACL,
    resource: "acl",
    force: opts?.force,
    onEvent: emitAclEvent,
  });
}

/**
 * 取当前生效 ACL 配置
 * @returns ACL 配置（只读）；文件缺失或非法时为空配置/上一份有效值
 */
export function loadAcl(): AclConfig {
  return readAcl().value;
}
