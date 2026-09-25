/**
 * 用户账号文件：同步热加载 API + 启动期无日志异步校验 API。
 *
 * 同步读取继续复用 utils/json-file 的节流缓存与事件呈现；异步读取只用于配置加载器
 * 在提交 store 前做一次直接、不可缓存的 fail-closed 校验。
 */

import fs from "node:fs";
import type { ConfigAccessor } from "../context.js";
import { readJsonCached, type JsonFileEvent, type JsonFileRead } from "@/utils/json-file/index.js";

/** 账号表形状；与 core 使用的账号结构保持结构兼容。 */
export interface AuthAccount {
  username: string;
  password: string;
}

/** 空账号表（只读哨兵，文件缺失或启动期校验失败时使用）。 */
const EMPTY_ACCOUNTS: AuthAccount[] = [];

/** users.json 允许的字段名。 */
const ACCOUNT_KEYS = new Set(["username", "password"]);

/** 启动期直接读取的大小上限：1MiB。 */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * 校验账号文件内容。
 *
 * @param raw - JSON.parse 结果
 * @returns 合法时返回账号数组（顺序保留），非法返回 undefined
 */
export function validateAuthUsers(raw: unknown): AuthAccount[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const seen = new Set<string>();
  const out: AuthAccount[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }
    if (Object.keys(item).some((k) => !ACCOUNT_KEYS.has(k))) {
      return undefined;
    }
    const { username, password } = item as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || !username || username.includes(":")) {
      return undefined;
    }
    if (typeof password !== "string") {
      return undefined;
    }
    if (seen.has(username)) {
      return undefined;
    }
    seen.add(username);
    out.push({ username, password });
  }

  return out;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 启动期直接读取并校验账号文件。
 *
 * - 缺失文件返回空账号表且不算错误。
 * - 超过 1MiB、JSON 解析失败、schema 校验失败或其它读取错误都返回 `error`，绝不向
 *   调用方抛出，也绝不触发热加载事件/全局 logger。
 */
export async function readAuthUsersAsync(filePath: string): Promise<JsonFileRead<AuthAccount[]>> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return {
        value: EMPTY_ACCOUNTS,
        path: filePath,
        exists: true,
        error: `文件超过 ${MAX_FILE_BYTES} 字节上限`,
      };
    }

    const raw = JSON.parse(content) as unknown;
    const value = validateAuthUsers(raw);
    if (value === undefined) {
      return {
        value: EMPTY_ACCOUNTS,
        path: filePath,
        exists: true,
        error: "格式非法（字段缺失、类型不符或存在未知键）",
      };
    }
    return { value, path: filePath, exists: true };
  } catch (error) {
    if (isMissingFile(error)) {
      return { value: EMPTY_ACCOUNTS, path: filePath, exists: false };
    }
    return {
      value: EMPTY_ACCOUNTS,
      path: filePath,
      exists: false,
      error: errorMessage(error),
    };
  }
}

/** 同步读取账号文件的选项。 */
export interface ReadAuthUsersOptions {
  force?: boolean;
  path?: string;
  /** 必填：决定未显式给 path 时读取哪份配置。 */
  config: ConfigAccessor;
  /** 当前服务显式提供的文件状态观察面；缺省不产生日志副作用。 */
  onEvent?: (event: JsonFileEvent) => void;
}

/**
 * 读取账号文件（带节流缓存）。
 *
 * @param opts - 读取选项；`config` 必须显式传入
 * @returns 读取结果：value 为生效账号表，error 为最近一次失败原因
 */
export function readAuthUsers(opts: ReadAuthUsersOptions): JsonFileRead<AuthAccount[]> {
  if (!opts.config) {
    throw new Error("readAuthUsers 必须显式传入 config");
  }
  const filePath = opts.path ?? opts.config.get("authUsersFile");
  return readJsonCached(filePath, validateAuthUsers, {
    label: "用户账号文件",
    fallback: EMPTY_ACCOUNTS,
    force: opts.force,
    maxBytes: MAX_FILE_BYTES,
    onEvent: opts.onEvent,
  });
}

/**
 * 取当前生效账号表。
 *
 * @param config - 必填配置访问器
 */
export function loadAuthUsers(
  config: ConfigAccessor,
  onEvent?: (event: JsonFileEvent) => void,
): AuthAccount[] {
  return readAuthUsers({ config, onEvent }).value;
}
