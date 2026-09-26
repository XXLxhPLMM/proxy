/**
 * CLI argv 来源 - argv -> env 风格键值 -> typed 配置片段
 *
 * 与 `env-file.ts` 对称：那边是「一个来源的完整读取」（env 文件 -> process.env），
 * 这边是「一个来源的完整读取」（argv -> Partial<AppConfig>）。两段式的原因是
 * `load.initConfig` 需要原始字符串形态（才能和终端 env 逐字段比优先级），
 * 而库调用方 / 单测只想直接拿一份 typed patch。
 *
 * 校验规则全部委托 `schema/`：本文件只负责把 argv 归一成键值、决定何时抛错，
 * 不自己判断枚举与整数范围。
 */
import type { AppConfig } from "../types.js";
import { collectIntRangeErrors, resolveFieldEntries } from "../schema/validate.js";

/** CLI 键归一：去前导横杠（`/^-+/`），`--port` => `port` 用 */
const RE_LEADING_DASHES = /^-+/;
/** CLI 键归一：横杠转下划线全局替换（`/-/g` => `"_"`），`--proxy-protocol` => `PROXY_PROTOCOL` 用 */
const RE_DASH_GLOBAL = /-/g;

/**
 * CLI -> ENV 风格键值：归一（去前导 -、- 转 _、大写）使 --proxy-protocol 与 PROXY_PROTOCOL 同表命中
 *   --port 3000 / --port=3000 / PORT=3000 / --auth-enabled（无值即 "true"）
 *   "--" 跳过；--key 后非 - 开头 token 作为值消费（i++），否则记 "true"
 */
export function parseRawArgv(argv: string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("-") && arg.includes("=")) {
      // indexOf/slice 而非 split("=", 2)：值本身可能含 "="（如 JWT_SECRET=Zm9v==），
      // split 截断会丢尾巴，与 --key=value 路径保持一致
      const eqIdx = arg.indexOf("=");
      const k = arg.slice(0, eqIdx);
      const v = arg.slice(eqIdx + 1);
      raw[k.replace(RE_LEADING_DASHES, "").replace(RE_DASH_GLOBAL, "_").toUpperCase()] = v;
      continue;
    }
    if (!arg.startsWith("-")) {
      continue;
    }
    arg = arg.replace(RE_LEADING_DASHES, "");
    const eqIdx = arg.indexOf("=");
    let key: string;
    let value: string;
    if (eqIdx !== -1) {
      key = arg.slice(0, eqIdx);
      value = arg.slice(eqIdx + 1);
    } else {
      key = arg;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        value = next;
        i++;
      } else {
        value = "true";
      }
    }
    raw[key.replace(RE_DASH_GLOBAL, "_").toUpperCase()] = value;
  }
  return raw;
}

/**
 * 解析命令行启动参数 -> Partial<AppConfig>
 * 与 initConfig 共用同一张 FIELDS 表与同一套校验：显式给出的非法值直接抛错，
 * 不做静默丢弃（静默回退会让 --port banana 悄悄跑在默认端口上）；int 字段同样做越界拦截
 */
export function parseStartupArgs(argv: string[] = process.argv.slice(2)): Partial<AppConfig> {
  const raw = parseRawArgv(argv);
  const { resolved: out, bad } = resolveFieldEntries((env) => raw[env]);
  if (bad.length) {
    throw new Error(`配置校验失败: ${bad.join(", ")} 非法`);
  }
  // 与 initConfig 同款越界检查：--port 70000 之类在此拦截，不静默截断/回退
  const badRange = collectIntRangeErrors(out);
  if (badRange.length) {
    throw new Error(`配置校验失败: ${badRange.join(", ")} 越界`);
  }
  return out as Partial<AppConfig>;
}
