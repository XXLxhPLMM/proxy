/**
 * 这一档钉 ⑦⑧：库调用方的注入路径（`services.outboundHeaders` 一路落到 core 且真的被调用）与
 * `applyOutboundRewrite` 的职责边界（**源码级** —— 这半条在行为面上原理不可观测）。
 *
 * @module tests/integration/forward/outbound-header-rewrite
 * 六条契约那张表与「缺席短路为什么只能由源码级判据钉住」的变异实测见 `./AGENTS.md`；装配面见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import os from "node:os";
import { createProxyRuntime } from "@/runtime/index.js";
import { openAccessControl } from "../../../helpers/access.js";
import { testLogger } from "../../../helpers/config.js";
import { getFreePort } from "../../../helpers/net.js";
import { blockAfter, codeOf } from "../../../helpers/source-scan.js";
import {
  NO_AUTH_IDENTITY,
  REPLY_200,
  absReq,
  dictOf,
  rawRequest,
  recorder,
  setup,
  startOrigin,
} from "./fixture.js";
describe("outbound-header-rewrite · ⑦ 库调用方的注入路径", () => {
  /**
   * 锁「`createProxyRuntime({ services: { outboundHeaders } })` 真的落到 core 并真的被调用」
   *
   * @description 前面六条走的是直构 core（`ProxyOptions.outboundHeaders`），库调用方走的是另一条
   * 路：`RuntimeServices.outboundHeaders` → `runtime.options` → `ProxyOptions` → `CoreServices`。
   * 那条链上任何一环漏传，症状都是**静默的不改写**（请求照常 200，只是新头没出去）——本条因此同时
   * 断**同一性**（`runtime.options` / `core.options` 上就是注入的那一个函数）与**行为**（源站真的
   * 收到了新头）两半。`configDir` 显式给到临时目录的成因见 `./AGENTS.md`（库模式不经 `loadConfig`，
   * 路径类字段的缺省会按 cwd = 仓库根绝对化，而仓库里真的躺着 `cfg/users.json` 与 `cfg/acl.json`）。
   */
  it("services.outboundHeaders 原样透传到 options 与 core，且真的被调用（静默漏传会红）", async () => {
    setup();
    const origin = await startOrigin(REPLY_200);
    const rec = recorder((h) => ({ ...h, "x-trace-id": "lib-1" }));
    const port = await getFreePort();
    const runtime = createProxyRuntime({
      config: { host: "127.0.0.1", port },
      configDir: os.tmpdir(),
      logger: testLogger,
      services: { outboundHeaders: rec.rewriter, access: openAccessControl(), identity: NO_AUTH_IDENTITY },
    });

    try {
      await runtime.start();
      expect(runtime.services.outboundHeaders, "注入的那份原样落在 services 上").toBe(rec.rewriter);
      expect(runtime.options.outboundHeaders, "并一路透传到归一后的 options 上").toBe(rec.rewriter);
      expect(
        runtime.getProxy().options.outboundHeaders,
        "core 侧拿到的也是同一个实例（漏传在这里会红，而症状是静默的不改写）",
      ).toBe(rec.rewriter);

      const r = await rawRequest(port, absReq(origin.port));
      expect(r.status).toBe(200);
      expect(rec.calls, "库路径下钩子真的被调了").toHaveLength(1);
      expect(dictOf(origin.requests()[0])["x-trace-id"], "库路径下加的头也真的出站").toBe("lib-1");
    } finally {
      await runtime.stop();
    }
  });
});

describe("outbound-header-rewrite · ⑧ applyOutboundRewrite 的职责边界（源码级）", () => {
  const body = blockAfter(codeOf("core", "helpers", "headers.ts"), "export function applyOutboundRewrite(");

  /**
   * 锁「`applyOutboundRewrite` 体内零剥离、零强制头」
   *
   * @description 这条**只能是源码级**：它在问「某个职责长在哪个函数里」，而「改写这一步有没有顺带
   * 剥凭证 / 有没有顺手把 `connection` 钉死」在行为面上的投影是**空的**——即使这个函数真做了那些
   * 事，线上字节也可能一模一样（`sanitizeHeaders` 已经先剥过了、调用点随后又强制了一次
   * `Connection: close`）。所以「两半职责不许合并」这件事只能钉在源码形状上。
   *
   * 判据锚在**今天仍存在的调用点与常量**上（不是某个被删掉的符号名）：`isProxyHeaderName` /
   * `isStrippableOutboundHeader` / `isOwnCredential` / `HEADER_PREFIX_PROXY` 是剥离那半的入口，
   * `HEADER_VALUE_CLOSE` / 字面量 `connection` 是强制头那半的入口。任何一个被挪进来，这条立刻红。
   */
  it("改写这一步里不许长出剥离规则或强制头（两半职责分离）", () => {
    expect(
      body,
      "applyOutboundRewrite 只做「缺席/抛错 → 原样返回」这一个判定；"
        + "任何剥离判据（proxy- 前缀规则、isOwnCredential 委派）挪进来，就等于让「改写」重新长出安全职责。",
    ).not.toMatch(/isStrippableOutboundHeader|isProxyHeaderName|isOwnCredential|HEADER_PREFIX_PROXY/);
    expect(
      body,
      "`Connection: close` 的最终裁决归调用点（`channel/http.ts` 改写之后那次无条件写入）；"
        + "长进这个函数就等于把「插件能不能开上游 keep-alive」这件事的决定权交出去了。",
    ).not.toMatch(/HEADER_VALUE_CLOSE|connection/);
  });

  /**
   * 锁「缺席短路是承重的」（**已变异测试验证：删掉它 → 本条红，其余六条一条都不红**）
   *
   * @description 这条同样是原理不可观测的：`rewriter(headers, context)` 在 `rewriter === undefined`
   * 时会抛 `TypeError`，而那个 throw 就发生在**同一个 `try` 里**、被**同一个 `catch`** 接住、返回
   * **同一个引用**——删掉短路之后的字节与不删**逐字节全等**。区别全在热路径上：每个请求的每次出站
   * 都白付一次「构造异常对象 + 栈捕获 + 抛 + 捕」，而这条路径是每请求必经的。
   *
   * 判据是**肯定式**的（锚在今天存在的那段字面量上，`rewriter` 形参名一旦消失也会红），不是
   * 「某个符号不许出现」那种负向断言——后者在符号被删掉之后会**恒真**，伪装成「护栏在生效」。
   * 判据跨行，故先把空白折成单空格再比整段。
   */
  it("缺席短路必须在（删掉它字节等价，但每请求白付一次 throw/catch）", () => {
    expect(
      body.replace(/\s+/g, " "),
      "`undefined` 是这个策略位的完整语义（不改写 = 保持现状），缺席必须走「一次判定就返回」那条路；"
        + "走 catch 分支在字节上等价、在热路径上却是每请求一次异常构造。",
    ).toContain("if (rewriter === undefined) { return headers; }");
  });
});
