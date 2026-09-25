/**
 * CLI argv 来源：把 `--proxy-protocol socks5` / `--port=8080` / `PORT=8080`
 * 归一成 ENV 风格键值表，使三种写法命中同一张 `FIELDS` 表。
 *
 * 纯字符串处理：不认识字段名，不做值域校验（那是 `schema/validate.ts` 的职责），
 * 也不读 `process.argv`——argv 必须由调用方显式传入。
 */

import { RE_DASH_GLOBAL, RE_LEADING_DASHES } from "@/utils/constants.js";

/**
 * CLI -> ENV 风格键值：归一（去前导 -、- 转 _、大写）使 `--proxy-protocol` 与
 * `PROXY_PROTOCOL` 同表命中。
 *
 * 支持 `--key value`、`--key=value`、`KEY=VALUE`；`KEY=VALUE` 只在第一个 `=` 处切分，
 * 因此值本身可以继续包含 `=`。裸 flag 视为 `true`，`--` 跳过。
 */
export function parseRawArgv(argv: readonly string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("-") && arg.includes("=")) {
      // indexOf/slice 而非 split("=", 2)：值本身可能含 "="，保持完整值。
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
