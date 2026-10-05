import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/integration/forward/outbound-header-rewrite/` 片
 *
 * @description
 * 归**管 `tests/integration/forward/outbound-header-rewrite/` 的 agent** 维护。今天有几条读
 * `INTEGRATION_FORWARD_OHR_HOST_REFS.length` —— 片头不写死数字。
 *
 * ⚠️ **该目录下其余各档（`absent-and-mutate` / `library-injection` / `ordering-and-throw` 与
 * `fixture.ts`）零公网字面量，故它们在表里一条都没有**：零字面量的档建条目会被当场判 stale
 * （见 `../AGENTS.md`）。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const INTEGRATION_FORWARD_OHR_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/integration/forward/outbound-header-rewrite/context-dimensions.test.ts",
    hosts: ["203.0.113.9"],
    reason: "**只作为 `X-Forwarded-For` 头值出现**（RFC 5737 文档用 IP），出现在入站请求的线上文本里、从不作为连接目标：那条用例锁的正是「客户端显式发了 XFF，而出站改写钩子拿到的 `context.client` 仍是 TCP 对端」（两个口径刻意不合并，理由同 `AccessClientInput.client`）。本档真发请求时目标一律是 `127.0.0.1:<getFreePort()>` 的本机桩，从不公网拨号。",
  },
];
