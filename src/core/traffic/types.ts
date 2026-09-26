/**
 * @fileoverview 每用户流量配额的**端口**（只读数据契约，零运行时逻辑）
 * @module core/traffic/types
 * @description
 * 「某个账号用掉了多少字节、还能不能用」这件事的最小契约。实现（内存账本）住
 * `./memory.ts`，落点（在哪两条流上数）住 `./meter.ts`，本文件只声明形状。
 *
 * 设计要点：
 * - **计量与判定合成一个动作**（`consume`）：端口刻意**不**提供「先查后加」的两段式 API。
 *   两段式在并发下必然出现「查的时候还没超、加完已经超了」的窗口，而本端口的调用点在
 *   事件循环里是**同步**的（见 `consume` 的同步性论证），一个动作即可原子完成
 *   「累加 + 判定」，不给「先放行、下次再说」留任何缝隙。
 * - **超限必须在本次就返回 `allow:false`**：软化语义（「用尽后只拒新请求、已有连接放着」）
 *   会让一条长连接隧道永远不触发耗尽判定，配额就成了摆设。裁决见 `src/core/AGENTS.md`。
 * - **方向语义不许反**：`up` = 客户端 → 上游（用户上传），`down` = 上游 → 客户端（用户下载）。
 * - 端口不读配置、不读文件、不打日志：配额从哪来由实现方在**装配点**注入
 *   （`QuotaResolver` 端口），core 内零缺省解析。
 */

import type { UserQuota } from "@/config/index.js";

export type { UserQuota };

/** 计量方向：`up` = 客户端→上游（上传），`down` = 上游→客户端（下载）。 */
export type TrafficDirection = "up" | "down";

/**
 * 被突破的那个上限（用于日志归因）
 * @description `up` / `down` 是单向上限，`total` 是 `bytesTotal` 总量上限。三者各自独立触发。
 */
export type TrafficScope = "up" | "down" | "total";

/** 一次累加的判定结果。 */
export interface TrafficVerdict {
  /** 本次字节是否放行。**超限时必须在本次即为 false**（不允许「先放行下次再说」）。 */
  readonly allow: boolean;
  /** 拒绝时给出，且 scope 指明是哪个上限被突破（用于日志归因）。 */
  readonly reason?: "quota";
  readonly scope?: TrafficScope;
  /** 拒绝时给出当前已用量与上限，供日志使用。 */
  readonly usage?: number;
  readonly limit?: number;
}

/** 某用户当前已用流量（字节）。 */
export interface TrafficUsage {
  readonly up: number;
  readonly down: number;
}

/**
 * 每用户流量配额端口
 * @description
 * 实现必须保证：
 * - `consume` 是**同步**函数（Node 单线程事件循环内不会被重入，故实现可以无锁）；
 * - 判定顺序为 `bytesUp` → `bytesDown` → `bytesTotal`，**任一突破即拒**；
 * - 未配配额 / 三个子字段全 0 / 用户不存在 → **恒 allow**（不限流）。
 */
export interface TrafficAccount {
  /** 累加并判定；**必须**在超限时返回 allow:false（不允许「先放行下次再说」）。 */
  consume(user: string, dir: TrafficDirection, bytes: number): TrafficVerdict;
  usage(user: string): TrafficUsage;
}

/**
 * 配额解析端口：按用户名取该用户**当前生效**的配额
 * @description
 * 刻意做成注入端口而不是让实现自己 `loadUserQuota`：读 `users.json` 需要 `ConfigAccessor`
 * 与文件事件观察面，两者都由**装配点**持有（`createProxyRuntime`）。core 侧因此零配置依赖，
 * 单测可以直接塞一个闭包当替身。
 * @param user - 已鉴权用户名
 * @returns 配额；用户不存在、未配 `quota`、或文件读不到有效内容时返回 undefined（= 不限流）
 */
export type QuotaResolver = (user: string) => UserQuota | undefined;

/**
 * 落盘注入口：账本只收「谁、哪个方向、多少字节、什么时候」这四个事实
 * @description
 * **刻意是最小的形状**：账本**不参与判定**、不返回 verdict、不认识窗口类型——它只把
 * 增量按 `(用户, 方向, 字节, 时刻)` 追加到自己的文件里。绝对值一律在**读取时求和**得到
 * （不写绝对值：写绝对值等于让「谁最后写」成为唯一真相，一次并发写就会互相覆盖）。
 *
 * **`record` 必须是同步的**（与 `consume` 同一条纪律）：它由 `MemoryTrafficAccount.consume`
 * 在**无 await 的同步区间内**调用，所以绝不允许有 Promise/IO。真正的落盘由账本自己的
 * 后台 flush 负责（见 `./ledger.ts` / `./flush-loop.ts`）。**`consume` 绝不因为账本失败而
 * 抛错或变慢**——磁盘满不该让代理拒服务。
 *
 * `ts` 显式传而不是让账本自己取时钟：窗口键是「时刻 → 窗口」的纯映射，账本必须在与判定
 * **同一个**时刻上算键（否则同一批字节会被分到两个窗口），而判定侧的时钟源是可注入的
 * （`TrafficWindowSource.now`），账本无从知道它。
 */
export interface TrafficSink {
  record(user: string, dir: TrafficDirection, bytes: number, ts: number): void;
}

/**
 * 从落盘账本恢复出来的用量（每个用户一份）
 * @description
 * `windowKey` 是这些字节**所属的窗口**（由条目 `ts` 经 `windowKey()` 算出）。账本层已经
 * 按「**只认当前窗口**」过滤过（见 `./ledger.ts:summarizeCurrent`），所以这个键对每个用户
 * 都等于**读取那一刻**的当前窗口键；恢复方把它原样写进槽位后，惰性滚动那条既有路径
 * （`MemoryTrafficAccount.slotFor` 的比对）就成了第二道保险。
 */
export interface RestoredUsage {
  readonly windowKey: string;
  readonly up: number;
  readonly down: number;
}

/** 恢复结果：用户名 → 该用户当前窗口的用量（**每个用户至多一条**）。 */
export type RestoredLedger = ReadonlyMap<string, RestoredUsage>;

/**
 * 落盘失败事实（写盘/压缩 IO 失败时上抛给装配点的旁路）
 * @description
 * **为什么需要它**：写盘失败绝不能让服务拒服务（内存计数照走），但也**绝不能静默吞掉**
 * ——静默 = 运维以为配额持久化了、重启后才发现用量全丢。「继续服务 + 一条可见事实」是
 * 唯一正确的失败形态。`path` 指向出问题的账本文件，`error` 是原始异常（消费方据此能判断
 * 是 `EACCES` 还是 `ENOSPC`）。
 */
export interface TrafficLedgerError {
  readonly path: string;
  readonly error: unknown;
}

/**
 * 落盘账本的**生命周期**端口（`runtime.start/stop` 驱动面）
 * @description
 * 与 {@link TrafficSink} **刻意分成两个端口**，因为它们是**两个调用方、两种失败代价**：
 * - `TrafficSink.record` 由 `consume` 在**同步区间内**调用（每 chunk 一次），抛错就等于
 *   把「写盘失败」变成「转发失败」。它因此必须是最小同步面。
 * - 这里的 `open`/`close` 只在 `runtime.start()`/`stop()` 各调一次，**允许 Promise**
 *   （恢复读文件与最后一次落盘本来就是 IO）。
 *
 * 合在一个接口上会让「实现方」被迫把两个面的语义混为一谈：尤其容易顺手让 `record`
 * 也返回 Promise，那正是 5b-1 明确禁止的方向。
 *
 * `enabled` 为 false = **零成本档**（没有任何用户配了非全 0 的 `quota`）：此时不建目录、
 * 不开句柄、不起定时器。`file` 仍是**构造期纯算出的路径**（不 stat 磁盘），供诊断与
 * 事件载荷使用。
 */
export interface TrafficLedgerController {
  /** 账本文件路径（构造期纯计算，不 stat 磁盘）。 */
  readonly file: string;
  /** 是否已启用。零成本档 / 未 `open()` / 已 `close()` 均为 false。 */
  readonly enabled: boolean;
  /** 未落盘的增量条数（写盘失败时它会累积 —— 那是「用量在涨、磁盘不认」的可见证据）。 */
  readonly queued: number;
  /** 幂等：恢复 + 启动期压缩 + 开句柄 + 起落盘定时器。 */
  open(): Promise<void>;
  /** 幂等：摘定时器 → **最后一次落盘** → 关句柄。 */
  close(): Promise<void>;
}
