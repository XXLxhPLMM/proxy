/**
 * 字段表基础件：FieldDef 契约 + 通用解析器
 *
 * 本文件只提供「一个字段长什么样」和「字符串怎么变成字段值」两块基础件；
 * 表数据在 `fields.ts`，基于表的校验在 `validate.ts`，跨字段守卫在 `guards.ts`。
 * 拆分理由：这三者共享同一批解析器，但变更节奏不同——解析器稳定、表随
 * 配置项增长、校验随校验规则增长，混在一个文件里会互相拖累体积。
 *
 * 依赖方向：只依赖 `types.ts` 的类型，不依赖 store / source / resources。
 */
import type { AppConfig, ConfigKey } from "../types.js";

/**
 * 字段生效时机（必填，避免「哪些改动需要重启」沦为 get() 调用位置的偶然产物）：
 * - startup: ProxyServer.start() 读取一次写进 ProxyOptions（监听地址/协议/TLS/worker 数），
 *            运行中改动无效，需重启进程
 * - runtime: 每请求/连接或每次日志重新 get()，可经 set() 热改
 * 注：标 startup 的字段仍可能在其他位置被重读（如 host/port 另用于自环判定），
 *     判定依据是该字段是否被启动流程一次性捕获
 */
export type ConfigFieldPhase = "startup" | "runtime";

/**
 * 字段表项；字段名、解析器、范围和生效时机都以此表为唯一真相源。
 */
export interface FieldDef<K extends ConfigKey = ConfigKey> {
  /** store 键名（AppConfig 字段） */
  key: K;
  /** 环境变量名（唯一，无别名）；CLI 同源，--key-name / KEY=VALUE 归一为 KEY_NAME */
  env: string;
  /** 字符串 -> 字段类型；undefined 表示非法（显式给出的非法值一律抛错阻止启动，不分来源） */
  parse: (v: string) => AppConfig[K] | undefined;
  /**
   * 整数范围约束，越界即抛错阻止启动；
   * 与 parse 同处一行，避免另建校验表造成两处手工同步
   */
  int?: { min?: number; max?: number };
  /** 生效时机，见 ConfigFieldPhase */
  phase: ConfigFieldPhase;
  /**
   * 兜底默认值；函数形式可依赖配置目录（日志/证书路径）；
   * 省略时取 `defaults.ts` 的同名值
   */
  def?: AppConfig[K] | ((configDir: string) => AppConfig[K]);
}

/** 表项构造辅助：保留字段级泛型 K，对外统一为 FieldDef */
export function field<K extends ConfigKey>(d: FieldDef<K>): FieldDef {
  return d as unknown as FieldDef;
}

// ── 通用解析器：返回 undefined 表示非法，由调用方统一抛错阻止启动 ──

/** 字符串（永非法） */
export const parseStr = (v: string): string => v;

/**
 * 有限数值（空串/NaN/Infinity 视为非法，回退默认）；
 * 接受 0x/1e3 等 Number() 面，小数/越界不拦，由字段表 int 约束最终校验
 */
export const parseNum = (v: string): number | undefined => {
  if (v.trim() === "") {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 枚举：大小写不敏感白名单 */
export const parseEnum =
  <T extends string>(values: readonly T[]) =>
  (v: string): T | undefined => {
    const s = v.toLowerCase().trim();
    return (values as readonly string[]).includes(s) ? (s as T) : undefined;
  };

/**
 * 字符串转布尔 - 兼容 true/1/yes/on/enable 与
 * false/0/no/off/disable 等常见写法
 * 无法识别返回 undefined：显式给出的值一律不允许静默回退，
 * 否则 AUTH_ENABLED=treu 会悄悄变成 false（关闭鉴权）
 */
export const parseBoolean = (v: string): boolean | undefined => {
  const s = v.toLowerCase().trim();
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(s)) {
    return true;
  }
  if (["false", "0", "no", "off", "disable", "disabled"].includes(s)) {
    return false;
  }
  return undefined;
};
