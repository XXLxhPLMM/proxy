/**
 * @fileoverview ops 层的**装配上下文**：配置 → 三份数据源
 * @module ops/sources
 * @description
 * 「按 env 文件决定操作哪个数据源」这件事只有本模块做，且它做的正是服务端那条唯一的翻译路径：
 * `accountLocatorFor` / `aclLocatorFor` 从 `ConfigAccessor` 折出接线，再经各数据源自己的注册表
 * 解析实现器。**没有第二份「哪个键装哪个驱动」的映射**——那样 CLI 与代理迟早对不上，
 * 而「CLI 改 A 档、代理读 B 档」是本仓最贵的一种配置事故。
 *
 * ## 为什么 `loadConfig` 传 `skipFileValidation: true`
 *
 * 启动期那轮强校验是为**服务能不能起来**服务的：坏账号表 / 坏名单必须让启动失败。管理工具的目标
 * 恰恰相反——它经常要操作一份**此刻是好的、或者正要被改坏**的数据。具体地说，`AUTH_ENABLED=true`
 * + `AUTH_TYPE=basic` + 空账号表在服务端是**启动中止**，而「加第一个账号」正是本工具最该干的事。
 * 照搬那轮校验会让工具在最需要它的时候拒绝服务。
 *
 * 代价是本模块**必须**在每个命令里自己做该做的校验，且判据全部取自数据源层
 * （`AccountSource.list` 的 `error` 字段、`AccountSource.put` 的抛错、`AclSource.write` 的
 * 抛错）——**绝不自己再判一遍形状**，那份判据的第二份真相源正是「写得进去、读不出来」的来源。
 *
 * @module
 */

import { aclSourceFor } from "@/datasource/acl/index.js";
import type { AclSource } from "@/datasource/acl/index.js";
import { accountSourceFor } from "@/datasource/users/index.js";
import type { AccountLocator, AccountSource } from "@/datasource/users/index.js";
import { quotaWindow, resolveUsageSource } from "@/datasource/quota/index.js";
import type { UsageSnapshot, UsageSource, UsageSourceError } from "@/datasource/quota/index.js";
import { loadUserQuota } from "@/datasource/users/index.js";
import {
  aclLocatorFor,
  accountLocatorFor,
  defaultEnvFileNames,
  loadConfig,
  type ConfigAccessor,
  type ConfigContext,
} from "@/config/index.js";
import { OpsError } from "./error.js";

/** 装配好的数据源三件套（每次运行造一次，命令之间共用） */
export interface OpsSources {
  readonly config: ConfigAccessor;
  readonly context: ConfigContext;
  readonly accounts: AccountSource;
  readonly accountsLocator: AccountLocator;
  readonly acl: AclSource;
  /**
   * 造一份账本数据源（**每次调用造新的**：它的 `open()` 会建存储、起周期循环，而本工具只在
   * 「读一次」的场景用它，跑完立刻 `close()`。记忆一份实例等于把一个可能开着的账本挂在 CLI 上）。
   * @param observer - 回读与落盘失败的观察面。**必须在造的时候挂上**：`UsageSourceSpec` 是工厂的
   *   入参，规格一被消费就再也插不进观察面了（数据源构造完成时它已经把回调烤进去了）。
   */
  readonly usage: (observer?: UsageObserver) => UsageSource;
}

/** 账本的观察面（回读出口 + 落盘失败旁路） */
export interface UsageObserver {
  /** 回读出口：`open()` 里被调用**一次**（= 启动期恢复），此后每轮周期一次 */
  readonly onSnapshot?: (snapshot: UsageSnapshot) => void;
  /** 落盘 / 压缩失败。本工具只读不写，理论上不发生；发生了必须看得见而不是被吞掉 */
  readonly onError?: (error: UsageSourceError) => void;
}

/**
 * 按 cwd 的 env 文件 + 宿主 env 解析配置，并折出三份数据源
 * @param env - 宿主环境快照（**必须在第一次 await 之前取**，理由同 `src/cli.ts`）
 * @param cwd - 配置目录锚点
 * @throws {Error} `loadConfig` 的配置校验失败（原样上抛，文案里已含键名）
 */
export async function resolveOpsSources(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Promise<OpsSources> {
  // ⚠️ **argv 传空数组**：本工具的参数不是配置键，混进那条通路会撞上未知键闸门（理由见
  // `@/admin/args.ts` 文件头）。要临时换一份数据源就用 `AUTH_USERS_DRIVER=sqlite proxy-cli ...`。
  const context = await loadConfig({
    env,
    // env 文件候选与服务端**逐字相同**（`defaultEnvFileNames` 是唯一一份，`src/cli.ts` 用的就是
    // 它）——同一台机器上「代理读哪份配置」与「CLI 改哪份配置」必须是同一个答案。
    envFiles: defaultEnvFileNames(env.NODE_ENV),
    argv: [],
    cwd,
    // 见文件头：启动期强校验是为「服务能不能起来」服务的，与本工具的目标相反。
    skipFileValidation: true,
  });
  const config = context.accessor;
  const accountsLocator = accountLocatorFor(config);

  return {
    config,
    context,
    accountsLocator,
    accounts: accountSourceFor(accountsLocator),
    acl: aclSourceFor(aclLocatorFor(config)),
    usage: (observer?: UsageObserver) => {
      // 账本规格与 `runtime/services.ts:buildDefaultServices` **逐字同形**：同一个窗口口径
      // （`quotaResetHour` + 账号表里的 `quota.window`），否则读出来的用量会算进与判定不同的
      // 窗口里，而「CLI 看到的数」正是运维用来判断「是不是超了」的那个数。
      return resolveUsageSource(config.get("quotaUsageDriver"))({
        dir: () => config.get("quotaUsageDir"),
        flushMs: () => config.get("quotaFlushInterval"),
        resetHour: () => config.get("quotaResetHour"),
        windowFor: (user: string) => quotaWindow(loadUserQuota(user, accountsLocator)?.window),
        onSnapshot: observer?.onSnapshot,
        onError: observer?.onError,
      });
    },
  };
}

/**
 * 读账号表整张，**坏内容即拒**（而不是回退成空表继续）
 * @description
 * 数据源层的读语义是「坏内容 → 保留上一份有效值 / 空表 + 一个 `error`」。**对代理来说那是对的**
 * （判据永不因手滑而失效），**对要写数据的工具来说是错的**：在「我读到的其实是空表」这个前提
 * 下执行 `put`，结果就是**把整份真配置清空**。故本模块把 `error` 升级成硬失败。
 *
 * @param source - 账号数据源
 * @throws {OpsError} `source-unreadable`：内容读不到 / 校验失败
 */
export function readAccountsOrFail(
  source: AccountSource,
): ReturnType<AccountSource["list"]>["value"] {
  const read = source.list({ force: true });
  if (read.error !== undefined) {
    throw new OpsError(
      "source-unreadable",
      `账号表读不到或内容非法：${read.path} —— ${read.error}`,
    );
  }
  return read.value;
}

/**
 * 读名单整份，**坏内容即拒**（理由与 {@link readAccountsOrFail} 逐字相同）
 * @throws {OpsError} `source-unreadable`：内容读不到 / 校验失败
 */
export function readAclOrFail(source: AclSource): ReturnType<AclSource["read"]>["value"] {
  const read = source.read({ force: true });
  if (read.error !== undefined) {
    throw new OpsError(
      "source-unreadable",
      `名单读不到或内容非法：${read.path} —— ${read.error}`,
    );
  }
  return read.value;
}

/**
 * 取这份名单驱动的写面（`AclSource.write` 是**可选成员**，见该成员的注释）
 * @throws {OpsError} `read-only-driver`：该驱动没有实现写面——**明确报错，绝不静默成功**
 */
export function requireAclWrite(
  source: AclSource,
): (next: ReturnType<AclSource["read"]>["value"]) => void {
  if (typeof source.write !== "function") {
    throw new OpsError(
      "read-only-driver",
      `名单驱动 ${source.driver} 是只读的，没有实现写面，故本工具改不了它` +
        "（内置 json 档可以；自定义驱动需自己在 AclSource 上实现 write）",
    );
  }
  return source.write.bind(source);
}