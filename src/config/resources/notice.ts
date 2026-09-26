/**
 * 配置 JSON 热加载事件 → 日志呈现
 *
 * 这里是唯一的配置资源 notice 呈现路径：`users/` 与 `acl/` 只把已提交的 JSON
 * 事件桥到 `events.ts` 的总线，本模块统一渲染。资源总线本身不依赖 logger，
 * 因而订阅方（经 `subscribeConfigNotices` 显式创建，见下段）可以独立订阅而不会
 * 形成日志副作用。
 *
 * **订阅按实例显式创建**（`subscribeConfigNotices`），本模块**没有**「加载即
 * 订阅」的进程级副作用：总线是进程内单例，而 notice 的等级、落盘路径与日志前缀
 * 只属于某个实例的 `Logger`。库消费方从不调用 `setProcessScope()`，靠模块级
 * 订阅取 `getLogger("config")` 会在渲染时抛错并被总线吞掉——ACL/账号表热加载
 * 四态日志在多实例库场景下静默消失，且没有任何类型检查能发现。
 *
 * 归属判定用**函数**而不是数组：`AUTH_USERS_FILE` / `ACL_FILE` 是 runtime 字段，
 * reload 后会指向新文件，订阅者必须现取当前路径集合来判断这条事件归不归自己。
 */

import { sanitizeJsonFileErrorText } from "@/utils/file/json.js";
import type { Logger } from "@/utils/log/logger.js";
import {
  subscribeConfigResourceEvents,
  type ConfigResource,
  type ConfigResourceEvent,
  type ConfigResourceOutcome,
} from "./events.js";

/** 创建 notice 订阅所需的实例上下文 */
export interface ConfigNoticeOptions {
  /**
   * 本实例的 `Logger`（组合根的 `loggerProvider.logger`）。
   *
   * 必须注入实例日志器而不是 `getLogger()`：等级与落盘基址的真相源是该实例 scope，
   * 进程级门面在库消费方（从不 `setProcessScope()`）里根本不可用。child 共享父的
   * scope 与在途落盘集合，所以只有一行会落在本实例的日志文件里。
   */
  readonly logger: Logger;
  /**
   * notice 在实例日志器上派生的 child 前缀，缺省 `"config"`。
   * 行首 prefix 形如 `[edge-a]:config`，与既有 grep 形态一致。
   */
  readonly prefix?: string;
  /**
   * 现取本实例关心的资源路径（`authUsersFile` + `aclFile`）。
   *
   * **刻意是函数**：`aclFile`/`authUsersFile` 是 runtime 字段，热重载后指向新文件；
   * 事件到来那一刻现读 scope 才能正确归属，也避免在订阅时把路径快照下来。
   */
  readonly paths: () => readonly string[];
}

/** 去重窗口大小：只记住最近这么多条事件的指纹。 */
const NOTICE_FINGERPRINT_WINDOW = 64;

/**
 * 最近已落盘事件的指纹（进程内共享，与订阅者数量无关）。
 *
 * 存在的理由：`readJsonCached` 的缓存键是「资源 + 路径」，所以**两个实例读同一
 * 路径会共享同一条缓存条目、事件只发布一次**，但两个订阅者都会收到它——不去重
 * 就是两行一字不差的重复日志。用定长窗口（`NOTICE_FINGERPRINT_WINDOW`）而不是
 * 无界 Set：长跑进程里文件被反复改动，指纹无界增长就是内存泄漏。
 */
const loggedNoticeFingerprints: string[] = [];

/** 事件身份：资源 + 路径 + 迁移 + 生效值来源 + 版本 + 去敏错误文本。 */
function noticeFingerprint(evt: ConfigResourceEvent): string {
  // 数组 + JSON 而不是字符串拼接：分隔符在路径/错误文本里可能出现，拼出来的指纹
  // 会因歧义误判成同一事件从而吞掉本该落盘的一行。
  return JSON.stringify([
    evt.resource,
    evt.path,
    evt.transition,
    evt.outcome,
    evt.mtimeMs ?? null,
    evt.size ?? null,
    evt.error ?? null,
  ]);
}

/** 指纹是否已由某个订阅者落盘；没有则登记，返回 false。 */
function claimNoticeFingerprint(fingerprint: string): boolean {
  if (loggedNoticeFingerprints.includes(fingerprint)) {
    return true;
  }
  loggedNoticeFingerprints.push(fingerprint);
  if (loggedNoticeFingerprints.length > NOTICE_FINGERPRINT_WINDOW) {
    loggedNoticeFingerprints.shift();
  }
  return false;
}

/**
 * 生效值来源的中文后缀：`retained` = 沿用上一份（**仍在生效**），其余 = 回退空配置（**当前不生效**）。
 */
function outcomeSuffix(outcome: ConfigResourceOutcome): string {
  return outcome === "retained" ? "沿用上一份有效配置" : "回退空配置";
}

/**
 * 「该资源当前不生效」的可操作说明：说清安全语义变了什么、期望路径来自哪个配置键、怎么恢复。
 * @param resource - 资源身份（决定缺的是哪个文件、以及不生效意味着放行还是全拒）
 * @param filePath - 期望的文件路径（来自该实例配置作用域的 `ACL_FILE` / `AUTH_USERS_FILE`）
 */
function inactiveResourceClause(resource: ConfigResource, filePath: string): string {
  if (resource === "acl") {
    // ACL 语义是 fail-open：文件没了不拦任何请求，运维必须一眼看出「名单没在生效」
    return `访问控制当前未生效（所有请求全部放行）；恢复办法：按 ACL_FILE=${filePath} 重新创建该文件（模板 cfg/acl.json.example），恢复后 1s 内自动热加载，无需重启`;
  }
  return `账号表当前为空表（启用 basic/uid 鉴权时所有请求都会被拒绝）；恢复办法：按 AUTH_USERS_FILE=${filePath} 重新创建该文件（模板 cfg/users.json.example），恢复后 1s 内自动热加载，无需重启`;
}

/**
 * 把一个资源事件渲染为 notice 日志。
 *
 * 严重度只由**生效值来源**决定，不与「哪个资源」混在一起：
 * - `retained`（沿用上一份）：名单/账号表仍在生效，warn 足够；
 * - 回退空配置：该资源**当前不生效**，一律 error——ACL 侧等于访问控制静默全放行，
 *   账号表侧等于空表全拒，两种都是必须立刻处置的状态，必须带可操作说明。
 * 读取失败（`error` 迁移）与文件消失（`missing` 迁移）各走各的文案，不混成一条。
 *
 * 文案、级别与结构化字段是 `src/config/AGENTS.md` 写死的稳定 grep 契约，改这里
 * 等于破坏 `[config] ... 读取失败/文件消失/已恢复/已热加载` 四条既有查询。
 *
 * @param log - 本实例的呈现日志器（订阅时由实例根日志器派生）
 * @param evt - 已经去敏的资源状态事件
 */
function renderConfigResourceNotice(log: Logger, evt: ConfigResourceEvent): void {
  // pid 供控制台区分进程；落盘通道 pid 是保留键（logger 自动写真实进程号），同值覆盖无副作用
  const fields: Record<string, unknown> = { pid: process.pid };
  if (evt.mtimeMs !== undefined) {
    fields.mtimeMs = evt.mtimeMs;
  }
  if (evt.size !== undefined) {
    fields.size = evt.size;
  }

  const suffix = outcomeSuffix(evt.outcome);
  /** 当前生效值来自空配置 = 该资源不生效（ACL 全放行 / 账号表全拒） */
  const inactive = evt.outcome !== "retained";
  const level = inactive ? "error" : "warn";
  /** 不生效时才追加可操作说明；沿用上一份时重复说明只会稀释日志 */
  const clause = inactive ? `；${inactiveResourceClause(evt.resource, evt.path)}` : "";

  if (evt.transition === "error") {
    const error = evt.error === undefined ? "未知错误" : sanitizeJsonFileErrorText(evt.error);
    log.notice(level, `[config] ${evt.label} 读取失败: ${evt.path}: ${error}（${suffix}）${clause}`, fields);
  } else if (evt.transition === "missing") {
    log.notice(level, `[config] ${evt.label} 文件消失: ${evt.path}（${suffix}）${clause}`, fields);
  } else if (evt.transition === "recovered") {
    log.notice("info", `[config] ${evt.label} 已恢复: ${evt.path}`, fields);
  } else {
    log.notice("info", `[config] ${evt.label} 已热加载: ${evt.path}`, fields);
  }
}

/**
 * 为一个实例创建 notice 订阅（唯一 notice 呈现路径的安装点）。
 *
 * 组合根（`src/instance.ts`）在实例 scope 与 `Logger` 就绪后调用一次；同一进程
 * 起 N 个实例就有 N 个订阅者，各自只呈现自己路径的事件。用谁的日志器落盘由本
 * 订阅者自己决定，所以「先到的那次」胜出——同一条事件只会有一行，而那一行属于
 * 第一个落盘的实例。这是**刻意取舍**：多个实例指向同一文件时，运维需要的是
 * 「这件事发生过」而不是 N 份同样内容；想看每个实例各自的落盘文件，就让它们读
 * 各自的 `AUTH_USERS_FILE`/`ACL_FILE`（缓存键随之不同，事件也就不再共享）。
 *
 * @param options - 实例日志器、notice 前缀与现取的路径集合
 * @returns 幂等取消订阅函数（重复调用无副作用）
 */
export function subscribeConfigNotices(options: ConfigNoticeOptions): () => void {
  const log = options.logger.child(options.prefix ?? "config");
  return subscribeConfigResourceEvents((event) => {
    try {
      // 先判归属再判去重：反过来的话，不关心这条路径的订阅者会先占掉指纹，
      // 把本该落盘的那一行吞掉。
      if (!options.paths().includes(event.path)) {
        return;
      }
      const fingerprint = noticeFingerprint(event);
      if (claimNoticeFingerprint(fingerprint)) {
        return;
      }
      renderConfigResourceNotice(log, event);
    } catch {
      // notice 呈现故障与资源状态迁移无关：总线还会再兜一层，这里先自保，
      // 绝不把 `paths()`/渲染的异常反噬 `readJsonCached`（它在每连接 ACL 与
      // 每请求鉴权路径上，绝不抛是硬契约）。
    }
  });
}
