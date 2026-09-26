import { stripControlChars } from "@/utils/log/text.js";

/**
 * 错误种类。
 * 纯归一化层只标记调用方给出的类别，不根据错误文本或错误码猜测处理策略。
 */
export type ErrorKind =
  | "config"
  | "request"
  | "upstream"
  | "protocol"
  | "subscriber"
  | "process"
  | "startup"
  | "shutdown"
  | "unknown";

/** 允许进入结构化错误字段的有限标量值。 */
export type ErrorFieldValue = string | number | boolean;

/**
 * 调用方提供的错误上下文提示。
 * 这里只接受显式标量；归一化层不会从原始 Error/cause 复制属性。
 */
export interface ErrorHint {
  readonly kind?: ErrorKind;
  readonly httpStatus?: number;
  readonly target?: string;
  readonly client?: string;
  readonly operation?: string;
  readonly fields?: Readonly<Record<string, ErrorFieldValue>>;
}

/** 可以安全跨边界传递的最小错误描述；不包含 cause、stack 或其它对象引用。 */
export interface ErrorSummary {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
}

/** 稳定的、深度只读且不持有原始异常引用的错误 DTO。 */
export interface NormalizedError extends ErrorSummary {
  readonly kind: ErrorKind;
  readonly fields: Readonly<Record<string, ErrorFieldValue>>;
  readonly httpStatus?: number;
  readonly target?: string;
  readonly client?: string;
  readonly operation?: string;
}

/** 无副作用、无事件发布、无日志副作用的错误归一化服务。 */
export interface ErrorService {
  /** 将任意输入转换为不会继续抛错的安全 DTO。 */
  normalize(error: unknown, hint?: ErrorHint): NormalizedError;
}

const MAX_NAME_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 512;
const MAX_CONTEXT_LENGTH = 256;
const MAX_OPERATION_LENGTH = 80;
const MAX_CODE_LENGTH = 128;
const MAX_FIELD_KEY_LENGTH = 64;
const MAX_FIELD_VALUE_LENGTH = 256;
const MAX_HINT_FIELDS = 12;
const MAX_SENSITIVE_SCAN_LENGTH = 4096;

const SENSITIVE_FIELD_KEY_FRAGMENTS = [
  "authorization",
  "cookie",
  "header",
  "credential",
  "password",
  "passwd",
  "secret",
  "token",
  "jwt",
  "apikey",
  "privatekey",
  "tlskey",
  "user",
  "account",
  "acl",
  "allowlist",
  "denylist",
  "whitelist",
  "blacklist",
] as const;

// 保守遮蔽常见凭据形态；最终日志层还会再次做控制字符净化。
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /((?:proxy[-_\s]?authorization|authorization|set-cookie|cookie|x-api-key|password|passwd|secret|token|jwt)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isErrorKind(value: unknown): value is ErrorKind {
  return (
    value === "config" ||
    value === "request" ||
    value === "upstream" ||
    value === "protocol" ||
    value === "subscriber" ||
    value === "process" ||
    value === "startup" ||
    value === "shutdown" ||
    value === "unknown"
  );
}

/** 属性读取必须容忍 getter、Proxy 与病态 thenable。 */
function readProperty(value: unknown, key: string): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }

  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function readStringProperty(value: unknown, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function canonicalFieldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeFieldKey(key: string): string | undefined {
  const canonical = canonicalFieldKey(key);
  if (
    key.length === 0 ||
    key.length > MAX_FIELD_KEY_LENGTH ||
    !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) ||
    SENSITIVE_FIELD_KEY_FRAGMENTS.some((fragment) => canonical.includes(fragment))
  ) {
    return undefined;
  }
  return key;
}

function sanitizeText(value: string, fallback: string, maxLength: number): string {
  try {
    const scanned =
      value.length > MAX_SENSITIVE_SCAN_LENGTH ? value.slice(0, MAX_SENSITIVE_SCAN_LENGTH) : value;
    const redacted = stripControlChars(
      scanned
        .replace(URL_USERINFO_PATTERN, "$1***@")
        .replace(AUTH_SCHEME_PATTERN, "$1 ***")
        .replace(CREDENTIAL_ASSIGNMENT_PATTERN, "$1***"),
    ).trim();
    return redacted.length > 0 ? redacted.slice(0, maxLength) : fallback;
  } catch {
    return fallback;
  }
}

function safeName(value: unknown): string {
  const raw = readStringProperty(value, "name");
  return sanitizeText(raw ?? "Error", "Error", MAX_NAME_LENGTH);
}

function safeMessage(error: unknown): string {
  const raw = readStringProperty(error, "message");
  if (raw !== undefined) {
    return sanitizeText(raw, "Unknown error", MAX_MESSAGE_LENGTH);
  }
  if (error === null || error === undefined) {
    return "Unknown error";
  }

  try {
    return sanitizeText(String(error), "Unknown error", MAX_MESSAGE_LENGTH);
  } catch {
    return "Unknown error";
  }
}

function safeCode(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return sanitizeText(value, "unknown", MAX_CODE_LENGTH);
  }
  return undefined;
}

function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 999
    ? value
    : undefined;
}

function safeHintString(
  hint: ErrorHint | undefined,
  key: "target" | "client" | "operation",
): string | undefined {
  const value = readProperty(hint, key);
  if (typeof value !== "string") {
    return undefined;
  }
  const maxLength =
    key === "target" || key === "client" ? MAX_CONTEXT_LENGTH : MAX_OPERATION_LENGTH;
  const sanitized = sanitizeText(value, "", maxLength);
  return sanitized.length > 0 ? sanitized : undefined;
}

function mergeHintFields(fields: Record<string, ErrorFieldValue>, hintedFields: unknown): void {
  if (!isObjectLike(hintedFields)) {
    return;
  }

  let keys: string[];
  try {
    keys = Object.keys(hintedFields);
  } catch {
    return;
  }

  for (const key of keys) {
    if (Object.keys(fields).length >= MAX_HINT_FIELDS) {
      return;
    }
    const safeKey = safeFieldKey(key);
    if (safeKey === undefined) {
      continue;
    }

    const value = readProperty(hintedFields, key);
    if (typeof value === "boolean") {
      fields[safeKey] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      fields[safeKey] = value;
    } else if (typeof value === "string") {
      const safeValue = sanitizeText(value, "", MAX_FIELD_VALUE_LENGTH);
      if (safeValue.length > 0) {
        fields[safeKey] = safeValue;
      }
    }
  }
}

function unknownError(): NormalizedError {
  return Object.freeze({
    kind: "unknown" as const,
    name: "Error",
    message: "Unknown error",
    fields: Object.freeze(Object.create(null) as Record<string, ErrorFieldValue>),
  });
}

function normalizeError(error: unknown, hint?: ErrorHint): NormalizedError {
  try {
    const hintedKind = readProperty(hint, "kind");
    const kind = isErrorKind(hintedKind) ? hintedKind : "unknown";
    const code = safeCode(readProperty(error, "code"));
    const httpStatus = safeHttpStatus(readProperty(hint, "httpStatus"));
    const target = safeHintString(hint, "target");
    const client = safeHintString(hint, "client");
    const operation = safeHintString(hint, "operation");
    const fields: Record<string, ErrorFieldValue> = Object.create(null) as Record<
      string,
      ErrorFieldValue
    >;
    mergeHintFields(fields, readProperty(hint, "fields"));

    return Object.freeze({
      kind,
      name: safeName(error),
      message: safeMessage(error),
      ...(code === undefined ? {} : { code }),
      fields: Object.freeze(fields),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(target === undefined ? {} : { target }),
      ...(client === undefined ? {} : { client }),
      ...(operation === undefined ? {} : { operation }),
    });
  } catch {
    return unknownError();
  }
}

/** 创建纯错误归一化服务；不依赖 Cordis、事件总线、logger 或进程 API。 */
export function createErrorService(): ErrorService {
  return { normalize: normalizeError };
}
