/**
 * JSON 配置文件读取器 - mtime 节流热加载 + 坏内容不接管
 * 职责：
 * - 读取 JSON 配置文件并校验，缓存结果；文件变更（mtime/size）时自动重载
 * - 节流：每个「资源 + 路径」最多 maxAgeMs 一次 stat，多会话并发调用共享同一份缓存
 * - 失败语义：真正缺失（ENOENT/ENOTDIR）回退空配置；其它 I/O、非普通文件和 schema
 *   错误保留上一份有效值，没有有效值才回退空配置
 * - 状态迁移以事件抛出（onEvent）：error / missing / recovered / reloaded
 * 兄弟模块（同目录，勿合并）：
 * - `json-event.ts` 事件类型与发布（对外契约）
 * - `json-error-text.ts` 错误文本去敏（错误码提取也在这里）
 * 设计：
 * - 绝不抛：调用点分布在每连接（ACL）与每请求（鉴权）路径上，任何异常都不得外溢
 * - 事件只携带路径、状态、版本和去敏错误文本，不携带解析值、密码、快照或原始 Error
 * - 事件在缓存条目提交之后发布，订阅者回调内再次 pull 时能看到已提交状态
 * - 读取同步（节流后频率极低），无异步竞态；缓存条目只被当前线程访问，天然并发安全
 * - 事件按「变化才触发」去重，避免坏文件期间每个连接都收到重复通知
 * - 本模块**不依赖 logger**：是否记日志、记什么等级由订阅方（config 层）决定
 */

import fs from "node:fs";
import {
  isMissingError,
  ioErrorText,
  sanitizeJsonFileErrorText,
} from "./json-error-text.js";
import {
  emitJsonFileEvent,
  makeJsonFileEvent,
  type JsonFileEvent,
} from "./json-event.js";

export type {
  JsonFileEvent,
  JsonFileEventSink,
  JsonFileOutcome,
  JsonFileTransition,
} from "./json-event.js";
export { sanitizeJsonFileErrorText } from "./json-error-text.js";

/** 默认节流窗口：同一资源/文件 1s 内不重复 stat */
const DEFAULT_MAX_AGE_MS = 1000;
/** 默认文件大小上限：1MiB，防病态大文件拖住事件循环 */
const DEFAULT_MAX_BYTES = 1024 * 1024;
/** 缓存条目上限：超出后按插入顺序淘汰最旧路径（测试会切多个临时目录） */
const MAX_CACHED_FILES = 16;
/** 资源与路径之间的缓存键分隔符；NUL 不可能出现在正常文件路径中。 */
const CACHE_KEY_SEPARATOR = "\u0000";

/** 读取选项 */
export interface JsonFileOptions<T> {
  /** 配置名（事件回传用，如 `acl.json`） */
  label: string;
  /** 文件缺失时使用的空配置值（必须与 T 同型，且视为只读） */
  fallback: T;
  /**
   * 资源身份。相同 path 的 authUsers/acl 必须传不同值，避免共享值、错误和
   * missing 状态；省略时使用匿名默认身份，保持通用读取器可用。
   */
  resource?: string;
  /** stat 节流窗口，默认 1000 */
  maxAgeMs?: number;
  /** 文件大小上限，默认 1MiB */
  maxBytes?: number;
  /** 跳过节流强制重读（启动期校验用） */
  force?: boolean;
  /** 状态迁移事件回调；只在变化时调用。回调抛错被吞掉，绝不影响读取 */
  onEvent?: (event: JsonFileEvent) => void | Promise<void>;
}

/** 读取结果 */
export interface JsonFileRead<T> {
  /** 生效值（文件内容或上一份有效值或 fallback） */
  value: T;
  /** 文件路径 */
  path: string;
  /** 本轮是否确认目标是可读取的普通文件 */
  exists: boolean;
  /** 最近一次读取/校验失败的去敏原因；无错误为 undefined */
  error?: string;
}

/** 解析并校验文件内容成功后的结果 */
interface ParsedOk<T> {
  value: T;
  error?: undefined;
}
/** 解析/校验失败：只带固定去敏文案，绝不带 `JSON.parse` 原始错误（可能含文件片段） */
interface ParsedBad {
  value?: undefined;
  error: string;
}

/**
 * 读文本 → JSON.parse → 校验器（与缓存/节流/事件无关的纯流程）
 * @param file - 文件路径（调用方已确认是普通文件且未超大小上限）
 * @param validate - 校验器；返回 undefined 即视为格式非法
 * @returns 校验通过返回值，否则返回固定文案（三类失败各有各的文案，不合并）
 */
function readAndValidate<T>(file: string, validate: (raw: unknown) => T | undefined): ParsedOk<T> | ParsedBad {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (readError) {
    // 文件在 stat 之后消失（TOCTOU）按普通读取失败处理：此时缓存里已有条目，
    // 走 commitError 的「保留上一份有效值」比回退空配置更安全。
    return { error: ioErrorText("读取", readError) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { error: "JSON 解析失败" };
  }

  const valid = validate(parsed);
  return valid === undefined
    ? { error: "格式非法（字段缺失、类型不符或存在未知键）" }
    : { value: valid };
}

/** 单个「资源 + 路径」缓存条目 */
interface CacheEntry {
  value: unknown;
  error?: string;
  /** 最近一次 stat 的时间戳，节流用 */
  checkedAt: number;
  mtimeMs: number;
  size: number;
  /** 是否确认目标是普通文件（stat/非普通文件错误时为 false） */
  exists: boolean;
  /** 当前 value 是否来自一份成功校验过的文件内容 */
  hasValidValue: boolean;
  /** 最近一次已通知的错误文本，用于事件去重 */
  reportedError?: string;
  /** 文件是否已经进入 missing 状态；用于恢复事件和 missing 去重 */
  missingReported: boolean;
}

/** 「资源 + 路径」→ 缓存条目 */
const caches = new Map<string, CacheEntry>();

/** 生成不会让不同资源共享缓存身份的键。 */
function cacheKey(path: string, resource: string | undefined): string {
  return `${resource ?? ""}${CACHE_KEY_SEPARATOR}${path}`;
}

/** 写入缓存并按上限淘汰最旧条目 */
function putCache(key: string, entry: CacheEntry): void {
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

/** 读取并校验 JSON 配置文件（带节流缓存） */
export function readJsonCached<T>(
  path: string,
  validate: (raw: unknown) => T | undefined,
  opts: JsonFileOptions<T>,
): JsonFileRead<T> {
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = Date.now();
  const key = cacheKey(path, opts.resource);
  const cached = caches.get(key) as CacheEntry | undefined;

  if (!opts.force && cached && now - cached.checkedAt < maxAge) {
    return { value: cached.value as T, path, exists: cached.exists, error: cached.error };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch (error) {
    if (isMissingError(error)) {
      return commitMissing(path, opts, cached, now);
    }
    return commitError(path, opts, cached, now, ioErrorText("stat", error), false);
  }

  // 目录、socket、设备等都不是可读取的 JSON 资源；它们不是「缺失」。
  if (!stat.isFile()) {
    return commitError(path, opts, cached, now, "目标不是普通文件", false, stat);
  }

  // 未变更：只刷新节流时间戳，复用缓存值（含上一份错误状态）。force 要真正重读，
  // 以便同 mtime/size 的修复仍能被校验器重新判定。
  const versionUnchanged =
    cached?.exists === true && stat.mtimeMs === cached.mtimeMs && stat.size === cached.size;
  if (!opts.force && versionUnchanged) {
    cached.checkedAt = now;
    return { value: cached.value as T, path, exists: true, error: cached.error };
  }

  // 已有有效值时沿用它，否则用 fallback——「保留旧值」与「回退空配置」的唯一分叉点
  const retainOrFallback = (): T =>
    (cached?.hasValidValue ? cached.value : opts.fallback) as T;

  let nextValue: T;
  let error: string | undefined;

  if (stat.size > maxBytes) {
    nextValue = retainOrFallback();
    error = `文件超过 ${maxBytes} 字节上限`;
  } else {
    const parsed = readAndValidate(path, validate);
    if (parsed.error !== undefined) {
      nextValue = retainOrFallback();
      error = parsed.error;
    } else {
      nextValue = parsed.value;
    }
  }

  const safeError = error === undefined ? undefined : sanitizeJsonFileErrorText(error);
  const entry: CacheEntry = {
    value: nextValue,
    error: safeError,
    checkedAt: now,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    exists: true,
    hasValidValue: safeError === undefined || cached?.hasValidValue === true,
    reportedError: safeError,
    missingReported: false,
  };

  // 先更新去重状态并提交缓存，再通知订阅者；回调内 pull 必须看到本轮状态。
  putCache(key, entry);
  publishTransition(opts, path, cached, entry, versionUnchanged, stat);

  return { value: nextValue, path, exists: true, error: safeError };
}

/**
 * 按「本轮结果 vs 上一轮缓存」发布状态迁移事件（按变化去重）
 * @description 事件在 `putCache` **之后**才发布，订阅者回调内再次 pull 必须看到本轮已提交状态。
 *   四类迁移的判定完全由 `error` 与 `missingReported`/`reportedError` 三个缓存字段决定，
 *   「变化才触发」的去重也在这里，因此这是事件语义的唯一收口。
 */
function publishTransition<T>(
  opts: JsonFileOptions<T>,
  path: string,
  cached: CacheEntry | undefined,
  entry: CacheEntry,
  versionUnchanged: boolean,
  stat: fs.Stats,
): void {
  const meta = { label: opts.label, resource: opts.resource };
  const version = { mtimeMs: stat.mtimeMs, size: stat.size };

  // 本轮出错：只在错误文本变化时通知（避免坏文件期间每连接一条）
  if (entry.error !== undefined) {
    if (entry.error !== cached?.reportedError) {
      emitJsonFileEvent(
        opts.onEvent,
        makeJsonFileEvent(
          meta,
          path,
          "error",
          cached?.hasValidValue === true ? "retained" : "fallback",
          entry.error,
          version,
        ),
      );
    }
    return;
  }

  // 本轮成功：上一轮有失败（error 态或 missing 态）就是「恢复」，否则版本变了才是「热加载」
  const hadFailure =
    cached?.error !== undefined ||
    cached?.reportedError !== undefined ||
    cached?.missingReported === true;

  if (hadFailure) {
    emitJsonFileEvent(
      opts.onEvent,
      makeJsonFileEvent(meta, path, "recovered", "adopted", undefined, version),
    );
  } else if (cached !== undefined && !versionUnchanged) {
    emitJsonFileEvent(
      opts.onEvent,
      makeJsonFileEvent(meta, path, "reloaded", "adopted", undefined, version),
    );
  }
}

/** 提交真正的缺失状态；现有安全语义是回退 fallback，不保留已加载值。 */
function commitMissing<T>(
  path: string,
  opts: JsonFileOptions<T>,
  cached: CacheEntry | undefined,
  checkedAt: number,
): JsonFileRead<T> {
  const wasKnown = cached !== undefined && (cached.exists || cached.error !== undefined);
  const entry: CacheEntry = {
    value: opts.fallback,
    checkedAt,
    mtimeMs: 0,
    size: 0,
    exists: false,
    hasValidValue: false,
    missingReported: true,
  };
  const key = cacheKey(path, opts.resource);

  // 首次缺失不是状态迁移；已存在/曾出错后转为缺失才发一条 missing。
  putCache(key, entry);
  if (wasKnown) {
    emitJsonFileEvent(
      opts.onEvent,
      makeJsonFileEvent({ label: opts.label, resource: opts.resource }, path, "missing", "fallback"),
    );
  }
  return { value: opts.fallback, path, exists: false };
}

/** 提交 I/O、非普通文件或 schema 错误。 */
function commitError<T>(
  path: string,
  opts: JsonFileOptions<T>,
  cached: CacheEntry | undefined,
  checkedAt: number,
  error: string,
  exists: boolean,
  stat?: fs.Stats,
): JsonFileRead<T> {
  const safeError = sanitizeJsonFileErrorText(error);
  const retained = cached?.hasValidValue === true;
  const value = (retained ? cached.value : opts.fallback) as T;
  const entry: CacheEntry = {
    value,
    error: safeError,
    checkedAt,
    mtimeMs: stat?.mtimeMs ?? 0,
    size: stat?.size ?? 0,
    exists,
    hasValidValue: retained,
    reportedError: safeError,
    missingReported: false,
  };
  const key = cacheKey(path, opts.resource);

  putCache(key, entry);
  if (safeError !== cached?.reportedError) {
    emitJsonFileEvent(
      opts.onEvent,
      makeJsonFileEvent(
        { label: opts.label, resource: opts.resource },
        path,
        "error",
        retained ? "retained" : "fallback",
        safeError,
        stat === undefined ? undefined : { mtimeMs: stat.mtimeMs, size: stat.size },
      ),
    );
  }
  return { value, path, exists, error: safeError };
}
