/**
 * JSON 资源错误文本去敏 - 读取器抛出的文本在离开缓存层前的唯一净化点
 * 职责：
 * - `sanitizeJsonFileErrorText`：控制字符折叠 + 空白归一 + 键值脱敏 + 长度封顶
 * - `isMissingError` / `ioErrorText`：从 unknown 异常里只取错误码，绝不带出原始 message/stack
 * 设计：
 * - 绝不抛、绝不返回原始异常：调用点在每连接（ACL）与每请求（鉴权）路径上，
 *   且错误文本会进日志与事件，必须是「已去敏的单行纯文本」
 * - 不接收 `Error`、配置内容或 stack 作为「可信输入」——一切按不可信处理
 * - 控制字符折叠复用 `utils/log/text.ts:stripControlChars`（压平而非转义，见该文件说明）
 */

import { stripControlChars } from "@/utils/log/text.js";

/** 错误文本上限，避免异常消息无限进入日志/事件。 */
const MAX_ERROR_LENGTH = 240;

/**
 * 把错误消息压成安全的纯文本；不接收 Error、配置内容或 stack。
 * @param text - 待净化文本（来源可能是异常 message、校验器返回值或固定文案）
 * @returns 去敏后的单行纯文本；空输入返回 `未知错误`，超长按上限截断并补省略号
 * @example sanitizeJsonFileErrorText("密码: hunter2") // => "密码: [redacted]"
 * @example sanitizeJsonFileErrorText("a\u0000b") // => "a b"（控制字符折叠为空格）
 */
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

/**
 * 只有真正的 ENOENT/ENOTDIR 表示路径不存在。
 * @description 目录、socket、设备等都不是「缺失」；`EACCES`/`EPERM`/`EIO` 等一律算读取失败
 *   （走「保留上一份有效值」路径，而不是静默回退空配置）。
 */
export function isMissingError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 生成不含原始 message/stack 的 I/O 错误文本。 */
export function ioErrorText(operation: string, error: unknown): string {
  const code = errorCode(error);
  return sanitizeJsonFileErrorText(
    code === undefined ? `${operation}失败` : `${operation}失败 (${code})`,
  );
}
