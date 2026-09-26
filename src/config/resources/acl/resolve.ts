/**
 * 多来源名单的判定编排 - 「两道独立闸门，按固定顺序各判一次」
 *
 * 本模块是 ACL 子系统对**上层**的唯一运行时入口（`instance.ts` 装配的
 * `AccessControlProvider` 只调这三个函数）。它回答的不是「名单怎么说」
 * （那是 `eval.ts`），也不是「快照从哪来」（那是 `reader.ts` / `users/policy.ts`），
 * 而是「**两个来源谁先判、命中后怎么收**」。
 *
 * ## 为什么是「两道」而不是「一份」
 *
 * 全局名单（`ACL_FILE`）与账号自己的名单（`users.json` 内联 `acl`）是两个**独立控制点**，
 * 不是一张表的两半。因此这里**刻意不做名单条目的 union / intersection，也不把两次判定
 * 归约成一个结果**——那会丢掉「是哪一道拦下的」这个唯一有运维价值的事实。规则只有三条：
 *
 * 1. **固定顺序**：实例级先判、账号级后判。实例级是信封（见第 2 条），先报它更少误导。
 * 2. **任一命中即拒**：账号名单**只能在全局之上收窄，永远不能豁免全局的拒绝**。
 *    反例（这就是「override 语义」为什么被否掉）：全局 `target.blacklist=[ads.example.net]`，
 *    某账号写 `"acl":{"target":{}}` → 「空名单 = 不限制」→ 该账号畅通无阻，
 *    **一个账号条目废掉了公司级策略**。
 * 3. **缺省 = 不额外限制**：账号没有该组、或压根不在账号表里（jwt 的未知 `sub`）、
 *    或实例没开鉴权 → 该维度只跑实例级那一道。**策略缺失 ≠ 拒绝**。
 *
 * `upstream` 组动作相反（命中=直连而非拒绝），但「两道串联」的形状不变：
 * 走上游要求**两道都同意**，任一道要求直连即直连（fail-safe 方向与拒绝语义一致）。
 * 两道都要求直连时按第 1 条报实例级（外层原因优先）。
 *
 * @example
 * ```ts
 * // alice 自己的名单把 target 限死在 *.example.com，请求 example.org
 * resolveTargetHost(globalAcl, aliceAcl, "example.org");
 * // => { allowed: false, reason: "whitelist", scope: "user" }
 * ```
 */
import {
  evaluateClientIp,
  evaluateTargetHost,
  evaluateUpstreamRoute,
  type AclDecision,
  type UpstreamRouteDecision,
} from "./eval.js";
import type { AclConfig } from "./schema.js";

/**
 * 给判定结果盖上来源章（放行结果不动——「没被任何名单拦住」不是一种来源）
 * @param decision - 单份名单的判定结果
 * @param scope - 本次判定对应的来源
 */
function attributed<T extends { allowed?: boolean; direct?: boolean; reason?: string }>(
  decision: T,
  scope: AclDecision["scope"],
): T {
  return decision.reason === undefined ? decision : { ...decision, scope };
}

/**
 * 判定客户端来源是否放行（实例级 → 账号级，任一拒绝即拒）
 * @param instance - 实例级名单快照（`ACL_FILE`）
 * @param user - 该账号自己的名单；`undefined` 表示无（不额外限制）
 * @param addr - 客户端对端地址（TCP 对端，调用方从 socket 取）
 * @returns 判定结果；`scope` 如实报出是哪一道拦下的
 */
export function resolveClientIp(
  instance: AclConfig,
  user: AclConfig | undefined,
  addr: string,
): AclDecision {
  const first = evaluateClientIp(instance, addr);

  if (!first.allowed) {
    return attributed(first, "instance");
  }

  if (user === undefined) {
    return first;
  }

  const second = evaluateClientIp(user, addr);

  return second.allowed ? first : attributed(second, "user");
}

/**
 * 判定目标主机是否放行（实例级 → 账号级，任一拒绝即拒）
 * @param instance - 实例级名单快照（`ACL_FILE`）
 * @param user - 该账号自己的名单；`undefined` 表示无（不额外限制）
 * @param host - 客户端请求的目标主机（端口不参与）
 * @returns 判定结果；`scope` 如实报出是哪一道拦下的
 */
export function resolveTargetHost(
  instance: AclConfig,
  user: AclConfig | undefined,
  host: string,
): AclDecision {
  const first = evaluateTargetHost(instance, host);

  if (!first.allowed) {
    return attributed(first, "instance");
  }

  if (user === undefined) {
    return first;
  }

  const second = evaluateTargetHost(user, host);

  return second.allowed ? first : attributed(second, "user");
}

/**
 * 判定 client 模式下目标主机应直连还是交上游（两道串联，任一道要求直连即直连）
 * @description 走上游 ⇔ 实例级同意走上游 ∧ 账号级同意走上游。`scope` 报出要求直连的那一道
 *   （两道都要求直连时按顺序报实例级）。
 * @param instance - 实例级名单快照（`ACL_FILE`）
 * @param user - 该账号自己的名单；`undefined` 表示无（不额外限制）
 * @param host - 客户端请求的目标主机（端口不参与）
 * @returns 是否直连；因名单命中直连时带 `reason` 与 `scope`
 */
export function resolveUpstreamRoute(
  instance: AclConfig,
  user: AclConfig | undefined,
  host: string,
): UpstreamRouteDecision {
  const first = evaluateUpstreamRoute(instance, host);

  if (first.direct) {
    return attributed(first, "instance");
  }

  if (user === undefined) {
    return first;
  }

  const second = evaluateUpstreamRoute(user, host);

  return second.direct ? attributed(second, "user") : first;
}
