/**
 * @fileoverview 台账的**形状判据**：磁盘形态与用户输入面各一份，加上本层唯一的失败类型
 * @module ledger/validate
 * @description
 * 两份判据，分工明确：
 * - {@link validateLedger} — **磁盘面**：`unknown` → `Ledger`。逐字段判形状，遇到第一个问题就抛。
 * - {@link validateTargetInput} — **用户输入面**：`{name, baseUrl, token, timeoutMs}` → 归一后的同一形状。
 *
 * ## 读面「坏内容即拒」，且**绝不**降级成空台账
 * @description
 * 与 `src/ops` 那条纪律同源但方向相反：数据源层的读语义是「坏内容 → 空表 + 一个 `error`」，
 * 那对**只读**的代理是对的（判据永不因手滑失效）；对一个**要把数据写回去**的工具则是错的 ——
 * 在「我读到的其实是空台账」这个前提上任何一次写，结果都是**把整份真配置清空**。而这份文件里存着
 * 控制面管理员凭据：清空它意味着用户必须重新挨个端点重敲 token，多半还会敲错。
 * 故 {@link ./store.ts:readLedger} 把「读不出来 / 形状不对」一律升级成硬失败（`LedgerError`）。
 *
 * ## ⚠️ `selected` 指向不存在的 id 是**报错**，不是「静默置 null」
 * @description
 * 静默置 null 是这里最像「体贴」实则最危险的一种处理：它把「我上次选的那个端点不见了」显示成
 * 「你还没选过端点」，用户于是从头走一遍向导，而向导会把 `selected` 指向一个**新建的**端点 ——
 * 于是「上次那个」被永久顶掉，且没有任何一处说过发生了什么。形状不自洽就是形状不自洽。
 *
 * ## 为什么这里有 {@link LedgerError} 而不是 `@/api` 的 `TuiError`
 * @description
 * `TuiError` 的三档（wire / transport / shape）是**传输层**的失败词汇：服务答了 / 根本没答上 /
 * 答了但形状不对。一份本机文件「形状不对」与「连不上那个控制面」是**两件事**，而它们的处置动作完全
 * 不同 —— 前者要去修文件，后者要去查网络。用同一类错误表达它们，界面上会出现「连不上」而用户去查
 * 一台根本没问题的机器。故 `LedgerError` 只两档（见 {@link LedgerErrorCode}），文案随便改、`code`
 * 不许增殖。
 *
 * ## 为什么 `LedgerError` 住在这里而没有单列一个 `error.ts`
 * @description
 * `src/ops` 单列 `error.ts` 的理由是「本层每一个模块都抛它，而它与判据无关」。本层的 `LedgerError`
 * 恰好相反：**它的每一个抛出点都是一次形状判定**，它的两档 `code` 说的就是「哪种形状不对」。把它拆到
 * 兄弟文件里，得到的是「抛错的地方与定义这个错的地方不在同一屏」，而这个目录只有七个文件 ——
 * 那种可读性损失换不来任何东西。
 *
 * 本模块零 console、零 `process.*`。
 *
 * @module
 */

import { TuiError, normalizeBaseUrl } from "@/api/index.js";
import {
  NAME_MAX_LEN,
  TIMEOUT_BOUNDS,
  type Ledger,
  type Target,
  type TargetInput,
} from "./types.js";

/**
 * 本层的失败分档
 * @description
 * - `unreadable` — 读出来的**磁盘形态**不对（文件不是 JSON / 字段缺 / `selected` 指向不存在的 id）。
 *   处置：修那份文件。
 * - `invalid-target` — **一个端点本身**不合法（名字空、token 空、超时越界、操作指向不存在的 id）。
 *   处置：改那一条输入。
 *
 * ⚠️ 刻意**不**收「连不上」：那是 `TuiError` 的地界，两者的排查方向不同（见文件头）。
 */
export type LedgerErrorCode = "unreadable" | "invalid-target";

/** 本层唯一的失败类型 */
export class LedgerError extends Error {
  public readonly code: LedgerErrorCode;

  public constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

/** `id` 的字符集：台账内的引用键，绝不许含路径分隔符或空白 */
const ID_SHAPE = /^[a-z0-9-]+$/;

/** 抛一个 `LedgerError`，并让控制流分析把该处收窄成 `never`（于是判据能写成一句「判不过就抛」） */
function reject(code: LedgerErrorCode, message: string): never {
  throw new LedgerError(code, message);
}

/**
 * 这个字符串里有没有控制字符（含 DEL）
 * @description
 * 按码点判而不是靠一张正则：控制字符在源码里是**不可见字节**，写成正则字面量就得把它们（或它们的转义）
 * 放进源文件，而那既在 diff 里不可读，也让「这一行到底写了什么」需要外部工具才答得上来。
 *
 * 挡的是显示名：终端里一个换行符会把一行顶掉、全角字符会让列对不齐，而在 JSON 里它只能以转义
 * 形态存在 —— 于是手写台账的人看见的是 `A` + 转义换行 + `B`，界面上却是两行，两者对不上。
 */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 把一个值描述成一句可读的事实（**只描述形状，绝不引用 `token` 的内容**） */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return `${typeof value}（${String(value)}）`;
}

/** 取一个 JSON 对象的字段面；不是对象（含数组与 null）即判失败 */
function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("unreadable", `${where} 必须是 JSON 对象，实际是 ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

/** 归一后的基址；形状不对时换成 {@link LedgerError}（读面**只**抛 `LedgerError`，理由见文件头） */
function normalizeStoredBaseUrl(raw: unknown, where: string): string {
  if (typeof raw !== "string") {
    reject("unreadable", `${where}.baseUrl 必须是字符串，实际是 ${describe(raw)}`);
  }
  try {
    return normalizeBaseUrl(raw);
  } catch (err) {
    // ⚠️ 转述 `TuiError` 的**判据**而不转述它的档位：文案已经足够具体，而把它原样抛出去会让读面
    // 冒出一种「连不上」的失败类（见文件头「为什么不用 TuiError」）
    const why = err instanceof TuiError ? err.message : String(err);
    reject("unreadable", `${where}.baseUrl 不是可用的控制面地址：${why}`);
  }
}

/** 显示名：非空、trim 后不超长、不含控制字符；返回**trim 后**的形态 */
function normalizedName(raw: unknown, code: LedgerErrorCode, where: string): string {
  if (typeof raw !== "string") {
    reject(code, `${where} 必须是字符串，实际是 ${describe(raw)}`);
  }
  const trimmed = raw.trim();
  if (trimmed === "") reject(code, `${where} 不能为空`);
  if (hasControlChars(trimmed)) reject(code, `${where} 不能含控制字符（会打乱终端排版）`);
  if ([...trimmed].length > NAME_MAX_LEN) reject(code, `${where} 超过 ${NAME_MAX_LEN} 个字符`);
  return trimmed;
}

/** 超时：必须是区间内的整数 */
function normalizedTimeout(raw: unknown, code: LedgerErrorCode, where: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    reject(code, `${where} 必须是整数毫秒，实际是 ${describe(raw)}`);
  }
  if (raw < TIMEOUT_BOUNDS.min || raw > TIMEOUT_BOUNDS.max) {
    reject(
      code,
      `${where} 必须在 ${TIMEOUT_BOUNDS.min}–${TIMEOUT_BOUNDS.max} 毫秒之间，实际是 ${raw}`,
    );
  }
  return raw;
}

/** 磁盘上的一个 target（`id` 的唯一性由 {@link validateLedger} 判） */
function validateStoredTarget(raw: unknown, where: string): Target {
  const obj = asObject(raw, where);
  const id = obj["id"];
  if (typeof id !== "string" || !ID_SHAPE.test(id)) {
    reject("unreadable", `${where}.id 必须是 [a-z0-9-] 的 slug，实际是 ${describe(id)}`);
  }
  const baseUrl = normalizeStoredBaseUrl(obj["baseUrl"], where);
  // ⚠️ `token` 只判「是字符串」而**不判内容**：服务端用 `timingSafeEqual` 比 SHA-256 摘要，任何字节
  // 都合法，在本层再造一份字符集就是一份会漂的假约束。端部空白 trim 掉 —— 服务端 `http/auth.ts` 的
  // `BEARER_TOKEN` 以 `$` 锚定，尾随空白让它恒 401，而复制粘贴带上一个换行是常态。
  const token = obj["token"];
  if (typeof token !== "string") {
    reject("unreadable", `${where}.token 必须是字符串，实际是 ${describe(token)}`);
  }
  return {
    id,
    name: normalizedName(obj["name"], "unreadable", `${where}.name`),
    baseUrl,
    token: token.trim(),
    timeoutMs: normalizedTimeout(obj["timeoutMs"], "unreadable", `${where}.timeoutMs`),
  };
}

/**
 * 磁盘形态 → {@link Ledger}（逐字段）
 * @description
 * 判定次序固定为 **version → targets → selected**，因为 `selected` 的合法性依赖 `targets` 里的
 * `id` 集合。**遇到第一个问题就抛**（不做「收集全部问题」）：用户一次只会改一处，一屏列七条错
 * 反而让人不知道从哪下手，而 `message` 逐条点名了字段。
 *
 * ⚠️ **`baseUrl` 在这里被归一**（与 {@link validateTargetInput} 落盘前那次是**同一条**判据）：
 * 台账是给人能手改的，而手改最常见的就是多打一个尾斜杠 / 写成带路径的地址 —— 那些都会让请求被
 * 服务端判成 404，于是「地址填对了却连不上」。故读出的 `Ledger` 恒是规范形态，下一次写盘顺带把
 * 文件也归一。**不**做的事是「悄悄接受一份非法地址」，那会把失败推迟到网络上才暴露。
 *
 * @param raw - `JSON.parse` 之后的 `unknown`
 * @returns 规范形态的台账
 * @throws {LedgerError} `unreadable`
 * @example validateLedger({ version: 1, selected: null, targets: [] })
 */
export function validateLedger(raw: unknown): Ledger {
  const obj = asObject(raw, "台账");
  if (obj["version"] !== 1) {
    reject(
      "unreadable",
      `台账 version 必须是数字 1，实际是 ${describe(obj["version"])}（本包没有第二个版本，也没有迁移层）`,
    );
  }
  const rawTargets = obj["targets"];
  if (!Array.isArray(rawTargets)) {
    reject("unreadable", `台账 targets 必须是数组，实际是 ${describe(rawTargets)}`);
  }
  const targets = rawTargets.map((one, index) => validateStoredTarget(one, `targets[${index}]`));

  const ids = new Set<string>();
  for (const target of targets) {
    if (ids.has(target.id)) {
      reject(
        "unreadable",
        `台账里 id 重复：${target.id}（id 是 selected 的引用键，重复就没有确定的指向）`,
      );
    }
    ids.add(target.id);
  }

  const selected = obj["selected"];
  if (selected !== null && typeof selected !== "string") {
    reject("unreadable", `台账 selected 必须是字符串或 null，实际是 ${describe(selected)}`);
  }
  if (typeof selected === "string" && !ids.has(selected)) {
    reject(
      "unreadable",
      `台账 selected 指向不存在的 target：${selected}（不静默置 null —— 那会让「上次选中的不见了」显示成「没选过」）`,
    );
  }
  return { version: 1, selected, targets };
}

/**
 * 用户填的一个端点 → 归一后的同一形状
 * @description
 * 与 {@link validateLedger} 的区别有两条，都是有意的：
 * 1. **基址的判据是 `@/api` 那一份**（{@link normalizeBaseUrl}），本层不重打一遍 —— 它已经把
 *    「非 http / 带 userinfo / 无主机名 / 尾斜杠」四种坏法逐条说清了，两份判据漂了就是
 *    「界面说合法、落盘判非法」。故这里让 `TuiError` 原样向上抛（那是**输入面**的失败类，处置动作
 *    就是回去改输入），只有读面才把它换成 `LedgerError`（见 {@link normalizeStoredBaseUrl}）。
 * 2. **`token` 判非空但不判字符集**：空 token 恒 401（服务端 fail-closed），存一条永远连不上的
 *    记录进台账等于骗用户「加上了」；而字符级的可接受性由服务端那条**唯一**判据回答（它比的是
 *    SHA-256 摘要），本层不持有第二份。
 *
 * @param raw - 用户输入（界面文本框的值逐字传进来，本层不做任何预处理）
 * @returns 归一后的输入（`name` 与 `token` 已 trim，`baseUrl` 已归一）
 * @throws {LedgerError} `invalid-target`：名字 / token / 超时不合法
 * @throws {TuiError} `unreachable`：地址形状不合法（判据与文案来自 `@/api`）
 */
export function validateTargetInput(raw: TargetInput): TargetInput {
  const name = normalizedName(raw.name, "invalid-target", "name");
  if (typeof raw.baseUrl !== "string") {
    reject("invalid-target", `baseUrl 必须是字符串，实际是 ${describe(raw.baseUrl)}`);
  }
  if (typeof raw.token !== "string") {
    reject("invalid-target", `token 必须是字符串，实际是 ${describe(raw.token)}`);
  }
  if (raw.token.trim() === "") {
    // ⚠️ 这条判据**不**引用 token 的内容：拒绝一个空 token 不需要把它抄进错误文案
    reject(
      "invalid-target",
      "token 不能为空（服务端对空 token 恒 401，存一条连不上的记录等于骗人）",
    );
  }
  return {
    name,
    // 判据抛 `TuiError` 是**有意**的（见本函数说明第 1 条）
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    token: raw.token.trim(),
    timeoutMs: normalizedTimeout(raw.timeoutMs, "invalid-target", "timeoutMs"),
  };
}
