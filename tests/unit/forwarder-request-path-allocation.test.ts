import { describe, expect, it } from "vitest";
import { blockAfter, codeOf, offendingLines, sourceOf } from "../helpers/source-scan.js";

/**
 * 请求路径「零实例化」护栏（源码级负向断言）
 *
 * @description
 * 四个转发器在**服务构造期**一次组装好、跨请求复用（`HttpProxy` 三个 + `SocksProxyBase` 一个），
 * 请求期只调它们的方法。这条不变量的**运行期**那一半在
 * `integration/forwarder-instance-reuse.test.ts`（同一实例被复用 N 次）；本文件锁**源码面**：
 * 请求路径里根本**没有** `new XxxForwarder` 这个写法可写。
 *
 * 为什么两条都要：
 * - 只锁运行期 → 有人把构造挪回请求路径、但恰好没被本文件的那几个用例走到，护栏不会红；
 * - 只锁源码 → 挡不住「换了别的写法」（比如经工厂函数间接 new）。
 * 两者合起来才是完整的。
 *
 * **注释被排除在断言外**（`codeOnly`），理由与 `dialer-protocol-boundary.test.ts` 同源：
 * 文件头不得不点名自己禁止什么（「请求路径不得 new 转发器」），把注释纳入断言就成了自我否定、
 * 只能靠删文档来过。字符串字面量**保留**在断言面里——那里出现 `new XxxForwarder` 同样意味着
 * 有人在手搓转发器实例的字符串形态。
 */

const FORWARDERS = "HttpForwarder|TunnelForwarder|WsForwarder|SocksForwarder";

/** 整个转发器层里**任何** `new XxxForwarder`（含跨文件引用） */
const NEW_FORWARDER = new RegExp(`new\\s+(?:${FORWARDERS})\\b`);

/** 四个转发器实现文件 */
const FORWARDER_FILES = [
  ["core", "forward", "base.ts"],
  ["core", "forward", "http.ts"],
  ["core", "forward", "tunnel.ts"],
  ["core", "forward", "websocket.ts"],
  ["core", "forward", "socks.ts"],
] as const;

/** 服务层里**请求路径**的代码块锚点（构造函数之外的一切） */
const REQUEST_PATH_BLOCKS: readonly { file: readonly string[]; anchor: string; label: string }[] = [
  { file: ["core", "server", "http.ts"], anchor: 'server.on("request"', label: "HttpProxy 的 request 回调" },
  { file: ["core", "server", "http.ts"], anchor: 'server.on("connect"', label: "HttpProxy 的 connect 回调" },
  { file: ["core", "server", "http.ts"], anchor: 'server.on("upgrade"', label: "HttpProxy 的 upgrade 回调" },
  { file: ["core", "server", "http.ts"], anchor: "private async handleForward(", label: "HttpProxy.handleForward" },
  { file: ["core", "server", "socks-base.ts"], anchor: "private async onConn(", label: "SocksProxyBase.onConn" },
  { file: ["core", "server", "socks-session.ts"], anchor: "export async function runSocks4Session(", label: "runSocks4Session" },
  { file: ["core", "server", "socks-session.ts"], anchor: "export async function runSocks5Session(", label: "runSocks5Session" },
];

describe("core/forward + core/server：请求路径零 new 转发器（源码级负向断言）", () => {
  it("四个转发器实现文件里零 `new XxxForwarder`", () => {
    for (const file of FORWARDER_FILES) {
      const text = codeOf(...file);

      expect(
        offendingLines(text, NEW_FORWARDER),
        `${file.join("/")} 是转发器实现：转发器之间互不实例化（组装只发生在服务构造期）`,
      ).toEqual([]);
    }
  });

  it("请求路径的每一个代码块里零 `new XxxForwarder`（三个 server 回调 + handleForward + onConn + 两个会话处理器）", () => {
    for (const { file, anchor, label } of REQUEST_PATH_BLOCKS) {
      const body = blockAfter(codeOf(...file), anchor);

      expect(
        offendingLines(body, NEW_FORWARDER),
        `${label} 是请求路径：不得实例化转发器（逐请求数据一律经 RequestScope 传入）`,
      ).toEqual([]);
    }
  });

  it("四个转发器入口只收 RequestScope，没有 `PipeEventSink` 形参（逐请求事件槽不再有第二个入口）", () => {
    // 形参层面的负向断言：`emit` 字段已删、事件槽只经 `RequestScope` 进来。
    // 命中即说明有人把逐请求的事件槽又加回了入口签名。
    for (const file of FORWARDER_FILES) {
      expect(
        offendingLines(codeOf(...file), /PipeEventSink/),
        `${file.join("/")} 不该再提 PipeEventSink：事件出口归 RequestScope.emit`,
      ).toEqual([]);
    }
  });

  it("`emitWithUser` 全仓归零（身份注入只允许发生在 createRequestScope 一处）", () => {
    for (const dir of [["core", "forward"], ["core", "server"]]) {
      expect(
        offendingLines(codeOf(...dir, "base.ts"), /emitWithUser/),
        `identity 注入已收敛到 request-scope.createRequestScope，${dir.join("/")}/base.ts 不该再提它`,
      ).toEqual([]);
    }
  });
});

describe("服务层组装点：构造次数与请求数无关（静态计数）", () => {
  it("HttpProxy 恰好 new 三个转发器（各一次），且都在构造函数体内", () => {
    const code = codeOf("core", "server", "http.ts");
    const ctor = blockAfter(code, "constructor(options: ProxyOptions");

    for (const name of ["HttpForwarder", "TunnelForwarder", "WsForwarder"]) {
      const total = offendingLines(code, new RegExp(`new\\s+${name}\\b`));
      const inCtor = offendingLines(ctor, new RegExp(`new\\s+${name}\\b`));

      expect(total, `${name} 在 http.ts 里只允许出现一次构造`).toHaveLength(1);
      expect(inCtor, `${name} 的唯一构造点必须在 HttpProxy 构造函数体内`).toHaveLength(1);
    }
  });

  it("SocksForwarder 全仓只被 SocksProxyBase 构造一次，且在字段初始化器里", () => {
    const socksBase = codeOf("core", "server", "socks-base.ts");
    const forwarders = codeOf("core", "forward", "socks.ts");

    expect(
      offendingLines(socksBase, /new\s+SocksForwarder\b/),
      "SocksForwarder 只能在 SocksProxyBase 构造一次（跨会话共享单例）",
    ).toHaveLength(1);
    expect(
      offendingLines(forwarders, /new\s+SocksForwarder\b/),
      "socks.ts 是实现文件，不许自己实例化自己",
    ).toEqual([]);
  });

  it("服务层合计恰好 4 个构造点（3 + 1），与请求数、连接数都无关", () => {
    const total = [
      ...offendingLines(codeOf("core", "server", "http.ts"), NEW_FORWARDER),
      ...offendingLines(codeOf("core", "server", "socks-base.ts"), NEW_FORWARDER),
    ];

    expect(
      total,
      "服务层只允许有这 4 个转发器构造点；多一个就意味着又有人在请求路径里 new",
    ).toHaveLength(4);
  });
});

describe("RequestScope：本对象存在的那条理由被写下来（防删注释式退化）", () => {
  it("request-scope.ts 明写「逐请求数据绝不能存在共享实例上」这条理由", () => {
    const raw = sourceOf("core", "request-scope.ts");

    expect(raw, "文件头必须点名本对象存在的唯一理由（否则后来者会当成多余抽象删掉）").toContain(
      "唯一理由",
    );
    expect(raw).toContain("串号");
  });

  it("ForwarderBase 写明「身份维度绝不存实例字段」这条铁律", () => {
    const raw = sourceOf("core", "forward", "base.ts");

    expect(raw, "铁律必须写在基类上（四个子类共享同一条不变式）").toContain(
      "绝不存实例字段",
    );
  });
});
