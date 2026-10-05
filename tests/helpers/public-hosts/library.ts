import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/library/` 主题片
 *
 * @description
 * 归**管 `tests/library/` 的 agent** 维护。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const LIBRARY_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/library/entry.test.ts",
    // 扫描器把整条点分成员访问的小写形态当作一个「host」，故三条各占一项
    hosts: ["context.store", "runtimea.context.store", "runtimeb.context.store"],
    reason: "**非 host 文本**：三处 `runtime.context.store.get(\"port\")` / `context.store.get(\"port\")` 都是**成员访问**（`ConfigStore` 实例的 `store` 属性），不是字符串里的 host。因 TLD 表收录 `store` 而被命中 —— 与 `tests/AGENTS.md` 点名的 `context.store` 同一类已知误报，显式豁免而不把 `store` 从 TLD 表删掉（那会给真实公网 TLD 开后门）。本文件真要建链的地方一律是 `127.0.0.1`（回环，扫描器本就排除）。",
  },
  {
    file: "tests/library/datasource-standalone.test.ts",
    hosts: ["1.2.3.4"],
    reason: "名单条目**语法**层的合法 IP 字面量：validateAcl({ clientIp: { whitelist: ['1.2.3.4'] } }) 断言的是「这一条被接受」，配套的 not-an-ip 用例断言它被拒。判据是 CIDR 解析的纯函数比较，本档不建链、不起监听、不拨号 —— 它整份文件都不 import 任何代理符号。",
  },
];
