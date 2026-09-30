/**
 * @fileoverview 每用户用量配额的**端口**（只读数据契约，零运行时逻辑）
 * @module datasource/quota/types
 * @description
 * 「某个账号用掉了多少字节、还能不能用」这件事的最小契约。**权威总量住在数据源这一侧**
 * （`./sqlite-source.ts` / `./jsonl-source.ts` 落的那份共享存储），本目录的 `./mirror.ts` 是它
 * 的一份**进程内镜像**，代理（core / runtime / server）只是这份契约的消费者之一。
 *
 * ## 命名裁决：端口叫 `UsageSource`，而配置项还叫 `quotaLedgerDriver`
 *
 * 判据是**这个词在注册表这一层指的是什么**。`registerUsageSource` 注册的是「驱动名 → 一份
 * `UsageSource` 的工厂」，而 `QUOTA_LEDGER_DRIVER` 这个配置值（`src/config/schema/fields.ts`）
 * 正是喂给它的那个驱动名；两端必须叫同一个东西，否则「配了 ledger、查 usage 表」这种翻译
 * 误差会在**每一次**读装配代码时重新发生一次。
 *
 * ⚠️ **代价要写明**：配置脊柱那一侧仍然是「账本 / ledger」的词汇（`quotaLedgerDir` /
 * `quotaLedgerDriver` / `BUILTIN_LEDGER_DRIVERS` / `LEDGER_DB_NAME`），那是部署面上「这些字节
 * 记在哪」的既有说法，本层不改它。故本文件里**只有这一处**做词汇翻译（`resolveUsageSource`
 * 吃的就是 `quotaLedgerDriver` 的值），其余一律 `Usage*`。
 *
 * ## 为什么 `TrafficVerdict` 住在这里（它看起来像代理侧的东西）
 *
 * 判定形状 `{allow, reason, usage, limit}` 确实只有代理侧在消费（硬切 / 回 507 / 发事件），
 * 按最省事的做法它该留在 core。**但它挡不住本层的自洽**：判定的执行者是 `mirror.ts` 的
 * `consume`（`UsageAccount` 端口的实现），而 `consume` 返回什么由本层决定。把它留在 core 就
 * 要么让本层 import core（越界），要么让 `consume` 返回 `void`、判定拆成「先问后答」的两段式
 * ——而两段式在并发下必然出现「问的时候还没超、答的时候已经超了」的窗口，那个窗口恰好是
 * **配额判定最不能有的缝隙**。故判定形状定义在本层，core 侧逐字 re-export（同一份类型，
 * 不是第二份定义）。
 *
 * ## 两层：权威在数据源，进程内那份是镜像
 *
 * | | 住在哪 | 谁写 | 权威性 |
 * |---|---|---|---|
 * | 权威 | 共享存储（`usage.jsonl` / `quota.db`），**所有进程同一份** | 落盘那一侧 | 真相 |
 * | 镜像 | 进程内 `Map<user, {windowKey, total}>` | 每 chunk 累加 | 一个**可衰减的缓存** |
 *
 * 镜像之所以能当缓存而不当真相，只靠一条：**它被周期性回读**（`./flush-loop.ts` 那一条定时器
 * 同时驱动「落盘」与「回读」）。回读周期 `P` 就是**判定滞后的误差上界**的量纲，完整推导
 * （为什么是 `2P` 而不是 `P`）写在 `./mirror.ts:mirrorLagBoundMs`。
 *
 * ### ⚠️ 多进程判定的诚实记录（**本仓最重要的一条正确性事实**）
 *
 * - **落盘那一份是全局唯一真相**：所有进程写同一个文件、没有「槽位」（分槽让判定从
 *   「账号级封禁」退化成「每进程一份封禁」，那是一个真实的配额逃逸，故整条槽位链不存在）。
 * - **判定仍然是每进程一份的**：热路径读的是本进程的镜像，镜像只按 `P` 回读一次。于是
 *   `CLUSTER_WORKERS=N` 时合计放行可达 `N × quota.bytes` **加上**一段 `2P` 的滞后量。
 * - **换后端换不掉这条**：两个内置驱动都是「共享存储 + 进程内镜像」同一种形态，`json` 档还
 *   多一层文本文件没有写锁的缺口（压缩的 `rename` 覆盖窗口）。**判据永远是镜像的滞后，
 *   不是存储的能力。**
 * - 把 `consume` 改成「每 chunk 直接查共享存储」在**这个位置上不成立**：`consume` 是每 chunk
 *   调用的同步函数，而共享存储的读即使是 `DatabaseSync`（内置 `node:sqlite`）也要几十微秒
 *   （实测每 chunk 一次 `UPDATE…RETURNING` 是 61 µs，占事件循环 47.6%；1M 账号的共享缓存
 *   也有 20.6 µs/chunk）。**唯一能把滞后压到 0 的形态是「不在每个 chunk 上判定」**，而那
 *   需要「先放行、超了再切」——软化语义会让一条长连接隧道永远不触发耗尽判定，配额就成了摆设。
 */

import type { QuotaWindow } from "@/datasource/quota-window.js";

/**
 * 计量方向：`up` = 客户端→上游（上传），`down` = 上游→客户端（下载）。
 * @description 保留这个名字（而不是 `UsageDirection`）是因为它是**代理侧**的事实：字节在
 *   代理的数据面上往哪边流。账本只把它当**排障事实**存下来（判定只有一个合计上限，不看
 *   方向），而事件载荷、硬切收尾都按它说话——「判定放行直到撞顶」这条纪律要求「本次是哪个
 *   方向撞的」由挂点如实上报，方向不可由判定方反推。
 */
export type TrafficDirection = "up" | "down";

/**
 * 一次累加的判定结果
 * @description
 * - `allow: false` 必须在**本次**就返回：软化语义（「用尽后只拒新请求、已有连接放着」）会让
 *   一条长连接隧道永远不触发耗尽判定，配额就成了摆设。
 * - **只有一个上限**（`UsageQuota.bytes`，上传 + 下载算在一起），故**没有 `scope` 字段**：
 *   「是哪个上限被突破」这个问题不存在。消费方拿 `usage` / `limit` 直接算出「超了多少」。
 * - **恰好等于上限放行**（判据是累计 **>** 上限才拒）：配额是**上限**而不是「额度 + 1 的坑」。
 */
export interface TrafficVerdict {
  /** 本次字节是否放行。**超限时必须在本次即为 false**（不允许「先放行下次再说」）。 */
  readonly allow: boolean;
  /** 拒绝时给出。**只有一个上限，故无「哪个上限」可归因**。 */
  readonly reason?: "quota";
  /** 拒绝时给出当前已用量与上限，供日志使用。 */
  readonly usage?: number;
  readonly limit?: number;
}

/**
 * 某用户当前生效的配额上限（**本层自己的结构化声明**）
 * @description
 * 刻意**不** import `@/config` 的 `UserQuota`：数据源层零配置依赖是一条硬纪律（见文件头），
 * 而这条类型是本层判定唯一需要的形状。`UserQuota`（`{ readonly bytes; readonly window? }`）
 * **结构上可赋值给本类型**，所以装配层那个读 `users.json` 的闭包原样就能塞进来，不需要适配层。
 * 反向不成立（结构化声明不保证将来 `UserQuota` 不加字段），故本层任何地方都不得把它当
 * 「账号表读面」用。
 */
export interface UsageQuota {
  /** 双向合计累计上限（上传 + 下载算在一起）。**`0` = 不限流**（与未配同一语义）。 */
  readonly bytes: number;
  /** 配额窗口（日历窗）。**缺省即 `month`**，故本键在未配置时不出现——归一在消费侧
   *  （`quotaWindow()`，理由见 `@/datasource/quota-window.ts`）。 */
  readonly window?: QuotaWindow;
}

/**
 * 配额解析端口：按用户名取该用户**当前生效**的配额
 * @description
 * 做成注入端口而不是让实现自己 `loadUserQuota`：读账号表需要 `ConfigAccessor` 与文件事件
 * 观察面，两者都由**装配点**持有（`createProxyRuntime`）。本层因此零配置依赖，单测可以直接
 * 塞一个闭包当替身。**每次判定现调**（`users.json` 那条 1s 节流缓存把文件读取摊薄到每文件
 * 最多 1s 一次 stat），故热改账号表下次请求生效。
 * @param user - 已鉴权用户名
 * @returns 配额；用户不存在 / 未配 `quota` / 文件读不到有效内容时返回 `undefined`（= 不限流）
 */
export type QuotaResolver = (user: string) => UsageQuota | undefined;

/**
 * 每请求流量配额端口（**镜像实现它**）
 * @description
 * 实现必须保证：
 * - `consume` 是**同步**函数（无 await、无定时器，故实现可以无锁——论证见 `./mirror.ts` 文件头）；
 * - 判定是**单一合计上限**：累计 **>** 上限才拒，**恰好等于放行**；
 * - 未配配额 / `bytes` 为 0 / 用户不存在 → **恒 allow**（不限流），且**仍照常计量**
 *   （「没有上限」≠「不计量」，否则将来给账号加上限时给的是一份从 0 开始的假账）。
 */
export interface UsageAccount {
  /** 累加并判定；**必须**在超限时返回 allow:false（不允许「先放行下次再说」）。 */
  consume(user: string, dir: TrafficDirection, bytes: number): TrafficVerdict;
  /**
   * 当前窗口的已用字节（**双向合计**）；用户不存在 / 从未计量过 → `0`。
   * @description 刻意不提供 `remaining()`：那是纯减法，而「不限流」时它该返回什么没有好
   *   答案。分方向的 `up` / `down` 也刻意不返回——判定与账本都不需要它，账本条目自己留着
   *   方向（那是落盘事实，排障时能直接看文件）。
   */
  usage(user: string): number;
}

/**
 * 落盘注入口：数据源只收「谁、哪个方向、多少字节、什么时候」这四个事实
 * @description
 * **刻意是最小的形状**：数据源**不参与判定**、不返回 verdict、不认识窗口类型——它只把增量按
 * `(用户, 方向, 字节, 时刻)` 追加到自己的存储里（绝对值一律在**读取时求和**得到）。
 *
 * **`record` 必须是同步的**（与 `consume` 同一条纪律）：它由 `UsageMirror.consume` 在**无
 * await 的同步区间内**调用，所以绝不允许有 Promise/IO。真正的落盘由数据源自己的后台循环负责。
 * **`consume` 绝不因为落盘失败而抛错或变慢**——磁盘满不该让代理拒服务。
 *
 * `ts` 显式传而不是让数据源自己取时钟：窗口键是「时刻 → 窗口」的纯映射，落盘侧必须与判定
 * 侧用**同一个**时刻算键（否则同一批字节会被分到两个窗口），而判定侧的时钟源是可注入的，
 * 数据源无从知道它。
 */
export interface UsageSink {
  record(user: string, dir: TrafficDirection, bytes: number, ts: number): void;
}

/**
 * 从数据源回读出来的一份用量（每个用户一条，**只含当前窗口**）
 * @description
 * `windowKey` 是这些字节**所属的窗口**（由条目 `ts` 经 `windowKey()` 算出）。数据源侧已经
 * 按「**只认当前窗口**」过滤过（见 `./jsonl-source.ts:summarizeCurrent` 与
 * `./sqlite-source.ts` 的扫描），所以这个键对每个用户都等于**读取那一刻**的当前窗口键；
 * 恢复方把它原样写进槽位后，惰性滚动那条既有路径（`./mirror.ts:slotFor` 的键比对）就成了
 * 第二道保险。
 *
 * `total` 是**双向合计**（两个方向求和）：判定只喂「单一合计上限」，不需要方向切分。方向
 * 信息没丢——它仍在账本条目里，要查「这 10G 是上传吃掉的还是下载吃掉的」直接看那个文件。
 */
export interface WindowUsage {
  readonly windowKey: string;
  readonly total: number;
}

/** 回读结果：用户名 → 该用户当前窗口的用量（**每个用户至多一条**）。 */
export type UsageSnapshot = ReadonlyMap<string, WindowUsage>;

/**
 * 落盘失败事实（写盘/压缩 IO 失败时上抛给装配点的旁路）
 * @description
 * **为什么需要它**：写盘失败绝不能让服务拒服务（内存计数照走），但也**绝不能静默吞掉**
 * ——静默 = 运维以为配额持久化了、重启后才发现用量全丢。「继续服务 + 一条可见事实」是
 * 唯一正确的失败形态。`path` 指向出问题的账本文件，`error` 是原始异常（消费方据此能判断
 * 是 `EACCES` 还是 `ENOSPC`）。
 */
export interface UsageSourceError {
  readonly path: string;
  readonly error: unknown;
}

/**
 * 用量数据源的**生命周期 + 回读**端口（`runtime.start/stop` 驱动面）
 * @description
 * 与 {@link UsageSink} **刻意分成两个端口**（两个调用方、两种失败代价）：`UsageSink.record`
 * 由 `consume` 在**同步区间内**调用（每 chunk 一次），抛错就等于把「写盘失败」变成
 * 「转发失败」，它因此必须是最小同步面；这里的 `open`/`close` 只在 `runtime.start()`/`stop()`
 * 各调一次，**允许 Promise**（读文件与最后一次落盘本来就是 IO）。合在一个接口上会让实现方
 * 被迫把两个面的语义混为一谈：尤其容易顺手让 `record` 也返回 Promise，那正是明确禁止的方向。
 *
 * `enabled` 为 false = **零成本档**（没有任何用户配了非 0 的 `quota.bytes`）：此时不建目录、
 * 不开句柄、不起定时器。`file` 仍是**构造期纯算出的路径**（不 stat 磁盘），供诊断与事件载荷
 * 使用。
 */
export interface UsageSourceController {
  /** 账本文件路径（构造期纯计算，不 stat 磁盘）。 */
  readonly file: string;
  /** 是否已启用。零成本档 / 未 `open()` / 已 `close()` 均为 false。 */
  readonly enabled: boolean;
  /** 未落盘的增量条数（写盘失败时它会累积 —— 那是「用量在涨、磁盘不认」的可见证据）。 */
  readonly queued: number;
  /** 幂等：建存储 → **回读一次**（启动期恢复）→ 起周期循环。 */
  open(): Promise<void>;
  /** 幂等：摘定时器 → **最后一次同步**（落盘 + 回读）→ 关存储。 */
  close(): Promise<void>;
}

/**
 * 用量数据源**替身**要同时满足的完整形状（数据面 {@link UsageSink} + 生命周期/回读面
 * {@link UsageSourceController}）
 *
 * @description
 * **它不合并那两个端口，只给「一份实现同时是两者」这件事起个名字。** 拆分那条裁决的判据是
 * **两个调用方、两种失败代价**（`consume` 的无 await 同步区间 vs `runtime.start/stop` 各一次），
 * 那条判据一个字都没被推翻：两个端口各自仍按原样被分别消费，本类型**只出现在注入面**
 * （`RuntimeServices.usageSource`），让「我换一份数据源实现」这句话有个能通过编译的形状。
 *
 * ### 为什么注入面必须是两者的并集，而不是 `UsageSourceController` 单独一个
 *
 * 只声明生命周期面的话，一份注入进来的数据源能 `open()`、能 `close()`、能报 `enabled: true` 与
 * 一个像模像样的 `file` 路径，**却一条记录都收不到**——因为 `record` 在另一个端口上，而唯一
 * 把两者接起来的 `UsageMirror.bindSink` **不在 `UsageAccount` 端口上**（它是镜像实现的具体
 * 方法，端口刻意不声明它：给逐请求端口加一个「挂载一次性对象」的方法，等于把进程级生命周期
 * 塞进包）。那是一个**静默失效**的注入位：编译通过、测试照绿、跑起来也正常，而 `queued` 恒为
 * 0、用量永不落盘。端口形状必须在**编译期**就要求替身把数据面一并做出来，否则这个位迟早
 * 被人当成「已经接上了」——而「看起来接上了」正是最贵的一种没接上。
 */
export interface UsageSource extends UsageSink, UsageSourceController {}

/**
 * 数据源的**平值规格**：目录 / 间隔 / 窗口口径 / 「有没有配额」/ 两个旁路
 * @description
 * **为什么是平值闭包而不是 `ConfigAccessor`**：数据源层零配置依赖（它连 `@/config` 都不许
 * import），而「热读」的能力必须保住——`quotaFlushInterval` / `quotaResetHour` 都是 **runtime
 * 相位**，改 `store` 应当立即生效。于是装配层（`runtime/services.ts`）从 `ConfigAccessor`
 * 取值、编成一组闭包传进来：**装配层知道配置，数据源只认值**。
 *
 * - `dir()` **只在构造期读一次**（账本目录是 **startup 相位**：运行中改目录 = 已打开的句柄
 *   仍指向旧文件，改了等于没改）。
 * - `flushMs()` / `resetHour()` / `windowFor()` / `enabled()` **每次现读**。
 * - `onSnapshot` 是回读出口：启动期一次（= 重启恢复），此后每轮周期一次（= 镜像回读）。
 *   **两个用途共用一个回调是刻意的**：恢复本来就是「恰好只做了一次的回读」，给它单独一个名字
 *   只会让下一个人实现出两套过滤判据（那正是「恢复算进来的量比压缩保留的量多」那条 bug 的形状）。
 * - `onError` 是落盘失败的旁路；**旁路抛错绝不能打断落盘主流程**（那会把「写盘失败」升级成
 *   「代理崩」）。
 */
export interface UsageSourceSpec {
  /** 账本目录（startup 相位 → 构造期读一次）。**不校验、不创建**。 */
  readonly dir: () => string;
  /** 落盘 + 回读周期 ms（runtime 相位 → **每次现读**）。 */
  readonly flushMs: () => number;
  /** 窗口重置小时（runtime 相位 → **每次现读**）。 */
  readonly resetHour: () => number;
  /** 该用户生效的窗口类型（配额来自账号表，经装配点注入；缺省在 `quotaWindow()` 里归一）。 */
  readonly windowFor: (user: string) => QuotaWindow;
  /** **文件事实**：是否有任何用户配了非 0 的 `quota.bytes`。false → 零成本档。 */
  readonly enabled: () => boolean;
  /** 回读出口：启动期一次（恢复），此后每轮周期一次（镜像回读）。 */
  readonly onSnapshot?: (snapshot: UsageSnapshot) => void;
  /** 落盘失败的旁路（runtime 用它发 `traffic.ledger-error` + error 日志）。 */
  readonly onError?: (event: UsageSourceError) => void;
  /** 时钟源（可注入；默认墙钟）。窗口键计算、「过期窗口」判定、压缩判阈值都用它。 */
  readonly now?: () => number;
}

/**
 * 一个用量数据源的工厂（注册表里存的就是它）
 * @description **收平值规格，不收 `ConfigAccessor`**：理由见 {@link UsageSourceSpec}。
 */
export type UsageSourceFactory = (spec: UsageSourceSpec) => UsageSource;
