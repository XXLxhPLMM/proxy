/**
 * JSON 配置文件读取器 - mtime 节流热加载 + 坏内容不接管
 * 职责：
 * - 读取 JSON 配置文件并校验，缓存结果；文件变更（mtime/size）时自动重载
 * - 节流：每文件最多 maxAgeMs 一次 stat，多会话并发调用共享同一份缓存，不各读一次文件
 * - 失败语义：文件缺失 = 使用 fallback（空配置，不报错）；存在但内容非法 = 保留上一份有效值 + 返回 error；
 *   stat 状态不可观测（EACCES/EPERM/ELOOP/ENAMETOOLONG 等）同样返回 error 并保留上一份状态，绝不伪装成 missing；
 *   已加载过的文件「存在 → 缺失」= 回退空配置（ACL 静默全放行的可见性由 missing 事件兜底）
 * - 状态迁移以事件抛出（onEvent）：error / missing / recovered / reloaded；本模块不依赖 logger，
 *   是否记日志、记什么等级由订阅方（config 层）决定
 * 设计：
 * - 绝不抛：调用点分布在每连接（ACL）与每请求（鉴权）路径上，任何异常都不得外溢（订阅回调抛错同样吞掉）
 * - 读取同步（节流后频率极低），无异步竞态；缓存条目只被当前线程访问，天然并发安全
 * - 事件按「变化才触发」去重，避免坏文件期间每个连接都收到重复通知
 */

import fs from "node:fs";
import path from "node:path";

/** 默认节流窗口：同一文件 1s 内不重复 stat */
const DEFAULT_MAX_AGE_MS = 1000;
/** 默认文件大小上限：1MiB，防病态大文件拖住事件循环 */
const DEFAULT_MAX_BYTES = 1024 * 1024;
/** 缓存条目上限：超出后按插入顺序淘汰最旧路径（测试会切多个临时目录） */
const MAX_CACHED_FILES = 16;

/** 状态迁移事件类型：读失败 / 文件消失 / 恢复 / 热加载 */
export type JsonFileEventType = "error" | "missing" | "recovered" | "reloaded";

/**
 * 状态迁移事件（仅在变化时触发一次；节流命中与首次成功加载不触发）
 * @param type - 迁移类型，见 JsonFileEventType
 * @param label - 配置名（原样回传 opts.label，供订阅方呈现）
 * @param path - 文件路径
 * @param error - type === "error" 时的失败原因
 * @param mtimeMs - 触发事件的这份内容的 mtime（毫秒）；missing 事件无值（文件不存在）
 * @param size - 触发事件的这份内容的字节数；missing 事件无值
 */
export interface JsonFileEvent {
  type: JsonFileEventType;
  label: string;
  path: string;
  error?: string;
  mtimeMs?: number;
  size?: number;
}

/**
 * 读取选项
 * @param label - 配置名（事件回传用，如 `acl.json`）
 * @param fallback - 文件缺失时使用的空配置值（必须与 T 同型，且视为只读）
 * @param maxAgeMs - stat 节流窗口，默认 1000
 * @param maxBytes - 文件大小上限，默认 1MiB
 * @param force - 跳过节流强制重读（启动期校验用）
 * @param onEvent - 状态迁移事件回调；只在变化时调用。回调抛错被吞掉，绝不影响读取
 */
export interface JsonFileOptions<T> {
  label: string;
  fallback: T;
  maxAgeMs?: number;
  maxBytes?: number;
  force?: boolean;
  onEvent?: (event: JsonFileEvent) => void;
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
  /** stat 本身失败（而非文件缺失/非普通文件）；恢复时必须重新尝试读取。 */
  statError?: boolean;
}

/** `${配置类别}\0${文件路径}` → 缓存条目；同一路径供不同 validator 使用时互不串型。 */
const caches = new Map<string, CacheEntry>();

interface SubscriberState {
  reportedError?: string;
  missingReported: boolean;
  lastExists?: boolean;
}

/** 每个 onEvent 回调独立去重；共享缓存不再吞掉其它 runtime 的观察事件。 */
const subscriberStates = new WeakMap<
  (event: JsonFileEvent) => void,
  Map<string, SubscriberState>
>();

function cacheKey(path: string, label: string): string {
  return `${label}\0${path}`;
}

function subscriberState(
  onEvent: ((event: JsonFileEvent) => void) | undefined,
  key: string,
): SubscriberState | undefined {
  if (!onEvent) {
    return undefined;
  }
  let states = subscriberStates.get(onEvent);
  if (!states) {
    states = new Map<string, SubscriberState>();
    subscriberStates.set(onEvent, states);
  }
  let state = states.get(key);
  if (!state) {
    state = { missingReported: false };
    states.set(key, state);
  }
  return state;
}

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
 * 抛出状态迁移事件；订阅方回调抛错不得影响读取（绝不外抛契约）
 * @param onEvent - 订阅回调（可选）
 * @param event - 事件
 */
function emitEvent(
  onEvent: ((event: JsonFileEvent) => void) | undefined,
  event: JsonFileEvent,
): void {
  if (onEvent === undefined) {
    return;
  }
  try {
    onEvent(event);
  } catch {
    // 订阅方故障与本模块无关：吞掉，保证读取路径绝不外抛
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingStatError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
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
  // 入口立即固定绝对路径：缓存键、stat/read、事件和返回值不能因调用方后续
  // 改变 cwd 而指向不同对象。
  const absolutePath = path.resolve(inputPath);
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = Date.now();
  const key = cacheKey(absolutePath, opts.label);
  const cached = caches.get(key) as CacheEntry | undefined;
  const state = subscriberState(opts.onEvent, key);

  if (!opts.force && cached && now - cached.checkedAt < maxAge) {
    if (state) {
      if (!cached.exists && state.lastExists === true && !state.missingReported) {
        emitEvent(opts.onEvent, {
          type: "missing",
          label: opts.label,
          path: absolutePath,
        });
        state.missingReported = true;
      } else if (cached.error && state.reportedError !== cached.error) {
        const version = { mtimeMs: cached.mtimeMs, size: cached.size };
        emitEvent(opts.onEvent, {
          type: "error",
          label: opts.label,
          path: absolutePath,
          error: cached.error,
          ...version,
        });
        state.reportedError = cached.error;
      }
      state.lastExists = cached.exists;
    }
    return {
      value: cached.value as T,
      path: absolutePath,
      exists: cached.exists,
      error: cached.error,
    };
  }

  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(absolutePath);
  } catch (error) {
    if (!isMissingStatError(error)) {
      // EACCES/EPERM/ELOOP/ENAMETOOLONG 等不是“文件不存在”：保留已有观察结果，
      // 首次失败才使用 fallback，并让订阅者看到明确的 error 而非 missing。
      const message = `读取状态失败: ${errorMessage(error)}`;
      const entry: CacheEntry = {
        value: cached?.value ?? opts.fallback,
        error: message,
        checkedAt: now,
        mtimeMs: cached?.mtimeMs ?? 0,
        size: cached?.size ?? 0,
        exists: cached?.exists ?? false,
        statError: true,
      };
      const version =
        cached?.exists === true ? { mtimeMs: entry.mtimeMs, size: entry.size } : undefined;
      if (state && state.reportedError !== message) {
        emitEvent(opts.onEvent, {
          type: "error",
          label: opts.label,
          path: absolutePath,
          error: message,
          ...(version ?? {}),
        });
        state.reportedError = message;
      }
      if (state) {
        state.lastExists = entry.exists;
      }
      putCache(key, entry);
      return {
        value: entry.value as T,
        path: absolutePath,
        exists: entry.exists,
        error: message,
      };
    }
    stat = undefined;
  }

  // 文件缺失 / 不是普通文件：视为空配置（回退 fallback），不算错误。
  // 但「上一份缓存存在 → 本轮缺失」意味着配置刚刚消失（ACL 会静默变全放行），抛一条 missing 事件，恢复时给 recovered
  if (!stat || !stat.isFile()) {
    const wasPresent = cached?.exists === true;
    const entry: CacheEntry = {
      value: opts.fallback,
      checkedAt: now,
      mtimeMs: 0,
      size: 0,
      exists: false,
    };
    const shouldNotifyMissing = Boolean(
      state && (wasPresent || state.lastExists === true) && !state.missingReported,
    );
    if (shouldNotifyMissing) {
      emitEvent(opts.onEvent, { type: "missing", label: opts.label, path: absolutePath });
    }
    if (state) {
      if (shouldNotifyMissing) {
        state.missingReported = true;
      }
      state.lastExists = false;
    }
    putCache(key, entry);
    return { value: opts.fallback, path: absolutePath, exists: false };
  }

  // 未变更：只刷新节流时间戳，复用缓存值（含上一份内容错误状态）。stat 错误
  // 必须继续尝试，否则权限恢复后同版本文件永远无法触发 recovered。
  if (
    cached &&
    cached.exists &&
    !cached.statError &&
    stat.mtimeMs === cached.mtimeMs &&
    stat.size === cached.size
  ) {
    cached.checkedAt = now;
    if (cached.error && state && state.reportedError !== cached.error) {
      const version = { mtimeMs: cached.mtimeMs, size: cached.size };
      emitEvent(opts.onEvent, {
        type: "error",
        label: opts.label,
        path: absolutePath,
        error: cached.error,
        ...version,
      });
      state.reportedError = cached.error;
    } else if (!cached.error && state && (state.reportedError || state.missingReported)) {
      const version = { mtimeMs: cached.mtimeMs, size: cached.size };
      emitEvent(opts.onEvent, {
        type: "recovered",
        label: opts.label,
        path: absolutePath,
        ...version,
      });
      state.reportedError = undefined;
      state.missingReported = false;
    }
    if (state) {
      state.lastExists = true;
    }
    return { value: cached.value as T, path: absolutePath, exists: true, error: cached.error };
  }

  let value = cached?.value ?? opts.fallback;
  let error: string | undefined;

  try {
    if (stat.size > maxBytes) {
      throw new Error(`文件超过 ${maxBytes} 字节上限`);
    }
    const raw = fs.readFileSync(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const valid = validate(parsed);
    if (valid === undefined) {
      throw new Error("格式非法（字段缺失、类型不符或存在未知键）");
    }
    value = valid;
  } catch (readError) {
    error = readError instanceof Error ? readError.message : String(readError);
  }

  const entry: CacheEntry = {
    value,
    error,
    checkedAt: now,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    exists: true,
  };

  // 事件按「变化才触发」去重：坏文件持续期间不重复抛，恢复时给一条 recovered
  // 内容变更且校验通过 → 一条 reloaded；首次读取（cached 不存在）静默，由启动摘要覆盖
  // mtime/size 是「这份内容」的版本标识，随事件回传供日志区分版本（missing 无文件可 stat，不带）
  const version = { mtimeMs: stat.mtimeMs, size: stat.size };
  if (state && error) {
    if (error !== state.reportedError) {
      emitEvent(opts.onEvent, {
        type: "error",
        label: opts.label,
        path: absolutePath,
        error,
        ...version,
      });
      state.reportedError = error;
    }
    state.missingReported = false;
  } else if (state && !error && (state.reportedError || state.missingReported)) {
    emitEvent(opts.onEvent, {
      type: "recovered",
      label: opts.label,
      path: absolutePath,
      ...version,
    });
    state.reportedError = undefined;
    state.missingReported = false;
  } else if (cached !== undefined) {
    emitEvent(opts.onEvent, {
      type: "reloaded",
      label: opts.label,
      path: absolutePath,
      ...version,
    });
  }
  if (state) {
    state.lastExists = true;
  }

  putCache(key, entry);
  return { value: value as T, path: absolutePath, exists: true, error };
}
