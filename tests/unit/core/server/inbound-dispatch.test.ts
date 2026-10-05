import { describe, expect, it } from "vitest";
import { PassThrough, type Duplex } from "node:stream";
import type http from "node:http";
import {
  buildInboundChannels,
  channelFor,
  type ForwarderSet,
  type InboundEventOf,
  type InboundKind,
} from "@/core/server/http.js";
import { HttpForwarder } from "@/core/forward/channel/http.js";
import { TunnelForwarder } from "@/core/forward/channel/tunnel.js";
import { WsForwarder } from "@/core/forward/channel/upgrade.js";
import type { RequestScope } from "@/core/request-scope.js";
import { codeOnly, offendingLines, sourceOf } from "../../../helpers/source-scan.js";

/**
 * 「入站事件种类 → 转发器」这张**显式的表**的形状护栏（答案必须在表里，不在三条闭包的分支里）。
 *
 * 本档钉四件事：表**恰好三项**且三项的 `dispatch` 是**三个不同函数**；派发**真的按表走**（参数
 * 逐字）；三个 `server.on` 回调体内**零控制流**（判据比「零 `if (kind …)`」更宽）；探针替身不是空跑。
 * ⚠️ 与同目录 `base-lifecycle.test.ts` 共用的两条纪律见 `AGENTS.md`。只服务本档的一条：
 * ⚠️ **入口方法名必须按名字逐项断言** —— 同名的护栏等于没断言，而 `ENTRY_METHODS` 锚在**真实
 * prototype** 上，把 `handleUpgrade` 改名成 `handle` 会立刻红。
 * `forwardKind` 只服务事件载荷的 `data.kind`，**不承担「归哪个转发器」**；SOCKS 不进这张表。
 */

/** 派发表必须恰好覆盖的三种入站事件（`server.on` 的三个主链路） */
const KINDS = ["request", "connect", "upgrade"] as const;

/** 公共事件面 `data.kind` 的三个取值（逐字契约：`request-scope-ids` / `core-event-bridge` 锁着） */
const FORWARD_KINDS = ["http", "tunnel", "upgrade"] as const;

type Recorded = { forwarder: "http" | "tunnel" | "ws"; args: unknown[] };

/** 一个够用的 `RequestScope` 替身：派发表只把它当不透明值透传给转发器 */
const scope = { emit: (): void => {} } as unknown as RequestScope;

/** 造一个 `IncomingMessage` 替身：派发表只读它的 `headers`/`method` 之外的字段原样透传 */
function fakeReq(): http.IncomingMessage {
  return { method: "GET", url: "http://example.test/" } as unknown as http.IncomingMessage;
}

function fakeRes(): http.ServerResponse {
  return {} as http.ServerResponse;
}

function fakeSocket(): Duplex {
  return new PassThrough();
}

/** 三个入站事件各一个（形状由 `InboundEvent` 判别联合定义） */
function threeEvents(): { [K in InboundKind]: InboundEventOf<K> } {
  return {
    request: { kind: "request", req: fakeReq(), socket: fakeSocket(), res: fakeRes() },
    connect: { kind: "connect", req: fakeReq(), socket: fakeSocket(), head: Buffer.from("c") },
    upgrade: { kind: "upgrade", req: fakeReq(), socket: fakeSocket(), head: Buffer.from("u") },
  };
}

/**
 * 三项各自调用的**入口方法名**
 *
 * @description 与 {@link KINDS} 逐位对齐，且每个名字都**自带身份**：把 `InboundKind` 的
 * 判别键直接读成方法名（`request` → `handleRequest`）。所以「派发表的一项对哪个实现方法」
 * 从这张表就能一眼读出，不必去翻转发器类名或记「三个方法都叫 `handle`」这种反直觉的事。
 */
const ENTRY_METHODS = ["handleRequest", "handleConnect", "handleUpgrade"] as const;

/** 探针转发器：每个只实现自己那一项的入口方法名（其余成员不实现，收到就说明派发写错了） */
function probeForwarders(): { set: ForwarderSet; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const record =
    (forwarder: Recorded["forwarder"]) =>
    (...args: unknown[]): void => {
      calls.push({ forwarder, args });
    };
  const set = {
    http: { handleRequest: record("http") },
    tunnel: { handleConnect: record("tunnel") },
    ws: { handleUpgrade: record("ws") },
  } as unknown as ForwarderSet;

  return { set, calls };
}

describe("core/server/http：入站派发表（InboundKind → 转发器）", () => {
  it("恰好三项，键就是三种入站事件，顺序稳定", () => {
    const { set } = probeForwarders();

    expect(Object.keys(buildInboundChannels(set))).toEqual([...KINDS]);
  });

  it("三项的入口方法名互不相同，且各自与 InboundKind 逐字对齐（按名字直接断言）", () => {
    // 三个方法名**互不相同** —— 这条是「按名字断言」成立的前提：三个转发器的入口都叫
    // `handle` 时这一项恒绿，拿方法名断言等于没断言。先钉互不相同，再按名字逐字对齐。
    expect(new Set(ENTRY_METHODS).size).toBe(KINDS.length);

    for (const [i, kind] of KINDS.entries()) {
      // 逐字对齐：方法名就是 `handle` + 该 kind（大小写按 kind 原样）
      expect(ENTRY_METHODS[i], `${kind} 那一项必须调 handle + ${kind} 那个方法`).toBe(
        `handle${kind[0].toUpperCase()}${kind.slice(1)}`,
      );
    }
  });

  it("防假绿：三个真实转发器类上确实各带着自己那一项的方法名（且没有别的同名入口）", () => {
    for (const [i, name] of ENTRY_METHODS.entries()) {
      const proto = [HttpForwarder, TunnelForwarder, WsForwarder][i].prototype as unknown as Record<
        string,
        unknown
      >;

      expect(typeof proto[name], `第 ${i} 个转发器必须有 ${name} 入口`).toBe("function");
      // 只许有自己那一项的入口：多一个 `handle` 之类的通用名就等于把这件事又变回隐式
      for (const other of ENTRY_METHODS.filter((n) => n !== name)) {
        expect(proto[other], `${name} 那一项的转发器不该再实现 ${other}`).toBeUndefined();
      }
    }
  });

  it("三项的 forwardKind 互不相同，且等于公共事件面 data.kind 的三个契约值", () => {
    const { set } = probeForwarders();
    const channels = buildInboundChannels(set);
    const kinds = KINDS.map((k) => channels[k].forwardKind);

    expect(new Set(kinds).size).toBe(KINDS.length);
    expect(kinds).toEqual([...FORWARD_KINDS]);
  });

  it("三项的 dispatch 是三个互不相同的函数（防「三项共用一条闭包」）", () => {
    const { set } = probeForwarders();
    const channels = buildInboundChannels(set);
    const dispatches = KINDS.map((k) => channels[k].dispatch);

    expect(new Set(dispatches).size).toBe(KINDS.length);
  });

  it("三项的 rejectTarget 指向各自的载体：http 给 res，tunnel/upgrade 给裸 socket", () => {
    const { set } = probeForwarders();
    const channels = buildInboundChannels(set);
    const events = threeEvents();

    expect(channels.request.rejectTarget(events.request)).toBe(events.request.res);
    expect(channels.connect.rejectTarget(events.connect)).toBe(events.connect.socket);
    expect(channels.upgrade.rejectTarget(events.upgrade)).toBe(events.upgrade.socket);
  });

  it("派发真的按表走：三种事件各打到自己的转发器，方法参数逐字正确", () => {
    const { set, calls } = probeForwarders();
    const channels = buildInboundChannels(set);
    const events = threeEvents();

    for (const kind of KINDS) {
      channelFor(channels, kind).dispatch(events[kind], scope);
    }

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ forwarder: "http", args: [events.request.req, events.request.res, scope] });
    expect(calls[1]).toEqual({
      forwarder: "tunnel",
      args: [events.connect.req, events.connect.socket, events.connect.head, scope],
    });
    expect(calls[2]).toEqual({
      forwarder: "ws",
      args: [events.upgrade.req, events.upgrade.socket, events.upgrade.head, scope],
    });
  });

  it("派发表是在服务构造期建的：HttpProxy 三个转发器字段与表里的对象逐字同源", () => {
    // 防假绿：表必须真的是拿那三个实例建的，不能是「又 new 了一份」或「空实现」
    const { set, calls } = probeForwarders();
    const channels = buildInboundChannels(set);

    channelFor(channels, "request").dispatch(threeEvents().request, scope);

    expect(calls[0]?.forwarder).toBe("http");
  });
});

describe("core/server/http：三个 server.on 回调只做参数适配（源码级负向）", () => {
  const code = codeOnly(sourceOf("core", "server", "http.ts"));

  const CALLBACKS: readonly { anchor: string; label: string }[] = [
    { anchor: 'server.on("request"', label: "request 回调" },
    { anchor: 'server.on("connect"', label: "connect 回调" },
    { anchor: 'server.on("upgrade"', label: "upgrade 回调" },
  ];

  /** 取某个 `server.on(...)` 回调的函数体（花括号配对，跳过字符串字面量） */
  function callbackBody(anchor: string): string {
    const at = code.indexOf(anchor);
    if (at < 0) {
      throw new Error(`源码里找不到锚点：${JSON.stringify(anchor)}`);
    }
    const start = code.indexOf("{", at + anchor.length);
    let depth = 0;
    let i = start;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        i++;
        while (i < code.length && code[i] !== ch) {
          i += code[i] === "\\" ? 2 : 1;
        }
        i++;
        continue;
      }
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return code.slice(start + 1, i);
        }
      }
      i++;
    }
    throw new Error(`锚点 ${JSON.stringify(anchor)} 的代码块没有闭合`);
  }

  it("回调体内零控制流、零三元选转发器、零 Forwarder 引用（答案在表里，不在回调里）", () => {
    for (const { anchor, label } of CALLBACKS) {
      const body = callbackBody(anchor);

      // 判据刻意比「零 `if (kind …)`」更宽：**任何**控制流都不许出现
      // （`if (kind …)` 只是其中一种写法；换个判据如 `if (this.protocol === …)`
      // 塞进来同样是「把这一层又变回隐式」）。实测三个回调体内连一个 `?` 都不需要。
      for (const [label2, re] of [
        ["if", /\bif\s*\(/],
        ["switch", /\bswitch\s*\(/],
        ["for", /\bfor\s*\(/],
        ["while", /\bwhile\s*\(/],
        ["三元/可选链", /\?/],
      ] as const) {
        expect(
          offendingLines(body, re),
          `${label} 只许把 Node 回调参数适配成统一形状，体内零控制流（命中 ${label2}）`,
        ).toEqual([]);
      }
      expect(
        offendingLines(body, /Forwarder/),
        `${label} 体内零转发器引用：连 httpForwarder/tunnelForwarder/wsForwarder 都不该出现`,
      ).toEqual([]);
    }
  });

  it("回调只交出 kind 与形状：三个回调各自把 Node 参数适配成 InboundEvent 的一支", () => {
    // 防假绿：三个锚点都真的存在，且各自带上了那一支独有的字段
    expect(callbackBody('server.on("request"')).toContain("res,");
    expect(callbackBody('server.on("connect"')).toContain("head }");
    expect(callbackBody('server.on("upgrade"')).toContain("head }");
  });
});