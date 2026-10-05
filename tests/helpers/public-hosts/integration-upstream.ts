import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/integration/upstream/` 主题片
 *
 * @description
 * 归**管 `tests/integration/upstream/` 的 agent** 维护。四条纪律与那三个断言在
 * `../AGENTS.md` 与 `../../unit/no-external-network.test.ts`：
 * `reason` 答「为什么它不建链」、**零公网字面量的文件不建条目**（建了会被判 stale）、
 * 同一 `(file, host)` 对不许在表里出现两次、`file` 必须真的在被扫描范围内
 * （`walk()` 收目录下全部 `.ts`，故 `matrix-fixture.ts` 这种非 `.test.ts` 也在内）。
 *
 * ⚠️ 加档时先跑 `grep -c "example\.com" <新档>`（注释里的会被 `codeOnly` 剥掉，
 * 所以判据是「代码里有没有」而不是「文本里有没有」）；**没命中就不建条目**。
 */
export const INTEGRATION_UPSTREAM_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/integration/upstream/matrix-fixture.ts",
    hosts: ["example.com"],
    reason:
      "本模块只提供客户端侧 helper（`httpViaProxy` 的请求头），**目标端口一律来自 `getFreePort()`**，从不自己取目标地址。`Host: \"example.com\"` 是 HTTP 头（线上文本），不是连接目标 —— 本机 http/https 上游桩只回 `upstream-ok:`，不解析该 host；「→502」档在自签 TLS 握手失败处就短路。故无一条会真出网。",
  },
  {
    file: "tests/integration/upstream/matrix-a-http.test.ts",
    hosts: ["example.com"],
    reason:
      "只出现在 **absolute-form（http 请求）** 档：上游是本机 http/https 服务器，只回 `upstream-ok:`，不解析该 host；「→502」档在自签 TLS 握手失败处就短路。**所有 CONNECT 档的目标都是 `127.0.0.1:<空闲端口>`**（已逐条核对），故无一条会真出网。",
  },
  {
    file: "tests/integration/upstream/matrix-c-https.test.ts",
    hosts: ["example.com"],
    reason:
      "同 A 档的形态，只是下游多一层 TLS：目标是本机 https 入站，转发的 absolute-form 交给本机上游桩，桩只回 `upstream-ok:`、不解析该 host。**所有落到真实源站的档目标都是 `127.0.0.1:<空闲端口>`**（已逐条核对），故无一条会真出网。",
  },
  {
    file: "tests/integration/upstream/matrix-i-tls-byte-level.test.ts",
    hosts: ["example.com"],
    reason:
      "三处都在 **real TLS 上游握手取证** 的断言面（`requestLine` / `target` 逐字比对）：目标是本机可观测上游桩，桩只记录上游**收到**的报文并按桩角色回包，不解析、更不连该 host。反向取证那档（打到明文哑桩）走 `127.0.0.1:<空闲端口>`，构造 TLS 失配而不是出网。",
  },
];