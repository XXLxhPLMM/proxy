/**
 * 自环判定：通配监听、地址归一化，以及走**注入监听地址**的那一条
 *
 * @description
 * 同一条判据的三个面：① `isSelfLoopAddr`（纯函数）的通配监听面；② 归一化面（v4-mapped /
 * 通配目标 / 尾点 / `%zone` / 空串）；③ `isSelfLoop`（从 `ConfigAccessor` 取监听地址的薄委托）
 * 走注入面。
 *
 * ⚠️ **`isSelfLoop` 与 `isSelfLoopAddr` 必须同档**：配置版的行为完全由「它把哪两个值喂给了
 * 纯函数版」决定，拆开就会只钉住其中一半。归一化面逐个值语法档写开的理由见 `AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import { isSelfLoop, isSelfLoopAddr } from "@/core/helpers/index.js";
import { set, testConfig, restoreConfig, snapshotConfig } from "../../../helpers/config.js";

describe("core/helpers/self-loop.ts：走注入监听地址的那一条", () => {
  it("isSelfLoop 端口不同直接放行", () => {
    const prev = snapshotConfig(["host", "port"]);
    try {
      set("host", "127.0.0.1");
      set("port", 10001);
      expect(isSelfLoop("127.0.0.1", 10002, testConfig)).toBe(false);
      expect(isSelfLoop("127.0.0.1", 10001, testConfig)).toBe(true);
      expect(isSelfLoop("localhost", 10001, testConfig)).toBe(true);
    } finally {
      restoreConfig(prev);
    }
  });
});

describe("core/helpers/self-loop 通配监听", () => {
  it("0.0.0.0 视为监听所有接口", () => {
    expect(isSelfLoopAddr("example.com", 8080, "0.0.0.0", 8080)).toBe(true);
  });

  it(":: 与 0.0.0.0 同等（HOST=:: 场景）", () => {
    expect(isSelfLoopAddr("example.com", 8080, "::", 8080)).toBe(true);
  });

  it("0:0:0:0:0:0:0:0 展开形态同等处理", () => {
    expect(isSelfLoopAddr("example.com", 8080, "0:0:0:0:0:0:0:0", 8080)).toBe(true);
  });

  it("端口不同直接放行", () => {
    expect(isSelfLoopAddr("example.com", 8081, "::", 8080)).toBe(false);
  });

  it("具体监听地址需完全匹配（含 localhost 等价）", () => {
    expect(isSelfLoopAddr("127.0.0.1", 8080, "127.0.0.1", 8080)).toBe(true);
    expect(isSelfLoopAddr("localhost", 8080, "127.0.0.1", 8080)).toBe(true);
    expect(isSelfLoopAddr("example.com", 8080, "127.0.0.1", 8080)).toBe(false);
  });
});

describe("core/helpers/self-loop 归一化（v4-mapped / 通配目标 / 尾点）", () => {
  it("v4-mapped IPv6 loopback 与点分形态等价", () => {
    expect(isSelfLoopAddr("::ffff:127.0.0.1", 8080, "127.0.0.1", 8080)).toBe(true);
    expect(isSelfLoopAddr("::ffff:7f00:1", 8080, "localhost", 8080)).toBe(true);
  });

  it("目标是通配地址而监听在 loopback → 自环（connect(0.0.0.0) 实际落到 127.0.0.1）", () => {
    expect(isSelfLoopAddr("0.0.0.0", 8080, "127.0.0.1", 8080)).toBe(true);
    expect(isSelfLoopAddr("::", 8080, "::1", 8080)).toBe(true);
  });

  it("监听具体非 loopback 地址时，通配目标不算自环", () => {
    expect(isSelfLoopAddr("0.0.0.0", 8080, "192.168.1.5", 8080)).toBe(false);
  });

  it("尾点主机名与方括号形态归一后比对", () => {
    expect(isSelfLoopAddr("localhost.", 8080, "127.0.0.1", 8080)).toBe(true);
    expect(isSelfLoopAddr("[::1]", 8080, "::1", 8080)).toBe(true);
  });

  it("%zone 后缀归一后仍与裸地址等价（link-local 场景）", () => {
    expect(isSelfLoopAddr("::1%eth0", 8080, "::1", 8080)).toBe(true);
  });

  it("目标与监听都为空串时按不相等处理，不误判自环", () => {
    expect(isSelfLoopAddr("", 8080, "", 8080)).toBe(false);
  });
});