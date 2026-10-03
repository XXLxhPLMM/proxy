/**
 * @fileoverview 台账的**数据契约**：一个 target = 一个控制面端点 = 一个地址 + 一份凭据
 * @module ledger/types
 * @description
 * 本目录管的是「本机一份小文件」，记的是「本工具要连哪几个控制面、各自用什么凭据」。有了它，启动就能恢复
 * 上次选中的那个端点（用户需求原话：「有状态，下次打开能够重连」）。
 *
 * ⚠️ `timeoutMs` 住在 target 上而不做成全局设置：跨机房时一个 200ms 就够的 manager 与一个需要 20s 的共存
 * 是常态，做成全局值等于让两者互相覆盖而用户毫无感知。本文件**不含**任何判据（形状判据全在
 * {@link ./validate.ts}，数值边界在这里以常量形式给出 —— 判据与边界同源，各写一份就是「UI 说合法、落盘判
 * 非法」的起点）。
 *
 * @module
 */

import type { ManagerEndpoint } from "@/utils/index.js";

/**
 * 台账里的一个控制面端点
 * @description ⚠️ **`token` 等价于主机上的 root shell**（服务端控制面能读全量配置、增删账号与名单），故本
 * 类型的任何字段都**不许**进日志 / 错误文案 / 快照。给界面看的那份形态由 {@link ./store.ts:redactTarget}
 * 出，它把 `token` 换成固定占位符。
 */
export interface Target extends ManagerEndpoint {
  /** 台账内唯一，人读 slug（`[a-z0-9-]`）——它是 `selected` 指的那种引用，故不许含路径分隔符 */
  readonly id: string;
  /** 人给的显示名（非空、trim 后不超过 {@link NAME_MAX_LEN}、不含控制字符） */
  readonly name: string;
  /** ⚠️ 归一后的基址（`http(s)://host:port`，无尾斜杠）；恒等于 `normalizeBaseUrl` 的产物 */
  readonly baseUrl: string;
}

/**
 * 一份台账
 * @description `version` 是**数字字面量 1**：本仓零兼容，没有第二个版本也没有迁移层，故「版本不是 1」不是
 * 「旧版本，走迁移」，而是**这份文件不是本包写的**，照实拒掉 —— 写成字面量类型后这个判断由 `pnpm typecheck`
 * 免费提供。`selected: null` 与 `targets: []` 是两种不同的空（前者是「有若干端点、但一个都没选中」）。
 */
export interface Ledger {
  readonly version: 1;
  /** 上次选中的 target `id`；`null` = 一个都没选 */
  readonly selected: string | null;
  readonly targets: readonly Target[];
}

/** 新建 target 时的默认单次请求超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 超时的允许区间
 * @description 下界挡「一个必然先超时的值」（对面还没来得及握手就被放弃，于是每次都显示「超时」，而真相是
 * 这个值本身就小于一次 TCP 往返）；上界挡「配了个 30 分钟、于是界面看起来卡死了」的值。
 */
export interface TimeoutBounds {
  readonly min: number;
  readonly max: number;
}

export const TIMEOUT_BOUNDS: TimeoutBounds = { min: 200, max: 60000 };

export const NAME_MAX_LEN = 64;

/** 用户在界面上填的一个端点（还没有 `id`） */
export interface TargetInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
}

/** {@link ./edit.ts:upsertTarget} 的入参：给 `id` = 改那条，不给 = 新建 */
export type UpsertInput = TargetInput & { readonly id?: string };