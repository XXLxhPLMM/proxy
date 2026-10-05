import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/integration/forward/` 平铺档片
 *
 * @description
 * 归**管 `tests/integration/forward/` 平铺档（`forward/*.test.ts`）的 agent** 维护。今天有几条读
 * `INTEGRATION_FORWARD_FLAT_HOST_REFS.length` —— 片头不写死数字（写死的数只会在下一次加条目
 * 时变成一句谎话，而读者会信它）。
 *
 * ⚠️ **本目录一条 entry 都没有的那些档是真没有公网字面量**（零字面量的档建条目会被判 stale），
 * 不是漏申报。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const INTEGRATION_FORWARD_FLAT_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/integration/forward/tunnel-guard.test.ts",
    hosts: ["example.com"],
    reason: "裸 net.Server 转发器入口手搓的**伪 req**：`url` / `headers.host` / `rawHeaders` 是喂给被测代码的入参文本，真实连接打的是本机空闲端口。",
  },
  {
    file: "tests/integration/forward/http-via-socks.test.ts",
    hosts: ["example.com"],
    reason: "伪 req 的 Host 头 / url 字段（同上：入参文本，真实目标是本机桩端口）。",
  },
  {
    file: "tests/integration/forward/http-upstream-protocol.test.ts",
    hosts: ["example.com"],
    reason: "请求行 URL 与 `upstream-ok:<url>` 回显断言；明文 SOCKS5 上游桩在**本机** serve 这个 target，example.com 不被解析。",
  },
];
