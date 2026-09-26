/**
 * 流量配额的默认实现 - 进程内计量
 * @fileoverview plugins/usage-store
 * @description
 * `UsageProvider`（`plugins/contracts.ts`）的**默认实现**。计量状态是
 * 「用户名 → { 窗口起点, 已用字节 }」，窗口到期自然翻页（翻页即重置累计值）。
 *
 * 本实现**刻意不做**三件事，每一件都在下面写明了代价 —— 配额最怕的是「看起来在限制、
 * 实际限制不住」，所以边界必须写在代码里而不是只写在文档里：
 *
 * 1. **不持久化。** 用量活在进程内存，重启即归零 → 「每天 1GB」在重启后从头算，
 *    可以被反复重启刷掉。**唯一的补救是外部手段**（systemd 的 restart 计数、
 *    容器编排的存活探针）。
 * 2. **不跨进程。** `CLUSTER_WORKERS > 1` 时每个 worker 是独立进程、各有各的计数，
 *    所以「1GB」实际含义是「**每个 worker 各 1GB**」，不是全局共享的一个 1GB。
 *    把它误读成全局额度就是这个实现最大的坑。
 * 3. **不预扣、不掐流。** `reserve` 只看「当前窗口是否已用尽」，无法预估单请求大小，
 *    因此**不预留额度**；`settle` 发生在会话结束之后，所以**已建链的会话可以合法超额**
 *    （下一个 10GB 的下载在额度剩 1MB 时照常放行）。这是总量配额在物理上的上限，
 *    不是实现偷懒：要真正限量就得**超阈值 destroy 传输**，那会把进行中的下载拦腰砍断。
 *
 * 替换存储（文件 / Redis）时**新增一种 `UsageProvider` 实现**而不是给本契约加字段——
 * `CACHE_TYPE=redis` 目前是死配置（`src/` 内零实现），真要做跨进程/跨重启配额
 * 应当在这里换实现，而不是让名单判定去管累计状态。
 */
import type { QuotaPeriod, QuotaReservation, UsageProvider, UsageSnapshot } from "./contracts.js";
import { userQuota } from "@/config/resources/users/policy.js";
import type { UserQuota } from "@/config/resources/users/schema.js";
import type { AuthAccount } from "@/core/types/proxy.js";

/** 配额来源：账号表快照（每次现取，跟随 `users.json` 的 1s 节流热加载） */
export type QuotaSource = () => readonly AuthAccount[];

/** 单个账号的计量状态 */
interface Meter {
  /** 窗口起点（epoch 毫秒）；`total` 为进程启动时刻，恒不翻页 */
  windowStart: number;
  /** 当前窗口内已用字节数 */
  used: number;
  /** 建立本桶时的配额定义（`bytes` + `period`），用于「定义变了就丢弃旧账」 */
  limit: number;
  period: QuotaPeriod;
}

/** 各计量窗口的长度（毫秒）；`total` 不翻页故不参与 */
const PERIOD_MS: Record<Exclude<QuotaPeriod, "total">, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  // 「月」按固定 30 天近似：配额是近似闸门，不值得为「自然月」引入时区与月末日历计算
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** 创建进程内计量实现
 * @param accounts - 账号表快照来源（调用方每次现取，跟随 `users.json` 的 1s 节流热加载）
 * @param now - 当前时间（epoch 毫秒）；缺省 `Date.now`，单测可注入固定时钟
 */
export function createMemoryUsageProvider(
  accounts: QuotaSource,
  now: () => number = Date.now,
): UsageProvider {
  // 键**只按用户名**（`Map` 的字符串键不会像对象键那样每次调用都换身份 —— 先前把
  // `{ user, ...quota }` 当键是个真 bug：`Map` 按 identity 查，对象字面量每次都是新引用，
  // 于是 `reserve` 与 `settle` 永远命中不同桶，账本恒为 0）。
  // 「定义变了就丢弃旧账」改由桶内比对承担（见 `meterOf`），不靠拼键。
  const meters = new Map<string, Meter>();

  /**
   * 取（并在窗口过期或配额定义已变时重置）某账号的计量状态
   * @param user - 账号名
   * @param quota - 该账号当前的配额定义（来自账号表快照）
   * @param at - 当前时间
   */
  function meterOf(user: string, quota: UserQuota, at: number): Meter {
    const hit = meters.get(user);
    const span = quota.period === "total" ? Number.POSITIVE_INFINITY : PERIOD_MS[quota.period];
    // 复用条件：定义未变（上限与窗口都一致）**且**仍在当前窗口内。
    // 定义变了必须丢弃旧累计值 —— 否则「把 daily 1GB 改成 total 2GB」看起来像已经
    // 用掉了一整个月；窗口过期（`total` 的 span 是 Infinity，故恒不翻页）则自然翻页。
    if (hit !== undefined && hit.limit === quota.bytes && hit.period === quota.period) {
      if (at - hit.windowStart < span) {
        return hit;
      }
    }
    const fresh: Meter = { windowStart: at, used: 0, limit: quota.bytes, period: quota.period };
    meters.set(user, fresh);
    return fresh;
  }

  return {
    reserve(user: string | undefined): QuotaReservation {
      const quota = userQuota(accounts(), user);

      if (!user || !quota) {
        // 无身份或无配额 = 不限：策略缺失 ≠ 拒绝（与名单同一条原则）
        return { allowed: true };
      }

      const used = meterOf(user, quota, now()).used;
      return { allowed: used < quota.bytes, limit: quota.bytes, used };
    },

    settle(user: string | undefined, bytes: number): void {
      const quota = userQuota(accounts(), user);

      if (!user || !quota || bytes <= 0) {
        return;
      }

      meterOf(user, quota, now()).used += bytes;
    },

    snapshot(user: string): UsageSnapshot | undefined {
      const quota = userQuota(accounts(), user);

      if (!quota) {
        return undefined;
      }

      const meter = meterOf(user, quota, now());
      return {
        used: meter.used,
        limit: quota.bytes,
        period: quota.period,
        windowStart: meter.windowStart,
      };
    },
  };
}
