/**
 * @fileoverview JSON 配置文件读取器 - mtime 节流热加载 + 坏内容不接管
 * @module utils/json-file/json-file
 * @description
 * 本文件**只做编排**：probe → 节流命中 → 未变更 → 读取 → 落缓存 → 通知。判定与副作用都在
 * 层内叶模块里，这里不再出现任何「要不要报事件」的判断：`types.ts`（类型契约，零运行时值）/
 * `cache.ts`（缓存键与条目）/ `subscriber.ts`（去重派发，唯一判定点）/ `probe.ts`（stat 三态）/
 * `read-validate.ts`（读文件 + 形状校验）/ `index.ts`（目录出口，跨目录只引 barrel）。
 *
 * 语义（逐条都是契约）：
 * - 绝不抛：调用点分布在每连接（ACL）与每请求（鉴权）路径上，任何异常都不得外溢
 *   （订阅回调抛错同样吞掉）
 * - 读取同步（节流后频率极低），无异步竞态；缓存条目只被当前线程访问，天然并发安全
 * - 入口立即绝对化相对路径：缓存键、stat/read、事件和返回值都不随后续 `process.chdir` 漂移
 * - 事件按「变化才触发」去重，避免坏文件期间每个连接都收到重复通知
 * - 本模块不依赖 logger：是否记日志、记什么等级由订阅方（config 层）决定
 */

import fs from "node:fs";
import path from "node:path";
import { cacheKey, caches, missingEntry, putCache, type CacheEntry } from "./cache.js";
import { probeFile } from "./probe.js";
import { readVia } from "./read-validate.js";
import { notifyTransition, transitionContext } from "./subscriber.js";
import type { JsonFileOptions, JsonFileRead } from "./types.js";

/** 默认节流窗口：同一文件 1s 内不重复 stat */
const DEFAULT_MAX_AGE_MS = 1000;
/** 默认文件大小上限：1MiB，防病态大文件拖住事件循环 */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * 节流缓存读取的**通用编排**（格式无关）
 * @description
 * 本模块的全部机制都在这里且**只**在这里：mtime 节流、坏内容沿用上一份、四态迁移事件、
 * 缓存条目。「文件内容怎么变成可信值」是唯一被参数化掉的部分（`load`）。
 *
 * 抽出它是为了**格式可切换**：账号表既要能读 `users.json`、也能读 SQLite 库，而后者
 * 同样需要「1s stat 节流 + 坏内容不接管 + error/missing/recovered/reloaded 四态事件」。
 * 若让 SQLite 那侧自己写一份节流与事件，本目录就会有两个真相源，而**缓存键**一旦撞上
 * （同一个 `label + path`）两份缓存会互相污染那种观察结果。
 *
 * ⚠️ **调用方的 `load` 必须自己处理「文件不存在」吗？** 不需要：不存在由本函数的
 * `probe` 分支拦掉（回退 `fallback` + 发 `missing`），`load` 只在**已确认存在的普通文件**
 * 上被调用。`load` 抛错则被吞成 error 事件、沿用上一份——与 JSON 路径逐字同形。
 *
 * @param path - 文件路径（可为相对路径，按进程 cwd 解析）
 * @param load - 把文件内容变成可信值的解析函数；抛错或返回 undefined 均视为坏内容
 * @param opts - 选项，见 JsonFileOptions（`maxBytes` 默认 1MiB）
 * @returns 读取结果，绝不抛
 */
export function readCachedSource<T>(
  inputPath: string,
  load: (absolutePath: string) => T | undefined,
  opts: JsonFileOptions<T>,
): JsonFileRead<T> {
  // 入口立即固定绝对路径：缓存键、stat/read、事件和返回值不能因调用方后续
  // 改变 cwd 而指向不同对象。
  const absolutePath = path.resolve(inputPath);
  const now = Date.now();
  const key = cacheKey(opts.label, absolutePath);
  const cached = caches.get(key);
  const notify = transitionContext(opts, key, absolutePath);

  // ① 节流命中：本轮不 stat，只补发尚未上报过的 missing / error
  if (!opts.force && cached && now - cached.checkedAt < (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
    notifyTransition(notify, "throttled", cached, cached);
    return {
      value: cached.value as T,
      path: absolutePath,
      exists: cached.exists,
      error: cached.error,
    };
  }

  const probe = probeFile(absolutePath);

  // ② stat 状态不可观测：保留已有观察结果（无历史时用 fallback），只报 error
  if (probe.kind === "stat-error") {
    const message = `读取状态失败: ${probe.message}`;
    const entry: CacheEntry = {
      value: (cached?.value as T) ?? opts.fallback,
      error: message,
      checkedAt: now,
      mtimeMs: cached?.mtimeMs ?? 0,
      size: cached?.size ?? 0,
      exists: cached?.exists ?? false,
      statError: true,
    };
    notifyTransition(notify, "stat-error", cached, entry);
    putCache(key, entry);
    return { value: entry.value as T, path: absolutePath, exists: entry.exists, error: message };
  }

  // ③ 文件缺失 / 非普通文件：回退空配置，不算错误（disappear 的可见性由 missing 事件兜底）
  if (probe.kind === "missing") {
    const entry = missingEntry(opts.fallback, now);
    notifyTransition(notify, "missing", cached, entry);
    putCache(key, entry);
    return { value: opts.fallback, path: absolutePath, exists: false };
  }

  const stat = probe.stats;

  // ④ 未变更：只刷新节流时间戳，复用缓存值（含上一份内容错误状态）。statError 必须
  //    继续尝试，否则权限恢复后同版本文件永远无法触发 recovered。
  if (
    cached &&
    cached.exists &&
    !cached.statError &&
    stat.mtimeMs === cached.mtimeMs &&
    stat.size === cached.size
  ) {
    cached.checkedAt = now;
    notifyTransition(notify, "unchanged", cached, cached);
    return { value: cached.value as T, path: absolutePath, exists: true, error: cached.error };
  }

  // ⑤ 真读：大小上限 → 解析 → 形状校验；失败沿用上一份有效值并带 error
  const read = readVia(
    absolutePath,
    stat.size,
    opts.maxBytes ?? DEFAULT_MAX_BYTES,
    load,
    (cached?.value as T) ?? opts.fallback,
  );
  const entry: CacheEntry = {
    value: read.value,
    error: read.error,
    checkedAt: now,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    exists: true,
  };
  notifyTransition(notify, "read", cached, entry);
  putCache(key, entry);
  return { value: read.value, path: absolutePath, exists: true, error: read.error };
}

/**
 * 读取并校验 JSON 配置文件（带节流缓存）
 * @param path - 文件路径（可为相对路径，按进程 cwd 解析）
 * @param validate - 校验函数：合法返回解析值，非法返回 undefined
 * @param opts - 选项，见 JsonFileOptions
 * @returns 读取结果，绝不抛
 * @example
 * const r = readJsonCached("/etc/proxy/acl.json", validateAcl, { label: "acl.json", fallback: EMPTY_ACL });
 * if (r.error) { ... } // r.value 仍是上一份有效值
 */
export function readJsonCached<T>(
  inputPath: string,
  validate: (raw: unknown) => T | undefined,
  opts: JsonFileOptions<T>,
): JsonFileRead<T> {
  // 本函数是 {@link readCachedSource} 的一层「JSON 特化」：节流、缓存、事件全部由它做，
  // 这里只把「读文件 + parse + 校验」折成它的 `load`。**刻意不复制那 60 行编排**——
  // 两份节流缓存一旦撞上同一个 `label + path` 键就会互相污染出无法解释的观察结果。
  return readCachedSource(
    inputPath,
    (absolutePath) => validate(JSON.parse(fs.readFileSync(absolutePath, "utf8")) as unknown),
    opts,
  );
}
