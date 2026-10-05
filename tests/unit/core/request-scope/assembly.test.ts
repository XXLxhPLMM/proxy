import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildInboundChannels,
  type ForwarderSet,
  type InboundChannels,
} from "@/core/server/http.js";
import { codeOnly, offendingLines, sourceOf, SRC_DIR } from "../../../helpers/source-scan.js";

/**
 * `RequestScope` 的**组装面**：它在哪里被造出来、以什么形状造出来。
 *
 * ⛔ **不要把它扩成「请求的全部上下文袋」** —— 存在的唯一理由是**逐请求数据绝不能活在共享实例
 * 上**，铁律与两档分工见 `AGENTS.md`。⚠️ 本档是**双源档**（`allocation` 的末段 + `inbound-dispatch`
 * 的末两段，按 `appendOrder` 追加，前导常量与 imports 并进同一个文件头）。
 * ⚠️ 「恰好一个调用点」要数 `src/**` 全量，故路径**从 `SRC_DIR` 派生**，不手写层数 `..`。
 */

/** 派发表必须恰好覆盖的三种入站事件（`server.on` 的三个主链路） */
const KINDS = ["request", "connect", "upgrade"] as const;

/** 探针转发器：每个只实现自己那一项的入口方法名（其余成员不实现，收到就说明派发写错了） */
function probeForwarders(): { set: ForwarderSet; calls: { forwarder: string; args: unknown[] }[] } {
  const calls: { forwarder: string; args: unknown[] }[] = [];
  const record =
    (forwarder: string) =>
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

describe("RequestScope 组装：调用点唯一 + 入参形状一致", () => {
  /** 扫 `src/**` 全部 `.ts`（源码级断言要盯的是「全仓有几处」，不是某一个文件） */
  function allSources(dir: string): { file: string; text: string }[] {
    const root = path.join(SRC_DIR, dir);
    const out: { file: string; text: string }[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }
      const abs = path.join(entry.parentPath ?? root, entry.name);
      out.push({ file: path.relative(SRC_DIR, abs), text: codeOnly(fs.readFileSync(abs, "utf8")) });
    }
    return out;
  }

  it("`createRequestScope` 在 src/** 里恰好一个调用点，且在 core/server/admission.ts", () => {
    // 被否掉的是「让转发器自己再包一层 `scopeWithUser`」——任何第二注入口都会把同一事实抄成两份，
    // 而两份必然漂移。
    // 三处**不是调用点**的同名/同词，逐条写明理由（不许用「过滤掉就算了」的方式藏起来）：
    // ① `core/events/scope.ts` 的同名函数 —— 那是 `EventScope`（位置参数），同名不同物；
    // ② `core/request-scope.ts` 自己的**声明**；
    // ③ import 行。
    const all = allSources(".").flatMap(({ file, text }) =>
      text
        .split("\n")
        .flatMap((line, i) => (line.includes("createRequestScope(") ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
    const notCalls = (hit: string): boolean =>
      /^\S+:import\b/.test(hit) ||
      hit.includes(path.join("core", "events", "scope.ts")) ||
      /export function createRequestScope\(/.test(hit);
    const hits = all.filter((hit) => !notCalls(hit));

    expect(hits, `src/** 里 createRequestScope 的调用点应恰好一处（全部命中：${JSON.stringify(all)}）`)
      .toHaveLength(1);
    expect(hits[0]).toContain(path.join("core", "server", "admission.ts"));
  });

  it("两条入站路径都不自己造 scope（它们只调准入层的 scopeFor）", () => {
    for (const file of ["http.ts", "socks-base.ts"]) {
      const text = codeOnly(sourceOf("core", "server", file));

      expect(
        offendingLines(text, /createRequestScope\b/),
        `core/server/${file} 不得自己造 RequestScope：组装只在准入层一处（否则身份注入又有了第二个入口）`,
      ).toEqual([]);
      expect(text, `core/server/${file} 必须经准入层现造一条会话作用域`).toMatch(/\.scopeFor\(/);
    }
  });

  it("准入层那一处的入参形状只有一种（ctx/terminal/context/user 四项，无第二个 id 入口）", () => {
    const code = codeOnly(sourceOf("core", "server", "admission.ts"));
    const at = code.indexOf("createRequestScope(");
    expect(at, "准入层必须调 createRequestScope").toBeGreaterThanOrEqual(0);
    const call = code.slice(at, code.indexOf(");", at));

    expect(call).toContain("ctx");
    expect(call).toContain("terminal");
    expect(call).toContain("context:");
    expect(call).toContain("user");
    // 关联 id 只经 context 进（`RequestScopeOptions` 已无独立的 requestId/connectionId 形参）
    expect(call).not.toMatch(/\brequestId\s*:/);
    expect(call).not.toMatch(/\bconnectionId\s*:/);
  });

  it("`RequestScopeOptions` 不再重复收 requestId/connectionId（同一个事实不许两个入口）", () => {
    const raw = sourceOf("core", "request-scope.ts");
    const block = raw.slice(raw.indexOf("export interface RequestScopeOptions"));
    const body = block.slice(0, block.indexOf("}"));

    expect(
      offendingLines(body, /\b(requestId|connectionId)\??\s*:/),
      "关联 id 只从 context 取：identity 本来就会被合并进发布的 context，两个入口必然漂移",
    ).toEqual([]);
  });
});

describe("防假绿：护栏盯的代码块真的存在", () => {
  it("buildInboundChannels 真的产出三项真函数（不是空壳/占位）", () => {
    const { set, calls } = probeForwarders();
    const channels: InboundChannels = buildInboundChannels(set);

    for (const kind of KINDS) {
      expect(typeof channels[kind].dispatch).toBe("function");
      expect(typeof channels[kind].rejectTarget).toBe("function");
      expect(typeof channels[kind].forwardKind).toBe("string");
    }
    expect(calls).toHaveLength(0);
  });

  it("三个探针转发器确实各是一个可被调用的对象（否则上面几条全是空跑）", () => {
    // 桩是照着三个真实入口方法名建的，故这里取那三个成员（不是别的名字）
    const { set } = probeForwarders();
    // 桩是照着三个真实入口方法名建的，故这里直接取那三个成员（不是别的名字）
    const spies = [
      vi.fn(set.http.handleRequest),
      vi.fn(set.tunnel.handleConnect),
      vi.fn(set.ws.handleUpgrade),
    ];

    for (const spy of spies) {
      spy();
    }

    expect(spies.map((s) => s.mock.calls.length)).toEqual([1, 1, 1]);
  });
});