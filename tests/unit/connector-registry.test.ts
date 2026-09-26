import { describe, expect, it } from "vitest";
import {
  DirectConnector,
  HttpConnectConnector,
  Socks4Connector,
  Socks5Connector,
  connectorFor,
  directConnector,
  type UpstreamKind,
} from "@/core/forward/upstream/connector/index.js";
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

/** 6 种 `ProxyProtocol` → 4 个连接器类的期望结果（Phase 2b 必须保持绿的契约表） */
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
    ]);

    try {
      set("upstreamHost", "proxy.internal");
      set("upstreamPort", 8080);
      set("upstreamUsername", UPSTREAM_USER);
      set("upstreamPassword", UPSTREAM_PASS);

      for (const c of CASES) {
        const connector = connectorFor(c.protocol, testContext);

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
    expect(connectorFor("sockss4", testContext).kind).toBe("socks4");
    expect(connectorFor("sockss4", testContext).kind).not.toBe("sockss4");
    expect(connectorFor("sockss5", testContext).kind).toBe("socks5");
    expect(connectorFor("sockss5", testContext).kind).not.toBe("sockss5");
    // 且实现类与明文形态同一个类（差别只在构造参数 secure）
    expect(connectorFor("sockss4", testContext)).toBeInstanceOf(Socks4Connector);
    expect(connectorFor("sockss4", testContext)).not.toBeInstanceOf(Socks5Connector);
    expect(connectorFor("socks5", testContext)).toBeInstanceOf(Socks5Connector);
  });

  it("直连连接器：kind/targetForm/无凭证/无上游自环目标", () => {
    const connector = directConnector(testContext);

    expect(connector.kind).toBe("direct");
    expect(connector.targetForm).toBe("origin");
    expect(connector.upstreamAuthHeader()).toBeUndefined();
    expect(connector.selfLoopTarget()).toBeUndefined();
  });

  it("未知协议 fail-closed 抛错，绝不静默回落 direct", () => {
    expect(() => connectorFor("ftp" as ProxyProtocol, testContext)).toThrow(
      /unsupported upstream protocol: ftp/,
    );
    expect(() => connectorFor("" as ProxyProtocol, testContext)).toThrow(
      /unsupported upstream protocol/,
    );
  });

  it("未配置上游账号时，http/https 上游也不带凭证头", () => {
    const prev = snapshotConfig(["upstreamUsername", "upstreamPassword"]);

    try {
      set("upstreamUsername", "");
      set("upstreamPassword", "");

      expect(connectorFor("http", testContext).upstreamAuthHeader()).toBeUndefined();
      expect(connectorFor("https", testContext).upstreamAuthHeader()).toBeUndefined();
    } finally {
      restoreConfig(prev);
    }
  });
});

describe("core/forward/upstream/connector/registry 单例缓存", () => {
  it("同一 context 下同一协议复用同一实例（连接器无状态）", () => {
    expect(connectorFor("socks5", testContext)).toBe(connectorFor("socks5", testContext));
    expect(connectorFor("http", testContext)).toBe(connectorFor("http", testContext));
    expect(connectorFor("http", testContext)).not.toBe(connectorFor("https", testContext));
    expect(directConnector(testContext)).toBe(directConnector(testContext));
  });

  it("不同 context 派生不同实例（缓存按 CoreContext 隔离，不跨 accessor 串配置）", () => {
    const otherCtx = testContextFor(configAccessorFromStore(new ConfigStore()));

    expect(connectorFor("socks5", testContext)).not.toBe(connectorFor("socks5", otherCtx));
    expect(directConnector(testContext)).not.toBe(directConnector(otherCtx));
  });

  it("缓存的实例每次现读配置：同一实例上的自环目标随 upstreamHost 改动", () => {
    const prev = snapshotConfig(["upstreamHost", "upstreamPort"]);
    const connector = connectorFor("socks5", testContext);

    try {
      set("upstreamHost", "first.proxy");
      set("upstreamPort", 1080);
      expect(connector.selfLoopTarget()).toEqual({ host: "first.proxy", port: 1080 });

      // 同一实例（缓存命中），配置已变 → 声明式数据必须跟着变，否则缓存就是第二真相源
      expect(connectorFor("socks5", testContext)).toBe(connector);
      set("upstreamHost", "second.proxy");
      set("upstreamPort", 1081);
      expect(connector.selfLoopTarget()).toEqual({ host: "second.proxy", port: 1081 });
    } finally {
      restoreConfig(prev);
    }
  });
});
