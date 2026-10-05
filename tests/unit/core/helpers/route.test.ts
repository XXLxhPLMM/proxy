/**
 * `core/helpers/route.ts`：注入访问控制端口后的路由判定
 *
 * @description
 * 证明 `resolveRoute` 真的读了注入的访问控制端口与模式，而不是全局值 —— 「多 Runtime 隔离」
 * 在路由侧的最小可验证单元。判据口径：换掉注入的那一份，判定结果就整个反过来。形参从
 * `ConfigAccessor` 换成 `RoutePolicy = { access, mode }`；`resolveForwardTargets` 的
 * `dial` / `dest` / `route` 三个出口也在这一档验。
 *
 * ⚠️ 全局 `proxyMode` / `port` **全程不被改写**这件事本身是断言的一部分：隔离性判据是
 * 「换掉注入的那一份就换掉真相源」，而全局那份全程不变正是排除「其实读的还是全局」的唯一办法。
 */

import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { isSelfLoop, resolveForwardTargets, resolveRoute } from "@/core/helpers/index.js";
import { createFileAccessControl } from "@/core/access-control.js";
import { ConfigStore, configAccessorFromStore } from "@/config/index.js";
import { get, set, testConfig, restoreConfig, snapshotConfig } from "../../../helpers/config.js";

describe("core/helpers/route.ts：注入访问控制端口后的路由判定", () => {
  it("resolveRoute 走注入的 access + mode：私有 store 声明 client 即走上游分支", () => {
    const prev = snapshotConfig(["proxyMode"]);
    try {
      // 全局维持 server：按 server 档必得直连（缺省行为不变）
      set("proxyMode", "server");
      const globalAccess = createFileAccessControl(testConfig);
      expect(resolveRoute({ host: "a.example.com", port: 443 }, { access: globalAccess, mode: "server" })).toEqual({
        mode: "server",
        route: "direct",
      });

      // 私有 store：proxyMode=client + aclFile 指向不存在路径（名单全空 → 走上游）
      const store = new ConfigStore({
        proxyMode: "client",
        upstreamHost: "10.9.9.9",
        upstreamPort: 8123,
        aclFile: path.join(os.tmpdir(), "proxy-helpers-missing-acl.json"),
      });
      const accessor = configAccessorFromStore(store);
      const policy = { access: createFileAccessControl(accessor), mode: "client" as const };
      expect(resolveRoute({ host: "a.example.com", port: 443 }, policy)).toEqual({
        mode: "client",
        route: "upstream",
      });

      // 同一判定经 resolveForwardTargets：dial 应指向该 store 的上游，dest 仍是真实目标。
      // 上游地址从「访问器现读」收成显式的 DialPlan 形参（server 模式下这组地址根本不存在，
      // 塞进 policy 等于逼每个 server 模式部署编一个用不到的假上游）。
      const t = resolveForwardTargets("http://a.example.com/x", "a.example.com", policy, {
        upstream: { host: "10.9.9.9", port: 8123 },
      });
      expect(t?.dial).toEqual({ host: "10.9.9.9", port: 8123, path: "http://a.example.com/x" });
      expect(t?.dest).toEqual({ host: "a.example.com", port: 80, path: "/x" });
      expect(t?.route).toEqual({ mode: "client", route: "upstream" });

      // 关键：全局 proxyMode 全程未被改写，路由确实读的是注入的那份策略
      expect(get("proxyMode")).toBe("server");
    } finally {
      restoreConfig(prev);
    }
  });

  it("isSelfLoop 走注入的监听地址：私有 store 换端口后自环判定随之改变", () => {
    const prev = snapshotConfig(["host", "port"]);
    try {
      set("host", "127.0.0.1");
      set("port", 10001);
      // 全局监听 127.0.0.1:10001 → 指回自己是自环
      expect(isSelfLoop("127.0.0.1", 10001, testConfig)).toBe(true);
      expect(isSelfLoop("127.0.0.1", 10002, testConfig)).toBe(false);

      // 私有 store 监听 127.0.0.1:20001：同一对地址的判定整个反过来
      const accessor = configAccessorFromStore(new ConfigStore({ host: "127.0.0.1", port: 20001 }));
      expect(isSelfLoop("127.0.0.1", 10001, accessor)).toBe(false);
      expect(isSelfLoop("127.0.0.1", 20001, accessor)).toBe(true);

      // 全局判定未被改写
      expect(get("port")).toBe(10001);
    } finally {
      restoreConfig(prev);
    }
  });
});