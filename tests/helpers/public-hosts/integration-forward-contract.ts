import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/integration/forward/contract/` 片
 *
 * @description
 * 归**管 `tests/integration/forward/contract/` 的 agent** 维护。今天有几条读
 * `INTEGRATION_FORWARD_CONTRACT_HOST_REFS.length` —— 片头不写死数字（写死的数只会在下一次加
 * 条目时变成一句谎话，而读者会信它）。
 *
 * ⚠️ **本目录一条 entry 都没有的三个文件是真没有公网字面量**：`origin-form.test.ts` /
 * `socks-tunnel.test.ts` / `fixture.ts` 三者零公网字面量（建了会被当场判 stale，见 `../AGENTS.md`）。
 *
 * ⚠️ **`reason` 里的「本档 / 这一档」代词要逐条限定到自己的 `file`**：三条各自锁的是不同的东西
 * （出站字节原样保留 / 上游凭证注入 / 拨不通回 502），共用一句「本档」等于读者永远不知道是哪个
 * 文件在豁免。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const INTEGRATION_FORWARD_CONTRACT_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/integration/forward/contract/absolute-form.test.ts",
    hosts: ["example.com"],
    reason: "手写请求行里的 absolute-form URL（`GET http://example.com/abs?x=1` 那几条）—— 这一档锁的是**对端是代理时出站字节原样保留**：连接器按 `upstreamHost`/`upstreamPort` 拨桩，那个 authority 从不参与解析，桩与客户端都在 127.0.0.1 上。",
  },
  {
    file: "tests/integration/forward/contract/upstream-credential.test.ts",
    hosts: ["example.com"],
    reason: "凭证矩阵 (a) 那一条手写请求行里的 absolute-form URL —— 这一档只钉「上游凭证只经 http/https 上游注入」：出站去向由 `upstreamPort` 指到桩，这个 host 只是线上文本，从不解析、也从不建链。",
  },
  {
    file: "tests/integration/forward/contract/dial-failure.test.ts",
    hosts: ["example.com"],
    reason: "手写请求行里的 absolute-form URL —— 这一档钉的是**拨不通时回 502 + upstream-error**：连接器拨的是 `upstreamPort` 上那个空端口，这个 authority 不参与拨号（正因为拨不通才有 502 可断言）。",
  },
];