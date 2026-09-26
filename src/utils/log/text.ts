/**
 * 日志文本净化与渲染 - logger 与其它「把任意值写进单行文本」调用点的唯一实现
 * 职责：
 * - `sanitizeLogText`：控制字符（C0 + DEL）转义为可见形式，保证单条日志恒为单行
 * - `stripControlChars`：控制字符折叠为空格（给需要「压成安全纯文本」的调用点，如 JSON 资源错误文本）
 * - `renderErrorText`：`Error` 渲染为可读单行（`JSON.stringify(Error)` 只会得到 `{}`）
 * - `renderValue` / `renderFieldValue`：任意值的单行文本（msg 参数与结构化字段共用一份实现）
 * - `isPlainObject` / `splitFields`：结构化字段识别（`args` 末位 plain object 即 fields）
 * 约束：零依赖纯函数，永不抛（病态值有回退），是「日志永不抛」契约的第一道实现。
 */

/**
 * 日志文本控制字符（C0 控制符 + DEL）
 * @description 客户端可控字节（SOCKS 域名/USERID、Host 头、X-Forwarded-For、凭证）含 `\n`
 * 可伪造日志条目（污染审计），含 ESC 可注入终端转义序列。
 */
// eslint-disable-next-line no-control-regex
const RE_CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * 日志文本净化：把控制字符（C0 + DEL）转义为可见形式
 * @param s - 原始文本
 * @returns 转义后的单行文本
 * @example sanitizeLogText("a\nINFO fake") // => "a\\nINFO fake"
 */
export function sanitizeLogText(s: string): string {
  return s.replace(RE_CONTROL_CHARS, (c) => {
    if (c === "\n") {
      return "\\n";
    }
    if (c === "\r") {
      return "\\r";
    }
    if (c === "\t") {
      return "\\t";
    }
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

/**
 * 控制字符折叠为空格（不保留可读转义）
 * @description 给「错误文本要进日志但不需要保留原貌」的调用点用（如 JSON 资源读取器的去敏错误文本）：
 * 与 {@link sanitizeLogText} 的区别是原地抹平而非转义，调用方通常再跟一次空白折叠 + trim。
 * @param s - 原始文本
 * @returns 控制字符已替换为空格的文本
 * @example stripControlChars("bad\njson") // => "bad json"
 */
export function stripControlChars(s: string): string {
  return s.replace(RE_CONTROL_CHARS, " ");
}

/**
 * Error 渲染为可读单行文本（落盘 msg 与控制台字段共用）
 * @description Error 的 message/stack 是非枚举属性，JSON.stringify 只会得到 `{}`——
 * 转发层 502 的成因（ECONNREFUSED/TLS 校验失败）会因此丢失。这里特判渲染为
 * `name: message [code=...] [stack 首帧]`，经 sanitizeLogText 净化保证单行。
 * 控制台 msg 通道不经过此函数：Error 原样交给 console，保持原生堆栈可读。
 * @param e - 待渲染的 Error（含自定义 name/code）
 * @returns 净化后的单行文本
 * @example renderErrorText(Object.assign(new Error("boom"), { code: "ECONNREFUSED" }))
 */
function renderErrorText(e: Error): string {
  try {
    const parts: string[] = [`${e.name || "Error"}: ${e.message}`];
    const code = (e as { code?: unknown }).code;
    if (code !== undefined && code !== null) {
      parts.push(`code=${String(code)}`);
    }
    // stack 首帧（`at ...`）：定位抛点；首行通常是 `name: message`，与上方重复故跳过
    const frame = e.stack?.split("\n").find((line) => line.trim().startsWith("at "));
    if (frame) {
      parts.push(frame.trim());
    }
    return sanitizeLogText(parts.join(" "));
  } catch {
    // 病态 Error 子类（抛错的 getter 等）：退化为 String，绝不外抛
    try {
      return sanitizeLogText(String(e));
    } catch {
      return "[unserializable]";
    }
  }
}

/**
 * 任意值 → 单行文本（msg 参数与结构化字段的**唯一**渲染实现）
 * @description string 净化后原样；number/boolean 直接 String（`NaN`/`Infinity` 因此保真，
 * 不像 `JSON.stringify` 那样塌成 `null`）；`undefined` → `"undefined"`；
 * Error 渲染为可读单行；其余（嵌套对象/数组等）JSON.stringify，失败回退 String，绝不抛。
 * @param v - 待渲染值
 * @returns 单行文本
 * @example renderValue(1n) // => "1"（BigInt 会让 JSON.stringify 抛错，走 String 回退）
 */
export function renderValue(v: unknown): string {
  if (typeof v === "string") {
    return sanitizeLogText(v);
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (v === undefined) {
    return "undefined";
  }
  if (v instanceof Error) {
    return renderErrorText(v);
  }
  try {
    const s = JSON.stringify(v);
    // 函数/Symbol 的 JSON.stringify 返回 undefined（非抛错），同样回退 String
    if (s !== undefined) {
      return s;
    }
  } catch {
    // 循环引用 / BigInt 等抛错：落入下方 String 回退
  }
  try {
    return String(v);
  } catch {
    return "[unserializable]";
  }
}

/**
 * 控制台渲染单个字段值
 * @description 与 {@link renderValue} 的唯一差别：`null`/`undefined` 返回 undefined 表示
 * 「跳过该键」（字段缺失不该在日志里留下 `k=undefined`/`k=null` 噪声）；
 * msg 参数通道不走本函数，`null` 仍渲染为 `"null"`。
 * @param v - 字段值
 * @returns 可读文本，或 undefined 表示不打印该键
 */
export function renderFieldValue(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : renderValue(v);
}

/**
 * 字节数 → 人类可读文本（流量配额的日志渲染）
 * @description 二进制单位（1KB = 1024B），保留两位小数。**刻意只做「渲染」不做「解析」**：
 * 它只服务日志可读性，`quota.bytes` 的真相源永远是配置里的数字，日志里的 `1.00GB`
 * 绝不反向参与判定。负数与 NaN 一律按 0 渲染（账本异常不该在日志里显示 `NaN GB`）。
 * @param bytes - 字节数
 * @returns 形如 `0 B` / `1.50 KB` / `1.00 GB` / `2.00 TB`
 * @example formatBytes(1073741824) // => "1.00 GB"
 */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;

  if (value < 1024) {
    return `${Math.round(value)} B`;
  }

  const units = ["KB", "MB", "GB", "TB", "PB"];
  let scaled = value / 1024;
  let unit = 0;

  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }

  return `${scaled.toFixed(2)} ${units[unit]}`;
}

/**
 * plain object 判定（严格）
 * @description 仅接受「纯净对象字面量」：原型为 `Object.prototype` 或 `null`。
 * 天然排除 Error / Array / Buffer / Date / Map / 类实例——它们仍按 renderValue() 规则进 msg。
 * 这条判定是「最后一个参数是否视作结构化 fields」的唯一依据。
 * @param v - 待判定值
 * @returns 是 plain object 时返回 true，并收窄为 `Record<string, unknown>`
 * @example isPlainObject({ a: 1 }) // => true
 * @example isPlainObject(new Error("x")) // => false
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  );
}

/**
 * 拆出结构化字段：`args` 末位若为 plain object 则视为 fields，不再参与 msg 拼接
 * @description 仅识别**最后一个**参数，前面的 plain object 仍按普通参数进 msg。
 * @param args - 原始参数数组
 * @returns `args`（剔除 fields 后的 msg 参数）与可选 `fields`
 */
export function splitFields(args: unknown[]): { args: unknown[]; fields?: Record<string, unknown> } {
  const last = args.length > 0 ? args[args.length - 1] : undefined;
  if (isPlainObject(last)) {
    return { args: args.slice(0, -1), fields: last };
  }
  return { args };
}
