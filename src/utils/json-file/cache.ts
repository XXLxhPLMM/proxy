/**
 * @fileoverview 跨调用共享的节流缓存（键、条目、LRU 写入）
 * @module utils/json-file/cache
 * @description
 * 多会话并发调用同一份配置文件时共享**一份** stat + 读取结果；每个文件最多
 * `maxAgeMs` 一次 stat。缓存键严格是 `` `${label}\0${绝对路径}` ``，所以同一路径
 * 供不同 validator / 不同配置类别使用互不串型。
 *
 * 职责：
 * - `CacheEntry` 缓存条目形状（含 `statError` 标记与节流时间戳）
 * - `cacheKey(label, path)` 键的拼装（path 必须已绝对化）
 * - `putCache(key, entry)` 写入并按上限淘汰最旧条目
 *
 * 不负责：
 * - **不做 stat、不读文件、不判定变更**（那是 `probe.ts` / `read-validate.ts` /
 *   `json-file.ts`）
 * - 不做事件去重（`subscriber.ts`）：去重状态按 `onEvent` 回调隔离，不随共享缓存走
 */

/** 缓存条目上限：超出后按插入顺序淘汰最旧路径（测试会切多个临时目录） */
const MAX_CACHED_FILES = 16;

/** 单文件缓存条目 */
export interface CacheEntry {
  value: unknown;
  error?: string;
  /** 最近一次 stat 的时间戳，节流用 */
  checkedAt: number;
  mtimeMs: number;
  size: number;
  exists: boolean;
  /** stat 本身失败（而非文件缺失/非普通文件）；恢复时必须重新尝试读取。 */
  statError?: boolean;
}

/** `${配置类别}\0${文件路径}` → 缓存条目；同一路径供不同 validator 使用时互不串型。 */
export const caches = new Map<string, CacheEntry>();

/**
 * 拼装缓存键：配置类别 + 绝对路径。
 *
 * @param label - 配置名（订阅方原样回传的 label）
 * @param path - 已绝对化的文件路径
 */
export function cacheKey(label: string, path: string): string {
  return `${label}\0${path}`;
}

/**
 * 构造「文件缺失」条目：值回退空配置、版本归零、`exists=false`。
 *
 * 缺失条目**不带 error**（缺失不算错误），版本必须归零，否则残留的旧 mtime/size
 * 会让事件带上一个并不存在的文件版本。
 *
 * @param fallback - 调用方的空配置值
 * @param checkedAt - 本轮节流时间戳
 */
export function missingEntry(fallback: unknown, checkedAt: number): CacheEntry {
  return { value: fallback, checkedAt, mtimeMs: 0, size: 0, exists: false };
}

/**
 * 写入缓存并按上限淘汰最旧条目。
 *
 * 先 `delete` 再 `set`：Map 按插入顺序迭代，删除后重插即刷新该键的年龄，
 * 于是淘汰的永远是「最久没被更新过」的那个，而不是「最久没被访问过」的那个。
 *
 * @param key - `cacheKey` 拼出的键
 * @param entry - 本轮产出的缓存条目
 */
export function putCache(key: string, entry: CacheEntry): void {
  caches.delete(key);
  caches.set(key, entry);
  while (caches.size > MAX_CACHED_FILES) {
    const oldest = caches.keys().next();
    if (oldest.done) {
      break;
    }
    caches.delete(oldest.value);
  }
}
