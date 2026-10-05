/**
 * @fileoverview `managers.json` —— 控制面清单的读面与写面
 * @module store/managers
 * @description
 * 一条 manager = **一个 id + 一个名字 + 一个地址 + 一个操作 key**。落盘形状：
 *
 * ```json
 * { "managers": [ { "id": "prod", "name": "生产", "baseUrl": "http://10.0.0.1:8080",
 *                   "key": "…", "timeoutMs": 30000 } ] }
 * ```
 *
 * ## `key` 明文落盘是结论不是疏忽
 * 没有可加密它的密钥，OS keychain 要原生依赖；防线是**目录 `0700` + 文件 `0600` + 位置约定
 * + 绝不进日志/错误文案/清单视图**。⚠️ 那条防线的最后一环在本模块：`{@link redactManager}`
 * 是 key 离开本层的**唯一**出口，而它永远给掩码。
 */

import { McpError } from "../utils/errors.js";
import { hasControlChars } from "../utils/text.js";
import {
  DEFAULT_TIMEOUT_MS,
  normalizeBaseUrl,
} from "../utils/request.js";
import { managersPath, readJsonFile, writeJsonFile } from "../utils/json-file.js";
import { readEnvs, type EnvRecord } from "./envs.js";

/** 一条 manager（**`key` 就是凭据**，故本类型不许进日志 / 不许进错误文案） */
export interface ManagerRecord {
  /** 稳定身份，slug 形态；⚠️ 建了之后**永不改变**，而 `name` 是可以改的显示名 */
  readonly id: string;
  readonly name: string;
  /** 基址，恒是 {@link normalizeBaseUrl} 的产物（无尾斜杠） */
  readonly baseUrl: string;
  /** `MANAGER_TOKEN`；⚠️ 等价于主机上的 root shell */
  readonly key: string;
  readonly timeoutMs: number;
}

/** 清单文件形状 */
interface ManagersFile {
  readonly managers: readonly ManagerRecord[];
}

/** `manager_list` 给模型看的那一份（⚠️ `key` 在这里是掩码，不是真值） */
export interface ManagerView {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly key: string;
}

/** key 的掩码（**唯一**那处；空串保持空串 —— 「没配 key」与「配了但不给你看」是两件事） */
export const REDACTED_KEY = "***";

/** `id` 的字符集：slug 形态（⚠️ 刻意极窄 —— 它会被拼进路径与 JSON 键，而它不是给人手输的） */
const ID_SHAPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 显示名的长度上限（⚠️ 它会整行进模型的上下文） */
const NAME_MAX = 64;

/** 超时的取值范围（下界防「一次请求立刻超时」，上界防「工具卡住十分钟」） */
export const TIMEOUT_BOUNDS = { min: 1_000, max: 300_000 } as const;

export interface ManagerInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly key: string;
  readonly timeoutMs?: number;
}

/** 读整份清单（文件**不存在** ⇒ 空清单；**存在而形状不对** ⇒ 抛） */
export function readManagers(homedir: string): readonly ManagerRecord[] {
  return readJsonFile<readonly ManagerRecord[]>(managersPath(homedir), [], parseManagersFile);
}

/** key 的掩码视图 —— **key 离开本层的唯一出口** */
export function redactManager(record: ManagerRecord): ManagerView {
  return {
    id: record.id,
    name: record.name,
    baseUrl: record.baseUrl,
    timeoutMs: record.timeoutMs,
    key: record.key === "" ? "" : REDACTED_KEY,
  };
}

/** 按 `id` 找；⚠️ 找不到就是 `undefined`，**不静默返回第一条** */
export function managerById(
  managers: readonly ManagerRecord[],
  id: string,
): ManagerRecord | undefined {
  return managers.find((one) => one.id === id);
}

/**
 * 按 `id` 或 `name` 找
 * @description ⚠️ **`id` 优先**：`id` 与别的 manager 的 `name` 撞上时，`id` 那一票说了算。
 * 那是「精确指定」与「显示名」两种意图的分界 —— 显示名允许重复，`id` 不允许。
 */
export function managerByRef(
  managers: readonly ManagerRecord[],
  ref: string,
): ManagerRecord | undefined {
  return managerById(managers, ref) ?? managers.find((one) => one.name === ref);
}

/** 加一条；⚠️ `name` 可以重复，`id` 由 `nextId` 避让产生 */
export function addManager(homedir: string, input: ManagerInput): ManagerRecord {
  const managers = readManagers(homedir);
  const record: ManagerRecord = {
    id: nextId(slugify(input.name), managers),
    name: validateName(input.name),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    key: validateKey(input.key),
    timeoutMs: validateTimeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  writeManagers(homedir, [...managers, record]);
  return record;
}

export interface ManagerPatch {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly key?: string;
  readonly timeoutMs?: number;
}

/** 改一条（⚠️ `id` **不可改** —— 它是稳定身份，而所有环境清单引的就是它） */
export function updateManager(
  homedir: string,
  id: string,
  patch: ManagerPatch,
): ManagerRecord {
  const managers = readManagers(homedir);
  const at = managers.findIndex((one) => one.id === id);
  const current = managers[at];
  if (at < 0 || current === undefined) {
    throw McpError.local(`没有 id 为 ${id} 的 manager`);
  }
  if (Object.keys(patch).length === 0) {
    throw McpError.local("至少要给一个要改的字段");
  }
  const next: ManagerRecord = {
    id: current.id,
    name: patch.name === undefined ? current.name : validateName(patch.name),
    baseUrl:
      patch.baseUrl === undefined ? current.baseUrl : normalizeBaseUrl(patch.baseUrl),
    key: patch.key === undefined ? current.key : validateKey(patch.key),
    timeoutMs:
      patch.timeoutMs === undefined ? current.timeoutMs : validateTimeout(patch.timeoutMs),
  };
  const copy = [...managers];
  copy[at] = next;
  writeManagers(homedir, copy);
  return next;
}

/**
 * 删一条
 * @description ⚠️ **被任何环境引用时抛** —— 删掉会让那个环境指向一条不存在的 manager，
 * 而本仓零兼容、清单不做级联清理 ⇒ 那份环境会静默变成「少一个成员」，而模型看不出
 * 「这个成员是被人删了」还是「这个环境本来就只有这些」。
 */
export function removeManager(homedir: string, id: string): ManagerRecord {
  const managers = readManagers(homedir);
  const target = managerById(managers, id);
  if (target === undefined) {
    throw McpError.local(`没有 id 为 ${id} 的 manager`);
  }
  const holders = readEnvsForReference(homedir).filter((env) => env.managers.includes(id));
  if (holders.length > 0) {
    const names = holders.map((env) => env.name).join("、");
    throw McpError.local(
      `manager ${id} 还被环境 ${names} 引用着，先把这些环境里的它去掉（env_update）再删`,
    );
  }
  writeManagers(
    homedir,
    managers.filter((one) => one.id !== id),
  );
  return target;
}

/** 落盘整份清单（顺序 = 数组序） */
export function writeManagers(homedir: string, managers: readonly ManagerRecord[]): void {
  writeJsonFile(managersPath(homedir), { managers } satisfies ManagersFile);
}

/** `id` 的 slug 化（⚠️ 中文名落不到 ASCII slug 时退化成 `m`，故它只是「尽力」而非「可逆」） */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "m" : slug;
}

/** slug 递增避让（`prod` → `prod-2` → …）：⚠️ 靠 `while` 逐个避让，而不是随机后缀 —— 同样输入给同样 id */
export function nextId(slug: string, existing: readonly ManagerRecord[]): string {
  const taken = new Set(existing.map((one) => one.id));
  if (!taken.has(slug)) {
    return slug;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${slug}-${String(n)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * `envs.json` 里**全部**环境的 id 引用
 * @description ⚠️ 走 `readEnvs` 这**一个**环境解析口，而不是在本文件里再抄一份 —— 我第一版正是
 * 这么写的，于是它认的是 `{environments: [...]}` 而写面写的是 `{envs: [...]}`，症状是
 * 「删一个被环境引用的 manager」报「envs.json 的内容形状不对」而完全不提引用关系。
 * 重复一份形状判据就多一处会漂，而两处漂了之后**互相对不上**。
 */
function readEnvsForReference(homedir: string): readonly EnvRecord[] {
  return readEnvs(homedir);
}

/** 文件形状判据（⚠️ 坏内容即拒，绝不降级成空清单 —— 降级会让「重新加一遍」覆盖掉存着 key 的那份） */
function parseManagersFile(value: unknown): readonly ManagerRecord[] {
  const file = asRecord(value, "managers.json");
  const list = asArray(file["managers"], "managers.json 的 managers");
  return list.map((one, at) => {
    const record = asRecord(one, `managers.json 的第 ${String(at + 1)} 条`);
    const id = record["id"];
    const name = record["name"];
    const baseUrl = record["baseUrl"];
    const key = record["key"];
    const timeoutMs = record["timeoutMs"];
    if (typeof id !== "string" || !ID_SHAPE.test(id)) {
      throw new Error(`第 ${String(at + 1)} 条的 id 不合法`);
    }
    if (typeof name !== "string" || name === "") {
      throw new Error(`第 ${String(at + 1)} 条的 name 不合法`);
    }
    if (typeof baseUrl !== "string" || baseUrl === "") {
      throw new Error(`第 ${String(at + 1)} 条的 baseUrl 不合法`);
    }
    if (typeof key !== "string") {
      throw new Error(`第 ${String(at + 1)} 条的 key 不是字符串`);
    }
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
      throw new Error(`第 ${String(at + 1)} 条的 timeoutMs 不合法`);
    }
    return { id, name, baseUrl, key, timeoutMs };
  });
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} 不是一个对象`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${what} 不是一个数组`);
  }
  return value;
}

function validateName(raw: string): string {
  const name = raw.trim();
  if (name === "") {
    throw McpError.local("名称不能为空");
  }
  if (name.length > NAME_MAX) {
    throw McpError.local(`名称超过 ${String(NAME_MAX)} 个字符`);
  }
  if (hasControlChars(name)) {
    throw McpError.local("名称里有控制字符");
  }
  return name;
}

/** ⚠️ 判据只有「非空」与「端部空白 trim」：对面比的是 SHA-256 摘要，本层描述它的字符集只会是谎报 */
function validateKey(raw: string): string {
  const key = raw.trim();
  if (key === "") {
    throw McpError.local("操作 key 不能为空（它是控制面的 Bearer 凭据）");
  }
  return key;
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < TIMEOUT_BOUNDS.min || value > TIMEOUT_BOUNDS.max) {
    throw McpError.local(
      `超时必须是 ${String(TIMEOUT_BOUNDS.min)}–${String(TIMEOUT_BOUNDS.max)} 之间的整数毫秒`,
    );
  }
  return value;
}
