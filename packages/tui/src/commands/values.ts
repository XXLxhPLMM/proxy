/** @fileoverview 形参的**值的域**：流量单位、控制面名单、以及各类文本怎么读；⚠️ **失败文案一个字节的用户输入都不许进去** */

import type { Reader } from "./specs.js";

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

/** 逐字保留的那一格（`/batch` 第二格由解析层直接交原文，而这一格是它声明的读法）：一律不 throw —— 本层再造一份字符集就是一处会漂的假约束 */
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

/** `/batch` 的第一格：**一个**控制面名、`all`（全部）或逗号分隔的若干个；⚠️ 一个空词即失败（`a,,b` 少打一个名字） */
export function readTargets(raw: string): string {
  const text = raw.trim();
  if (text === "") throw new ValueError(null, "控制面不能为空（all = 台账里的全部）");
  if (text.toLowerCase() === ALL_TARGETS) return ALL_TARGETS;
  const names = text.split(TARGET_SEPARATOR).map((one) => one.trim());
  if (names.some((one) => one === "")) {
    throw new ValueError(null, `控制面用逗号分隔，且逗号前后都要有内容（${ALL_TARGETS} = 台账里的全部）`);
  }
  return names.join(TARGET_SEPARATOR);
}

/** `/batch` 的「全部」那一档（⚠️ **小写判**：用户敲 `ALL` 与 `all` 是同一件事） */
export const ALL_TARGETS = "all";

/** `/batch` 的名字分隔符（**就是逗号**：它那一格装的是「一串短名字」，而服务端那条字符白名单里没有逗号） */
const TARGET_SEPARATOR = ",";

/** `help` 的主题：trim + **小写**（命令表里全是小写 ASCII 命令名） */
export function readTopic(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === "") throw new ValueError(null, "命令名不能为空");
  return value;
}

