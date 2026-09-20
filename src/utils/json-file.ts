/**
 * JSON 配置文件读取器 - mtime 节流热加载 + 坏内容不接管
 * 职责：
 * - 读取 JSON 配置文件并校验，缓存结果；文件变更（mtime/size）时自动重载
 * - 节流：每文件最多 maxAgeMs 一次 stat，多会话并发调用共享同一份缓存，不各读一次文件
 * - 失败语义：文件缺失 = 使用 fallback（空配置，不报错）；存在但内容非法 = 保留上一份有效值 + 记错误
 * 设计：
 * - 绝不抛：调用点分布在每连接（ACL）与每请求（鉴权）路径上，任何异常都不得外溢
 * - 读取同步（节流后频率极低），无异步竞态；缓存条目只被当前线程访问，天然并发安全
 * - 错误按「变化才打」去重，避免坏文件期间刷屏
 */

import fs from "node:fs";
import { getLogger } from "@/utils/logger.js";

/** 配置读取器日志（模块级单例，前缀 [proxy]:config） */
const log = getLogger("config");

/** 默认节流窗口：同一文件 1s 内不重复 stat */
const DEFAULT_MAX_AGE_MS = 1000;
/** 默认文件大小上限：1MiB，防病态大文件拖住事件循环 */
const DEFAULT_MAX_BYTES = 1024 * 1024;
/** 缓存条目上限：超出后按插入顺序淘汰最旧路径（测试会切多个临时目录） */
const MAX_CACHED_FILES = 16;

/**
 * 读取选项
 * @param label - 配置名（日志用，如 `acl.json`）
 * @param fallback - 文件缺失时使用的空配置值（必须与 T 同型，且视为只读）
 * @param maxAgeMs - stat 节流窗口，默认 1000
 * @param maxBytes - 文件大小上限，默认 1MiB
 * @param force - 跳过节流强制重读（启动期校验用）
 */
export interface JsonFileOptions<T> {
  label: string;
  fallback: T;
  maxAgeMs?: number;
  maxBytes?: number;
  force?: boolean;
}

/**
 * 读取结果
 * @param value - 生效值（文件内容或上一份有效值或 fallback）
 * @param path - 文件路径
 * @param exists - 本轮检测时文件是否存在
 * @param error - 最近一次读取/校验失败原因；无错误为 undefined
 */
export interface JsonFileRead<T> {
  value: T;
  path: string;
  exists: boolean;
  error?: string;
}

/** 单文件缓存条目 */
interface CacheEntry {
  value: unknown;
  error?: string;
  /** 最近一次 stat 的时间戳，节流用 */
  checkedAt: number;
  mtimeMs: number;
  size: number;
  exists: boolean;
  /** 已打过的错误文本，用于去重刷屏 */
  loggedError?: string;
}

/** 路径 → 缓存条目 */
const caches = new Map<string, CacheEntry>();

/** 写入缓存并按上限淘汰最旧条目 */
function putCache(path: string, entry: CacheEntry): void {
  caches.delete(path);
  caches.set(path, entry);
  while (caches.size > MAX_CACHED_FILES) {
    const oldest = caches.keys().next();
    if (oldest.done) {
      break;
    }
    caches.delete(oldest.value);
  }
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
  path: string,
  validate: (raw: unknown) => T | undefined,
  opts: JsonFileOptions<T>,
): JsonFileRead<T> {
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = Date.now();
  const cached = caches.get(path) as CacheEntry | undefined;

  if (!opts.force && cached && now - cached.checkedAt < maxAge) {
    return { value: cached.value as T, path, exists: cached.exists, error: cached.error };
  }

  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(path);
  } catch {
    stat = undefined;
  }

  // 文件缺失 / 不是普通文件：视为空配置（回退 fallback），不算错误
  if (!stat || !stat.isFile()) {
    const entry: CacheEntry = {
      value: opts.fallback,
      checkedAt: now,
      mtimeMs: 0,
      size: 0,
      exists: false,
    };
    putCache(path, entry);
    return { value: opts.fallback, path, exists: false };
  }

  // 未变更：只刷新节流时间戳，复用缓存值（含上一份错误状态）
  if (cached && cached.exists && stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
    cached.checkedAt = now;
    return { value: cached.value as T, path, exists: true, error: cached.error };
  }

  let value = cached?.value ?? opts.fallback;
  let error: string | undefined;

  try {
    if (stat.size > maxBytes) {
      throw new Error(`文件超过 ${maxBytes} 字节上限`);
    }
    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const valid = validate(parsed);
    if (valid === undefined) {
      throw new Error("格式非法（字段缺失、类型不符或存在未知键）");
    }
    value = valid;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const entry: CacheEntry = {
    value,
    error,
    checkedAt: now,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    exists: true,
    loggedError: cached?.loggedError,
  };

  // 错误按「变化才打」去重：坏文件持续期间不刷屏，恢复时给一条 info
  if (error) {
    if (error !== entry.loggedError) {
      log.warn(`[config] ${opts.label} 读取失败: ${path}: ${error}（沿用上一份有效配置）`);
      entry.loggedError = error;
    }
  } else if (entry.loggedError) {
    log.info(`[config] ${opts.label} 已恢复: ${path}`);
    entry.loggedError = undefined;
  }

  putCache(path, entry);
  return { value: value as T, path, exists: true, error };
}
