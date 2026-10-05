/**
 * @fileoverview `envs.json` —— 环境清单的读面与写面
 * @module store/envs
 * @description
 * 一个环境 = **一个名字 + 一组 manager 的 id**。落盘形状：
 *
 * ```json
 * { "environments": [ { "name": "prod", "managers": ["prod", "prod-2"] } ] }
 * ```
 *
 * ## 名字就是主键，也是「激活」用的那个键
 * @description 环境没有单独的 `id` —— 它只被人引用，没有被任何东西引用。给它一个 id 只会造出
 * 「id 与 name 各是一份真相」的分裂。
 *
 * ## ⚠️ 写面**当场验**每个 id 都还在清单里，读面**不验**
 * @description 悬空 id 放行的话，环境会静默少一个成员，而模型看不出「这个成员是被人删了」
 * 还是「这个环境本来就只有这些」。而读面不验是因为那份 JSON 可能被手改过：读面的职责是
 * **如实报出来**（连同它发现的悬空 id 一起报），守门是写面的活。两侧的分工在
 * `@/store/targets.js` 里还有一段推导。
 */

import { McpError } from "../utils/errors.js";
import { assertNoControlChars } from "../utils/text.js";
import { envsPath, readJsonFile, writeJsonFile } from "../utils/json-file.js";
import { readManagers } from "./managers.js";
import { activeEnvName } from "./session.js";

/** 一个环境 */
export interface EnvRecord {
  readonly name: string;
  /** manager 的 **id** 数组（⚠️ 存 id 而不是 name —— name 可改，id 是稳定身份） */
  readonly managers: readonly string[];
}

/** 环境名的长度上限 */
const NAME_MAX = 64;

/** 一个环境里最多几个 manager（⚠️ 工具是给模型用的，而模型一次能读懂的结果有上限） */
export const ENV_MAX_MEMBERS = 64;

export interface EnvInput {
  readonly name: string;
  readonly managers: readonly string[];
}

/** 读整份环境清单（文件不存在 ⇒ 空清单；形状不对 ⇒ 抛） */
export function readEnvs(homedir: string): readonly EnvRecord[] {
  return readJsonFile<readonly EnvRecord[]>(envsPath(homedir), [], parseEnvsFile);
}

/** 按名字找（⚠️ **逐字节比较**，不做大小写折叠 —— 名字是人给的标识，不是协议名） */
export function envByName(envs: readonly EnvRecord[], name: string): EnvRecord | undefined {
  return envs.find((one) => one.name === name);
}

/** 建一个环境；⚠️ **重名即拒** —— 激活靠名字，两个同名会让「我激活的是哪一个」取决于数组顺序 */
export function createEnv(homedir: string, input: EnvInput): EnvRecord {
  const envs = readEnvs(homedir);
  const name = validateName(input.name);
  if (envByName(envs, name) !== undefined) {
    throw McpError.local(`已经有叫 ${name} 的环境了`);
  }
  const record: EnvRecord = { name, managers: validateMembers(homedir, input.managers) };
  writeEnvs(homedir, [...envs, record]);
  return record;
}

/**
 * 改一个环境的成员
 * @description ⚠️ **整体替换**而不是增删 —— 「这个环境该有哪些成员」是一次决定，
 * 局部改会攒出一堆看不出意图的组合，而模型没有办法表达「再加一个」以外的意图。
 */
export function setEnvMembers(
  homedir: string,
  name: string,
  members: readonly string[],
): EnvRecord {
  const envs = readEnvs(homedir);
  const at = envs.findIndex((one) => one.name === name);
  const current = envs[at];
  if (at < 0 || current === undefined) {
    throw McpError.local(`没有叫 ${name} 的环境`);
  }
  const next: EnvRecord = { name, managers: validateMembers(homedir, members) };
  const copy = [...envs];
  copy[at] = next;
  writeEnvs(homedir, copy);
  return next;
}

/**
 * 删一个环境
 * @description ⚠️ **正在激活的那个不许删** —— 删掉而激活还指着那个名字，于是下一个工具调用报
 * 「环境 X 不存在」，而模型刚才是**自己**删的。与其留一个悬空激活，不如当场拒。
 */
export function removeEnv(homedir: string, name: string): EnvRecord {
  const envs = readEnvs(homedir);
  const target = envByName(envs, name);
  if (target === undefined) {
    throw McpError.local(`没有叫 ${name} 的环境`);
  }
  if (activeEnvName() === name) {
    throw McpError.local(`${name} 正在被激活，先 env_deactivate 再删`);
  }
  writeEnvs(
    homedir,
    envs.filter((one) => one.name !== name),
  );
  return target;
}

export function writeEnvs(homedir: string, envs: readonly EnvRecord[]): void {
  writeJsonFile(envsPath(homedir), { environments: envs });
}

/** 文件形状判据（⚠️ 坏内容即拒） */
function parseEnvsFile(value: unknown): readonly EnvRecord[] {
  const file = asRecord(value, "envs.json");
  const list = asArray(file["environments"], "envs.json 的 environments");
  return list.map((one, at) => {
    const env = asRecord(one, `envs.json 的第 ${String(at + 1)} 个环境`);
    const name = env["name"];
    const managers = env["managers"];
    if (typeof name !== "string" || name === "") {
      throw new Error(`第 ${String(at + 1)} 个环境缺 name`);
    }
    if (!Array.isArray(managers)) {
      throw new Error(`第 ${String(at + 1)} 个环境缺 managers 数组`);
    }
    return {
      name,
      managers: managers.map((id) => {
        if (typeof id !== "string") {
          throw new Error("环境里的 managers 必须全是字符串 id");
        }
        return id;
      }),
    };
  });
}

/** 成员表判据：非空数组、有上限、无重复、每个 id 都在 `managers.json` 里 */
function validateMembers(homedir: string, members: readonly string[]): readonly string[] {
  if (members.length === 0) {
    throw McpError.local("环境的 managers 至少要有一个（空环境让「激活它」等于什么也不做）");
  }
  if (members.length > ENV_MAX_MEMBERS) {
    throw McpError.local(`一个环境最多 ${String(ENV_MAX_MEMBERS)} 个 manager`);
  }
  const seen = new Set<string>();
  for (const id of members) {
    if (typeof id !== "string" || id.trim() === "") {
      throw McpError.local("managers 里必须全是 manager 的 id");
    }
    if (seen.has(id)) {
      throw McpError.local(`managers 里 ${id} 出现了两次`);
    }
    seen.add(id);
  }
  const known = new Set(readManagers(homedir).map((one) => one.id));
  const missing = members.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw McpError.local(`这些 id 不在 managers.json 里：${missing.join("、")}（先 manager_add）`);
  }
  return [...members];
}

function validateName(raw: string): string {
  const name = raw.trim();
  if (name === "") {
    throw McpError.local("环境名不能为空");
  }
  if (name.length > NAME_MAX) {
    throw McpError.local(`环境名超过 ${String(NAME_MAX)} 个字符`);
  }
  assertNoControlChars(name, "环境名");
  return name;
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
