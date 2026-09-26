import { describe, expect, it } from "vitest";
import {
  DirectConnector,
  HttpConnectConnector,
  Socks4Connector,
  Socks5Connector,
  createConnectorSource,
  type UpstreamKind,
} from "@/core/forward/upstream/connector/index.js";
import type { ConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { CoreContext } from "@/core/context.js";
import type { ProxyProtocol } from "@/core/types/proxy.js";
import { ConfigStore, configAccessorFromStore } from "@/config/index.js";
import {
  restoreConfig,
  set,
  snapshotConfig,
  testContext,
  testContextFor,
} from "../helpers/config.js";

/** 上游账号：Base64 值在用例里就地算出（不引生产常量，锁死线上字节） */
const UPSTREAM_USER = "up-user";
const UPSTREAM_PASS = "up-pass";
const UPSTREAM_BASIC = `Basic ${Buffer.from(`${UPSTREAM_USER}:${UPSTREAM_PASS}`).toString("base64")}`;

/**
 * 每个 `CoreContext` 派生**一份** `ConnectorSource`（模拟装配期只解析一次的真实接线）。
 *
 * **生产侧唯一的 `ConnectorSource` 出口是 `createConnectorSource(ctx)`**；本测试函数是它的一个替身。
 * 「同一 context 下同一协议复用同一实例」这条不变量的记忆**归属是「每个 source 内部」**
 * （不是模块级全局记忆表）——要锁的东西没变：同一 ctx 的同一档必须给出同一对象，
 * 不同 ctx 必须给出不同对象。
 *
 * ⚠️ 下面这个 `WeakMap` 是**本测试自己**的（让「同 ctx → 同 source」在断言里成立），
 * **不是**生产侧那份已删的缓存表——两者名字一样、归属相反，混读会把一条测试脚手架
 * 当成生产契约。它的存在只是为了让「复用实例」那条断言有得可测：若每次调用都现造一份
 * source，「同档复用同一实例」就变成永远通过的空断言。
 */
const sources = new WeakMap<CoreContext, ConnectorSource>();

function sourceOf(ctx: CoreContext): ConnectorSource {
  let s = sources.get(ctx);

  if (s === undefined) {
    s = createConnectorSource(ctx);
    sources.set(ctx, s);
  }

  return s;
}

/** 6 种 `ProxyProtocol` → 4 个连接器类的期望结果（必须保持绿的契约表） */
const CASES: {
  protocol: ProxyProtocol;
  kind: UpstreamKind;
  ctor: "DirectConnector" | "HttpConnectConnector" | "Socks4Connector" | "Socks5Connector";
  targetForm: "absolute" | "origin";
  hasAuth: boolean;
  hasSelfLoop: boolean;
}[] = [
  {
    protocol: "http",
    kind: "http",
    ctor: "HttpConnectConnector",
    targetForm: "absolute",
    hasAuth: true,
    hasSelfLoop: true,
  },
  {
    protocol: "https",
    kind: "https",
    ctor: "HttpConnectConnector",
    targetForm: "absolute",
    hasAuth: true,
    hasSelfLoop: true,
  },
  {
    protocol: "socks4",
    kind: "socks4",
    ctor: "Socks4Connector",
    targetForm: "origin",
    hasAuth: false,
    hasSelfLoop: true,
  },
  {
    protocol: "sockss4",
    // TLS 承载是传输细节，kind 归一到逻辑协议
    kind: "socks4",
    ctor: "Socks4Connector",
    targetForm: "origin",
    hasAuth: false,
    hasSelfLoop: true,
  },
  {
    protocol: "socks5",
    kind: "socks5",
    ctor: "Socks5Connector",
    targetForm: "origin",
    hasAuth: false,
    hasSelfLoop: true,
  },
  {
    protocol: "sockss5",
    kind: "socks5",
    ctor: "Socks5Connector",
    targetForm: "origin",
    hasAuth: false,
    hasSelfLoop: true,
  },
];

const CTORS = {
  DirectConnector,
  HttpConnectConnector,
  Socks4Connector,
  Socks5Connector,
} as const;

describe("core/forward/upstream/connector/registry 协议 → 连接器映射", () => {
  it("6 种 ProxyProtocol 映射到 4 个连接器类，逐项锁定 kind/targetForm/凭证/自环目标", () => {
    const prev = snapshotConfig([
      "upstreamHost",
      "upstreamPort",
      "upstreamUsername",
      "upstreamPassword",
      "upstreamProtocol",
    ]);

    try {
      set("upstreamHost", "proxy.internal");
      set("upstreamPort", 8080);
      set("upstreamUsername", UPSTREAM_USER);
      set("upstreamPassword", UPSTREAM_PASS);

      for (const c of CASES) {
        // 协议不再是入参：`upstream()` 现读 `upstreamProtocol` 并只认第一次看到的值。
        // 故每档必须「设协议 + 新建一份 source」，否则记忆化会让第 2 档起全部拿到第 1 档的连接器
        // （那正是这条契约自己声明的行为，所以用例得按装配期的真实形态来写）。
        set("upstreamProtocol", c.protocol);
        const connector = createConnectorSource(testContext).upstream();

        expect(connector.kind, `${c.protocol} 的 kind`).toBe(c.kind);
        expect(connector.targetForm, `${c.protocol} 的 targetForm`).toBe(c.targetForm);
        expect(connector, `${c.protocol} 的实现类`).toBeInstanceOf(CTORS[c.ctor]);

        if (c.hasAuth) {
          // http/https 上游：凭证走 Proxy-Authorization 头值
          expect(connector.upstreamAuthHeader(), `${c.protocol} 的上游凭证头`).toBe(UPSTREAM_BASIC);
        } else {
          // 直连与 SOCKS：一律不带 HTTP 头凭证（SOCKS 凭证在握手里）
          expect(connector.upstreamAuthHeader(), `${c.protocol} 的上游凭证头`).toBeUndefined();
        }

        if (c.hasSelfLoop) {
          expect(connector.selfLoopTarget(), `${c.protocol} 的上游自环目标`).toEqual({
            host: "proxy.internal",
            port: 8080,
          });
        } else {
          expect(connector.selfLoopTarget(), `${c.protocol} 的上游自环目标`).toBeUndefined();
        }
      }
    } finally {
      restoreConfig(prev);
    }
  });

  it("sockss4/sockss5 的 kind 是 socks4/socks5 本身，不是 TLS 形态的自己", () => {
    const prev = snapshotConfig(["upstreamProtocol"]);

    try {
      set("upstreamProtocol", "sockss4");
      const s4 = createConnectorSource(testContext).upstream();
      expect(s4.kind).toBe("socks4");
      expect(s4.kind).not.toBe("sockss4");

      set("upstreamProtocol", "sockss5");
      const s5 = createConnectorSource(testContext).upstream();
      expect(s5.kind).toBe("socks5");
      expect(s5.kind).not.toBe("sockss5");
      // 且实现类与明文形态同一个类（差别只在构造参数 secure）
      expect(s4).toBeInstanceOf(Socks4Connector);
      expect(s4).not.toBeInstanceOf(Socks5Connector);
      expect(s5).toBeInstanceOf(Socks5Connector);
    } finally {
      restoreConfig(prev);
    }
  });

  it("直连连接器：kind/targetForm/无凭证/无上游自环目标", () => {
    const connector = sourceOf(testContext).direct();

    expect(connector.kind).toBe("direct");
    expect(connector.targetForm).toBe("origin");
    expect(connector.upstreamAuthHeader()).toBeUndefined();
    expect(connector.selfLoopTarget()).toBeUndefined();
  });

  it("未知协议 fail-closed 抛错，绝不静默回落 direct", () => {
    // 抛点仍在**请求期**（`upstream()` 第一次被调），不在 `createConnectorSource` 那一刻——
    // 行为逐字未变，见 registry.ts 文件头「fail-closed：请求期抛错，不是装配期抛错」。
    const prev = snapshotConfig(["upstreamProtocol"]);

    try {
      set("upstreamProtocol", "ftp" as ProxyProtocol);
      const src = createConnectorSource(testContext);
      // 同一个 source 连续问两次都抛：绝不出现「第一次抛、第二次悄悄给一个直连」那样的旁路
      expect(() => src.upstream()).toThrow(/unsupported upstream protocol: ftp/);
      expect(() => src.upstream()).toThrow(/unsupported upstream protocol: ftp/);

      set("upstreamProtocol", "" as ProxyProtocol);
      expect(() => createConnectorSource(testContext).upstream()).toThrow(
        /unsupported upstream protocol/,
      );
    } finally {
      restoreConfig(prev);
    }
  });

  it("未配置上游账号时，http/https 上游也不带凭证头", () => {
    const prev = snapshotConfig(["upstreamUsername", "upstreamPassword", "upstreamProtocol"]);

    try {
      set("upstreamUsername", "");
      set("upstreamPassword", "");

      set("upstreamProtocol", "http");
      expect(createConnectorSource(testContext).upstream().upstreamAuthHeader()).toBeUndefined();
      set("upstreamProtocol", "https");
      expect(createConnectorSource(testContext).upstream().upstreamAuthHeader()).toBeUndefined();
    } finally {
      restoreConfig(prev);
    }
  });
});

describe("core/forward/upstream/connector/registry 记忆化", () => {
  it("同一 source 下同一直连/上游档各自复用同一实例（连接器无状态）", () => {
    // 「协议」不再是入参（`UPSTREAM_PROTOCOL` 是 startup 相位，端口化后由 source 内部现读
    // 并**只认第一次看到的值**），所以「同协议复用同一实例」的正确口径变成
    // 「同 source + 同 upstreamProtocol → 同一对象」。
    const prev = snapshotConfig(["upstreamProtocol"]);

    try {
      set("upstreamProtocol", "socks5");
      const src = sourceOf(testContext);
      expect(src.upstream()).toBe(src.upstream());
      expect(src.direct()).toBe(src.direct());
      // direct 与 upstream 是两档，本就必须是不同对象（把直连写成特例正是端口化要消灭的）
      expect(src.direct()).not.toBe(src.upstream());

      // 换一份 source 但同 ctx 同协议 → 各自记忆，仍各自稳定
      const other = createConnectorSource(testContext);
      set("upstreamProtocol", "http");
      expect(other.upstream()).toBe(other.upstream());
      expect(other.upstream()).not.toBe(src.upstream());
    } finally {
      restoreConfig(prev);
    }
  });

  it("不同 context 派生不同实例（记忆按 CoreContext 隔离，不跨 accessor 串配置）", () => {
    const otherCtx = testContextFor(configAccessorFromStore(new ConfigStore()));

    expect(sourceOf(testContext).upstream()).not.toBe(sourceOf(otherCtx).upstream());
    expect(sourceOf(testContext).direct()).not.toBe(sourceOf(otherCtx).direct());
  });

  it("缓存的实例每次现读配置：同一实例上的自环目标随 upstreamHost 改动", () => {
    const prev = snapshotConfig(["upstreamHost", "upstreamPort", "upstreamProtocol"]);
    set("upstreamProtocol", "socks5");
    const connector = sourceOf(testContext).upstream();

    try {
      set("upstreamHost", "first.proxy");
      set("upstreamPort", 1080);
      expect(connector.selfLoopTarget()).toEqual({ host: "first.proxy", port: 1080 });

      // 同一实例（记忆命中），配置已变 → 声明式数据必须跟着变，否则记忆就是第二真相源
      expect(sourceOf(testContext).upstream()).toBe(connector);
      set("upstreamHost", "second.proxy");
      set("upstreamPort", 1081);
      expect(connector.selfLoopTarget()).toEqual({ host: "second.proxy", port: 1081 });
    } finally {
      restoreConfig(prev);
    }
  });
});
