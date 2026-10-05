import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/utils/` 主题片
 *
 * @description
 * 归**管 `tests/unit/utils/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_UTILS_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/utils/addr/host-rule.test.ts",
    hosts: ["1.2.3.4", "11.0.0.1", "a.b.a.com", "a.com", "example.com", "nota.com", "other.com", "www.example.com", "x.a.com"],
    reason: "名单条目**语法**层：裸域 vs `*.` 后缀、尾点、IDN/下划线、CIDR 条目全是待解析的字符串字面量；parseHostRule/hostMatches 只做归一与比较，不建立任何连接。",
  },
  {
    file: "tests/unit/utils/addr/ip-rule.test.ts",
    hosts: ["1.2.3.4", "1.2.3.5", "11.0.0.0", "11.0.0.1", "300.1.1.1"],
    reason: "同上（IP 侧）：CIDR / v4-mapped / 越界 octet（300.1.1.1）都是待解析的条目字面量，判定是纯字符串与位运算。",
  },
  {
    file: "tests/unit/utils/addr/inbound.test.ts",
    hosts: ["1.1.1.1", "192.0.2.43", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5", "9.9.9.9", "example.com"],
    reason: "地址提取/归一函数的**入参**（x-forwarded-for 头、authority、括号 IPv6 形态）；192.0.2.43 是 RFC 5737 文档 IP。全是字符串处理。",
  },
  {
    file: "tests/unit/utils/logger/levels.test.ts",
    hosts: ["1.2.3.4"],
    reason: "日志记录里的 client host 占位符。",
  },
];
