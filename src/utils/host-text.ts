/**
 * @fileoverview 主机 / IP 文本归一化的原子操作唯一收口点
 * @module utils/host-text
 * @description
 * 「小写、剥方括号、剥 %zone、去尾点」这四个动作**散落多处各写一遍字符串手术**时
 * 语义会微妙不一致（`normalizeIp` 只认整体被方括号包裹的形态；`normalizeHost` 认
 * `[v6]:port` 并按 `]` 截断、且方括号形态不去尾点）。本模块把它们拆成**无状态纯原子**，
 * 由各调用方按自身契约组合：差异留在组合处一眼可见，而不是复制四份互相漂移的实现。
 *
 * 不变量（**本模块的硬边界**，改这里等于改全仓主机归一化口径）：
 * - 零项目依赖：不 import 任何项目模块，只吃字符串吐字符串，可被 config/utils/core 任意层引用
 * - 零 IO、零配置、零日志、零模块级状态
 * - **不是 IP/域名语法校验器**：本模块只做字符级手术，「这是不是一个合法地址」由
 *   `config/files/rules/ip.ts` 与 `config/files/rules/host.ts` 判定
 *
 * 使用示例：
 * ```ts
 * import { lowerTrim, stripIpBrackets, stripTrailingDot } from "@/utils/host-text.js";
 *
 * lowerTrim("  Example.COM. "); // => "example.com."
 * stripTrailingDot("example.com."); // => "example.com"
 * stripIpBrackets("[::1]:443"); // => "::1"
 * ```
 */

/**
 * 去 IPv6 方括号，取 `]` 之前的地址内容
 * @description `[::1]` → `::1`；`[::1]:443` → `::1`（端口段被 `]` 截断自然排除）；
 * 未闭合方括号只去左括号（`[::1` → `::1`）；不以 `[` 开头则原样返回。
 * 注意本原子**不判断**输入是否真是 IPv6，也不校验 `]` 之后的内容是否合法端口段。
 * @param s - 原始文本
 * @returns 去括号后的文本
 * @example stripIpBrackets("[::1]") // => "::1"
 * @example stripIpBrackets("[::1]:443") // => "::1"
 * @example stripIpBrackets("[::1") // => "::1"
 * @example stripIpBrackets("example.com") // => "example.com"
 */
export function stripIpBrackets(s: string): string {
  if (!s.startsWith("[")) {
    return s;
  }
  const end = s.indexOf("]");
  return end === -1 ? s.slice(1) : s.slice(1, end);
}

/**
 * 剥 `%zone` 后缀（RFC 4007 区域标识，如 `fe80::1%eth0`）
 * @description 取第一个 `%` 之前的部分；无 `%` 原样返回（不分配新串）。
 * 只剥一次，段内再出现的 `%` 属非法输入，交由上层解析判非法。
 * @param s - 原始文本
 * @returns 去掉 zone 后缀的文本
 * @example stripZone("fe80::1%eth0") // => "fe80::1"
 * @example stripZone("::1") // => "::1"
 */
export function stripZone(s: string): string {
  const i = s.indexOf("%");
  return i === -1 ? s : s.slice(0, i);
}

/**
 * 去末尾的点（FQDN 根标签写法，如 `example.com.`）
 * @description 剥掉**全部**末尾点（DNS 允许写多个，只剥一个会留下 `example.com.` 仍被
 * 当成 FQDN）；无末尾点原样返回。IPv6 文本不会被误伤（其结尾是十六进制或 `]`）。
 * @param s - 原始文本
 * @returns 去尾点后的文本
 * @example stripTrailingDot("example.com.") // => "example.com"
 * @example stripTrailingDot("example.com...") // => "example.com"
 * @example stripTrailingDot("::1") // => "::1"
 */
export function stripTrailingDot(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 46 /* "." */) {
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

/**
 * 去首尾空白并转小写
 * @description 主机名与 IPv6 十六进制段的大小写不敏感（RFC 5952 要求输出小写），
 * 故归一化的第一步统一做 trim + 小写；顺序固定为**先 trim 后小写**。
 * @param s - 原始文本
 * @returns 归一后的文本
 * @example lowerTrim("  Example.COM  ") // => "example.com"
 * @example lowerTrim("2001:DB8::1") // => "2001:db8::1"
 */
export function lowerTrim(s: string): string {
  return s.trim().toLowerCase();
}
