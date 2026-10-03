/**
 * @fileoverview 台账的**数据契约**：一个 target = 一个控制面端点 = 一个地址 + 一份凭据
 * @module ledger/types
 * @description
 * 本目录管的是「本机一份小文件」，它记的是「本工具要连哪几个控制面、各自用什么凭据」。有了它，
 * 启动就能恢复上次选中的那个端点 —— 用户不必每次重新敲地址与 token，而「重新敲一遍凭据」恰恰是
 * 最容易把一份**错**的 token 落到别处去的操作（「有状态、下次打开能重连」这条需求的全部动机）。
 *
 * ## 凭据**就在** `Target` 里，而不是收在某个 `secrets` 字段下
 * @description
 * 这不是偷懒，是「台账」这个东西的本质：一份凭据不存下来，下次打开就得让人重敲一遍，而重敲
 * 必然带来第二份副本（本机 shell 历史、密码管理器、截图）。所以真正的选择是「存一份、位置约定
 * 清楚、权限收紧」还是「让人每次重敲」。故 {@link ./store.ts} 里那句「明文落盘」不是妥协，是这条
 * 判断的结论。
 *
 * ## 为什么 `timeoutMs` 住在 target 上而不做成全局设置
 * @description
 * 跨机房时，一个 200ms 就够的 manager 与一个需要 20s 的 manager 共存在同一份台账里是常态。做成
 * 全局值等于让「改快的那个」与「改慢的那个」互相覆盖，而用户对这个覆盖毫无感知 —— 他只看到
 * 「有一个界面偶尔转圈」。
 *
 * ## 本文件**不含**任何判据
 * @description
 * 形状判据全在 {@link ./validate.ts}，数值边界在这里以常量形式给出（判据与边界同源，各写一份
 * 就是「UI 说合法、落盘判非法」的起点）。本文件只有契约，故它可以被任何一层安全地 import。
 */

import type { ManagerEndpoint } from "@/api/index.js";

/**
 * 台账里的一个控制面端点
 * @description
 * ⚠️ **`token` 等价于主机上的 root shell**（服务端控制面能读全量配置、增删账号与名单，凭据即全部
 * 权限，见 `src/manager/http/auth.ts` 文件头）。故本类型的任何字段都**不许**进日志、不许进错误
 * 文案、不许进快照；给界面看的那份形态由 {@link ./store.ts:redactTarget} 出，它把 `token` 换成
 * 固定占位符。
 *
 * `id` 是**稳定身份**、`name` 是**可变显示名**：改名字不该让「上次选中」丢掉（丢了就是下次打开
 * 连到一个不同的端点）。反过来改地址与 token 也不改 id —— id 是台账内的引用键，`selected` 指着它。
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
 * @description
 * `version` 是**数字字面量 1** 而不是 `number`：本仓零兼容，没有第二个版本、也没有迁移层
 * （`AGENTS.md`「项目阶段」那条），所以「版本不是 1」不是「旧版本，走迁移」，而是**这份文件不是
 * 本包写的**，照实拒掉。写成字面量类型后，这个判断由 `pnpm typecheck` 免费提供。
 *
 * `selected: null` 与 `targets: []` 是两种不同的空：前者是「有若干端点、但一个都没选中」，后者是
 * 「一个都没有」。故它是 `string | null` 而不是缺省。
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
 * @description
 * 下界挡「一个必然先超时的值」（对面还没来得及握手就被本端放弃，于是每次都显示「超时」，而真相是
 * 这个值本身就小于一次 TCP 往返）；上界挡「配了个 30 分钟、于是界面看起来卡死了」的值 —— 在一个
 * 交互式终端里，一个没有上界的超时等于没有超时。
 */
export interface TimeoutBounds {
  readonly min: number;
  readonly max: number;
}

export const TIMEOUT_BOUNDS: TimeoutBounds = { min: 200, max: 60000 };

/** 显示名长度上限（trim 之后判） */
export const NAME_MAX_LEN = 64;

/** 用户在界面上填的一个端点（还没有 `id`） */
export interface TargetInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
}

/**
 * {@link ./edit.ts:upsertTarget} 的入参
 * @description 给 `id` = 改那条；不给 = 新建（`id` 由 {@link ./edit.ts:idFor} 分配，且它会成为
 * 新的 `selected`）。⚠️ 给了 `id` 而台账里没有它，是**硬失败**而不是「新建」：静默新建会让
 * 「我改的是 A」变成「我多了一个 B」。
 */
export type UpsertInput = TargetInput & { readonly id?: string };
