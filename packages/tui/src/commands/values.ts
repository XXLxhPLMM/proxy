/** @fileoverview 形参的**值的域**：单位、布尔、配额窗口、名单条目、字段名，以及它们的读法；⚠️ **失败文案一个字节的用户输入都不许进去** */

import type { Reader, UserSetCommand } from "./specs.js";

/** 服务端语义：「配额 `0` 字节」= 不限量，而**缺省也归一成它**（`user add alice` ≡ `user add alice 0`） */
export const UNLIMITED_BYTES = 0;

/** `∞` 的**唯一**写法（与 `@/lib/index.js:UNLIMITED` 同一档意思；本层零 `@/lib`，故这是一份字面量） */
const INFINITY = "∞";

/** 不限量的各种写法（小写后比；空串也在里面 —— 「留空」是最省事的那种写法） */
const UNLIMITED_SPELLINGS: ReadonlySet<string> = new Set([
  "",
  INFINITY,
  "inf",
  "unlimited",
  "none",
]);

/** 单位后缀 → 乘数（1024 进制；带 B 与不带 B 各留一个键，乘数只写一次） */
const UNIT_FACTORS: Readonly<Record<string, number>> = {
  "": 1,
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
};

/** 后缀的**给人看的**清单（错误文案只用这一份） */
const UNIT_NAMES = ["B", "K", "M", "G"] as const;

/** 数值部分 + 可选后缀；⚠️ **指数写法必须落在第 1 个捕获组里**（写成不捕获的组，`1e30g` 会被读成「1 乘 1 GiB」而收下） */
const TRAFFIC_SHAPE = /^((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([a-z]*)$/;

const INTEGER_TEXT = /^\d+$/;

/** 形参值不合法（模块私有）；⚠️ 只在**本包**里 `catch`（别的层看到它就说明这里有 bug） */
export class ValueError extends Error {
  /** 第几个形参（1 起）；`null` = 「由包装层补」（读单个形参的 `read` 不知道自己第几位） */
  public readonly argIndex: number | null;

  public constructor(argIndex: number | null, message: string) {
    super(message);
    this.name = "ValueError";
    this.argIndex = argIndex;
  }
}

/**
 * 流量上限 → **字节数**；判据是**乘完之后必须落在一个非负安全整数上**：`1.5g` 收（精确算，不许先 `Math.floor`）、`0.1k` 拒、`1e30g` 拒（溢出序列化成 JSON 就是 `null`）
 */
export function readTraffic(raw: string): number {
  const text = raw.trim().toLowerCase();
  if (UNLIMITED_SPELLINGS.has(text)) return UNLIMITED_BYTES;
  if (text.startsWith("-")) throw new ValueError(null, "流量上限不能是负数");
  const shape = TRAFFIC_SHAPE.exec(text);
  if (shape === null) {
    throw new ValueError(
      null,
      `流量上限要写成「数字 + 可选单位」（单位 ${UNIT_NAMES.join(" / ")}）；不限量写 inf / unlimited / none / ${INFINITY} 或留空`,
    );
  }
  const factor = UNIT_FACTORS[shape[2] as string];
  if (factor === undefined) {
    throw new ValueError(null, `流量上限的单位只能是 ${UNIT_NAMES.join(" / ")}（大小写随意）`);
  }
  const bytes = Number(shape[1]) * factor;
  if (!Number.isSafeInteger(bytes)) {
    throw new ValueError(
      null,
      "流量上限换算成字节之后不是一个精确的整数（字节数只能是整数，且不许超出安全整数范围）",
    );
  }
  return bytes;
}

/** `disabled` 的两种真相各收三种写法（全小写后比） */
const TRUE_SPELLINGS: ReadonlySet<string> = new Set(["on", "true", "1"]);
const FALSE_SPELLINGS: ReadonlySet<string> = new Set(["off", "false", "0"]);

/** 启用 / 停用 → 布尔（服务端那一侧是 `disabled`，故这里给的是**状态**而不是动作） */
function readBoolean(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (TRUE_SPELLINGS.has(text)) return true;
  if (FALSE_SPELLINGS.has(text)) return false;
  throw new ValueError(null, "值只能是 off / on / false / true / 0 / 1");
}

/**
 * 配额窗口的合法取值；⚠️ 与根仓 `src/manager/routes/patch.ts:WINDOWS` 一样是**手抄**的三档闭合集 —— 对面加一档而这里没跟上时，那是一次**说错了话的拒绝**
 */
export type QuotaWindow = "day" | "month" | "clear";

/** {@link QuotaWindow} 的运行时那一份（**唯一**；错误文案与补全都读它） */
export const QUOTA_WINDOWS: readonly QuotaWindow[] = ["day", "month", "clear"];

/** 配额窗口 → 合法取值（大小写随意；出参永远是表里的规范拼写） */
function readQuotaWindow(raw: string): QuotaWindow {
  const text = raw.trim().toLowerCase();
  const found = QUOTA_WINDOWS.find((one) => one === text);
  if (found === undefined) {
    throw new ValueError(null, `配额窗口只能是 ${QUOTA_WINDOWS.join(" / ")}`);
  }
  return found;
}

/** 名单条目的分隔符（服务端那条字符白名单里**没有**逗号，故逗号不可能是条目的一部分） */
const ENTRY_SEPARATOR = ",";

/** 逗号分隔的名单条目 → 字符串数组（空 = **清空**这份名单）；⚠️ **逐条 trim，而一条空条目是失败**（`a,,b` 里那个空词在服务端会变成一条「什么都不匹配」的条目） */
function readEntryList(raw: string): readonly string[] {
  const text = raw.trim();
  if (text === "") return [];
  const entries = text.split(ENTRY_SEPARATOR).map((one) => one.trim());
  if (entries.some((one) => one === "")) {
    throw new ValueError(null, "名单条目用逗号分隔，且逗号前后都要有内容（写 - 清空这份名单）");
  }
  return entries;
}

/** 毫秒数：只判「是不是一个能当毫秒数的非负安全整数」；区间判据归 `@/services/config` */
export function readTimeout(raw: string): number {
  const text = raw.trim();
  if (!INTEGER_TEXT.test(text)) throw new ValueError(null, "超时必须是非负整数毫秒");
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new ValueError(null, "超时超出安全整数范围");
  return value;
}

/** 凭据类形参（密码 / token）：**逐字**保留，一律不 throw（本层再造一份字符集就是一处会漂的假约束） */
export function readVerbatim(raw: string): string {
  return raw;
}

/** 名字类形参（用户名 / 显示名 / 配置键）：trim 之后**不能**是空的；⚠️ **trim 但不小写化**（配置键是 `AUTH_TYPE` 这种大写） */
export function readText(label: string): Reader<string> {
  return (raw: string): string => {
    const value = raw.trim();
    if (value === "") throw new ValueError(null, `${label} 不能为空`);
    return value;
  };
}

/** `help` 的主题：trim + **小写**（命令表里全是小写 ASCII 命令名） */
export function readTopic(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === "") throw new ValueError(null, "命令名不能为空");
  return value;
}

/** `user set` 的合法字段；⚠️ **逐字用服务端那一份**（服务端对未知字段直接 400），且里面**没有**「用户名」 */
export const USER_FIELDS = [
  "disabled",
  "password",
  "quotaBytes",
  "quotaWindow",
  "expiresAt",
  "targetWhitelist",
  "targetBlacklist",
] as const;

/** {@link USER_FIELDS} 的元素类型（小写规范化后的合法值） */
export type UserField = (typeof USER_FIELDS)[number];

/** 每个字段的**值**类型；⚠️ 值的类型住在字段名旁边，于是「字段 → 值的形状」在类型上只有一个真相源 */
export interface UserValueOf {
  /** `true` = 停用（与服务端那一侧同向） */
  readonly disabled: boolean;
  /** **逐字**：空串就是空密码 */
  readonly password: string;
  /** 字节数（读法带单位后缀，见 {@link readTraffic}）；`0` = 不限量 */
  readonly quotaBytes: number;
  /** 配额窗口（`clear` = 删掉窗口键、回到服务端缺省） */
  readonly quotaWindow: QuotaWindow;
  /** **逐字**：ISO 串或 `clear`，形态由服务端判 */
  readonly expiresAt: string;
  /** 逗号分隔的条目；空列表 = 清空这份个人白名单 */
  readonly targetWhitelist: readonly string[];
  /** 逗号分隔的条目；空列表 = 清空这份个人黑名单 */
  readonly targetBlacklist: readonly string[];
}

type ExactKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** 编译期锁：{@link UserValueOf} 的键与 {@link UserField} 闭合集**逐个相等**（`extends true` 就是那条锁） */
export type UserFieldsAreComplete = ExactKeys<keyof UserValueOf, UserField> extends true
  ? true
  : never;

/** 字段名 → 合法字段；⚠️ 比较时**两边都小写**而返回**表里那个成员**（只小写用户输入的话 `quotabytes` 会被拒） */
export function readField(raw: string): UserField {
  const text = raw.trim().toLowerCase();
  const found = USER_FIELDS.find((field) => field.toLowerCase() === text);
  if (found === undefined) {
    throw new ValueError(null, `字段只能是 ${USER_FIELDS.join(" / ")}`);
  }
  return found;
}

/** `user set` 的值 → **一条命令**（字段与值的类型在同一个分支里收窄） */
/** ⚠️ 对象**在 `switch` 的每一支里**造出来，否则 `field` 与 `value` 在 TS 看来互不相关；末尾那条 `never` 是**锚点** */
export function buildUserSet(username: string, field: UserField, raw: string): UserSetCommand {
  switch (field) {
    case "quotaBytes":
      return { kind: "user-set", username, field, value: readTraffic(raw) };
    case "disabled":
      return { kind: "user-set", username, field, value: readBoolean(raw) };
    case "quotaWindow":
      return { kind: "user-set", username, field, value: readQuotaWindow(raw) };
    case "targetWhitelist":
      return { kind: "user-set", username, field, value: readEntryList(raw) };
    case "targetBlacklist":
      return { kind: "user-set", username, field, value: readEntryList(raw) };
    // ⚠️ 这两个**逐字透传**：`password` 的空串是「把密码设成空串」；`expiresAt` 的时刻形态归服务端判
    case "expiresAt":
      return { kind: "user-set", username, field, value: raw };
    case "password":
      return { kind: "user-set", username, field, value: raw };
    default:
      return unknownUserField(field);
  }
}

/**
 * 「这个字段还没有值的读法」—— **一个应该不可达的分支**；⚠️ 形参 `field: never` **不可省**，它是那条编译期锁的**全部**机制
 */
function unknownUserField(field: never): never {
  throw new ValueError(null, `字段 ${String(field)} 还没有值的读法；合法字段是 ${USER_FIELDS.join(" / ")}`);
}