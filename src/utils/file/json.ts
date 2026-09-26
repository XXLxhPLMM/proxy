/**
 * JSON 配置文件读取器 - mtime 节流热加载 + 坏内容不接管
 * 职责：
 * - 读取 JSON 配置文件并校验，缓存结果；文件变更（mtime/size）时自动重载
 * - 节流：每个「资源 + 路径」最多 maxAgeMs 一次 stat，多会话并发调用共享同一份缓存
 * - 失败语义：真正缺失（ENOENT/ENOTDIR）回退空配置；其它 I/O、非普通文件和 schema
 *   错误保留上一份有效值，没有有效值才回退空配置
 * - 状态迁移以事件抛出（onEvent）：error / missing / recovered / reloaded；本模块不依赖 logger，
 *   是否记日志、记什么等级由订阅方（config 层）决定
 * 设计：
 * - 绝不抛：调用点分布在每连接（ACL）与每请求（鉴权）路径上，任何异常都不得外溢（订阅回调抛错同样吞掉）
 * - 事件只携带路径、状态、版本和去敏错误文本，不携带解析值、密码、快照或原始 Error
 * - 事件在缓存条目提交之后发布，订阅者回调内再次 pull 时能看到已提交状态
 * - 读取同步（节流后频率极低），无异步竞态；缓存条目只被当前线程访问，天然并发安全
 * - 事件按「变化才触发」去重，避免坏文件期间每个连接都收到重复通知
 * - 错误文本净化复用 `utils/log/text.ts:stripControlChars`（控制字符折叠为空格），
 *   不在本文件另写一份控制字符判定
 */

import fs from "node:fs";
import { stripControlChars } from "@/utils/log/text.js";

/** 默认节流窗口：同一资源/文件 1s 内不重复 stat */
const DEFAULT_MAX_AGE_MS = 1000;
/** 默认文件大小上限：1MiB，防病态大文件拖住事件循环 */
const DEFAULT_MAX_BYTES = 1024 * 1024;
/** 缓存条目上限：超出后按插入顺序淘汰最旧路径（测试会切多个临时目录） */
const MAX_CACHED_FILES = 16;
/** 错误文本上限，避免异常消息无限进入日志/事件。 */
const MAX_ERROR_LENGTH = 240;
/** 资源与路径之间的缓存键分隔符；NUL 不可能出现在正常文件路径中。 */
const CACHE_KEY_SEPARATOR = "\u0000";

/** 状态迁移事件类型：读失败 / 文件消失 / 恢复 / 热加载 */
export type JsonFileTransition = "error" | "missing" | "recovered" | "reloaded";

/** 状态迁移后生效值的来源。 */
export type JsonFileOutcome = "adopted" | "retained" | "fallback";

/**
 * 状态迁移事件（仅在变化时触发一次；节流命中与首次成功加载不触发）。
 * @param transition - 迁移类型，见 JsonFileTransition
 * @param label - 配置名（原样回传 opts.label，供订阅方呈现）
 * @param path - 文件路径
 * @param outcome - 本轮生效值是采用新值、保留旧值还是回退 fallback
 * @param error - transition === "error" 时的去敏失败文本
 * @param mtimeMs - 触发事件的这份内容的 mtime（毫秒）；missing 或无法 stat 时无值
 * @param size - 触发事件的这份内容的字节数；missing 或无法 stat 时无值
 * @param resource - 可选资源身份；由 config 资源桥补齐
 */
export interface JsonFileEvent {
  readonly transition: JsonFileTransition;
  readonly label: string;
  readonly path: string;
  readonly outcome: JsonFileOutcome;
  readonly error?: string;
  readonly mtimeMs?: number;
  readonly size?: number;
  readonly resource?: string;
}

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

/** 将错误消息压成安全的纯文本；不接收 Error、配置内容或 stack。 */
export function sanitizeJsonFileErrorText(text: string): string {
  const withoutControls = stripControlChars(text);
  const collapsed = withoutControls.replace(/\s+/g, " ").trim();

  // 读取器自身不会把 JSON 内容放进错误文本；这层额外保护未来的校验器/发布者。
  const normalized = collapsed.replace(
    /((?:password|passwd|secret|token|authorization|credential|username|密码|密钥)\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1[redacted]",
  );

  if (normalized.length === 0) {
    return "未知错误";
  }
  if (normalized.length > MAX_ERROR_LENGTH) {
    return `${normalized.slice(0, MAX_ERROR_LENGTH - 1)}…`;
  }
  return normalized;
}

/** 从 unknown 中取出 Node 风格错误码，不把原始异常带出缓存层。 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** 只有真正的 ENOENT/ENOTDIR 表示路径不存在。 */
function isMissingError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 生成不含原始 message/stack 的 I/O 错误文本。 */
function ioErrorText(operation: string, error: unknown): string {
  const code = errorCode(error);
  return sanitizeJsonFileErrorText(
    code === undefined ? `${operation}失败` : `${operation}失败 (${code})`,
  );
}

/**
 * 构造事件对象。事件只接收标量元数据，避免把解析值或原始异常带出缓存层。
 */
function makeEvent<T>(
  opts: JsonFileOptions<T>,
  path: string,
  transition: JsonFileTransition,
  outcome: JsonFileOutcome,
  error?: string,
  stat?: fs.Stats,
): JsonFileEvent {
  const safeError = error === undefined ? undefined : sanitizeJsonFileErrorText(error);
  return {
    transition,
    label: opts.label,
    path,
    outcome,
    ...(opts.resource === undefined ? {} : { resource: opts.resource }),
    ...(safeError === undefined ? {} : { error: safeError }),
    ...(stat === undefined ? {} : { mtimeMs: stat.mtimeMs, size: stat.size }),
  };
}

/**
 * 抛出状态迁移事件；订阅方回调抛错或异步拒绝不得影响读取。
 * @param onEvent - 订阅回调（可选）
 * @param event - 事件
 */
function emitEvent(
  onEvent: ((event: JsonFileEvent) => void | Promise<void>) | undefined,
  event: JsonFileEvent,
): void {
  if (onEvent === undefined) {
    return;
  }
  try {
    const result = onEvent(event);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {
        // 订阅方故障与本模块无关：吞掉，保证读取路径绝不外抛。
      });
    }
  } catch {
    // 订阅方故障与本模块无关：吞掉，保证读取路径绝不外抛。
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

  let nextValue: T = (cached?.hasValidValue ? cached.value : opts.fallback) as T;
  let error: string | undefined;

  if (stat.size > maxBytes) {
    error = `文件超过 ${maxBytes} 字节上限`;
    nextValue = (cached?.hasValidValue ? cached.value : opts.fallback) as T;
  } else {
    let raw: string;
    try {
      raw = fs.readFileSync(path, "utf8");
    } catch (readError) {
      if (isMissingError(readError)) {
        return commitMissing(path, opts, cached, now);
      }
      error = ioErrorText("读取", readError);
      nextValue = (cached?.hasValidValue ? cached.value : opts.fallback) as T;
      raw = "";
    }

    if (error === undefined) {
      try {
        // 不把 JSON.parse 原始错误（可能包含文件片段）带出缓存层。
        const parsed = JSON.parse(raw) as unknown;
        const valid = validate(parsed);
        if (valid === undefined) {
          error = "格式非法（字段缺失、类型不符或存在未知键）";
          nextValue = (cached?.hasValidValue ? cached.value : opts.fallback) as T;
        } else {
          nextValue = valid;
        }
      } catch {
        error = "JSON 解析失败";
        nextValue = (cached?.hasValidValue ? cached.value : opts.fallback) as T;
      }
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
  if (safeError !== undefined && safeError !== cached?.reportedError) {
    emitEvent(
      opts.onEvent,
      makeEvent(
        opts,
        path,
        "error",
        cached?.hasValidValue === true ? "retained" : "fallback",
        safeError,
        stat,
      ),
    );
  } else if (safeError === undefined) {
    const hadFailure =
      cached?.error !== undefined ||
      cached?.reportedError !== undefined ||
      cached?.missingReported === true;
    if (hadFailure) {
      emitEvent(opts.onEvent, makeEvent(opts, path, "recovered", "adopted", undefined, stat));
    } else if (cached !== undefined && !versionUnchanged) {
      emitEvent(opts.onEvent, makeEvent(opts, path, "reloaded", "adopted", undefined, stat));
    }
  }

  return { value: nextValue, path, exists: true, error: safeError };
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
    emitEvent(opts.onEvent, makeEvent(opts, path, "missing", "fallback"));
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
    emitEvent(
      opts.onEvent,
      makeEvent(opts, path, "error", retained ? "retained" : "fallback", safeError, stat),
    );
  }
  return { value, path, exists, error: safeError };
}
