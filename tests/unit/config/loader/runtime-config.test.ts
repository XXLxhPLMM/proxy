/**
 * `config/runtime-config prepareRuntimeConfigStore`：热改那一半的路径归一 + URL 拆项
 *
 * @description
 * 本档管三件事：路径字段按 `configDir` 归一、`UPSTREAM_URL` 拆项与被覆盖键的 warning、
 * 以及**先 parse 再触碰 target**（非法即整条失败，不半写）。
 * ⚠️ 逐条的「为什么」与变异锁点归**本目录 `AGENTS.md`** 的 ⑥ / ⑩ / ⑪ 与那张对照表。
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadConfig } from "@/config/load.js";
import { prepareRuntimeConfigStore } from "@/config/normalize/index.js";
import { ConfigStore } from "@/config/index.js";
import { parseUpstreamUrl } from "@/config/schema/upstream-url.js";
import { withTmpConfigDir } from "./_config-loader.js";

describe("config/runtime-config", () => {
  it("prepareRuntimeConfigStore 归一化路径并应用 URL 拆项", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore({
        authUsersFile: "users.json",
        upstreamUrl: "https://proxy.example:8443",
        upstreamHost: "ignored.example",
        upstreamPort: 9999,
      });
      const result = prepareRuntimeConfigStore(
        store,
        cwd,
        new Set(["UPSTREAM_HOST", "UPSTREAM_PORT"]),
      );
      expect(result.config.authUsersFile).toBe(path.join(cwd, "users.json"));
      expect(result.config.upstreamHost).toBe("proxy.example");
      expect(result.config.upstreamPort).toBe(8443);
      expect(store.get("authUsersFile")).toBe(path.join(cwd, "users.json"));
      expect(store.get("upstreamHost")).toBe("proxy.example");
      expect(result.warnings[0]).toMatch(/UPSTREAM_HOST/);
      expect(result.warnings[0]).toMatch(/UPSTREAM_PORT/);
    });
  });

  it("非法 URL 拒绝且不半写 store", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore({
        upstreamUrl: "not a url",
        upstreamHost: "keep.example",
      });
      expect(() => prepareRuntimeConfigStore(store, cwd)).toThrow(
        "配置校验失败: UPSTREAM_URL=not a url 非法",
      );
      expect(store.get("upstreamUrl")).toBe("not a url");
      expect(store.get("upstreamHost")).toBe("keep.example");
    });
  });

  /**
   * **缺省值必须能显式写出来**：`UPSTREAM_URL` 的缺省就是空串，故空串是**合法**值。
   * @description 这条曾经反过来：空串被判非法，于是「照抄配置模板就起不来」成为实测事实
   * （`配置校验失败: UPSTREAM_URL= 非法`），而模板里那一行又不能写成生效行 —— 用户就看不见这个
   * 选项（`../unknown-keys/tolerance.test.ts` 的「集合相等」会报缺键）。两个后果同源。
   * 锁点三格：**空串合法**、**空串与不写等价**、**真非法值仍然拒**（第三格防「为了放过空串
   * 把整个校验放松」）。
   */
  it("空串是合法值：与「不写」完全等价，而真非法值仍然拒", async () => {
    await withTmpConfigDir(async (cwd) => {
      expect(parseUpstreamUrl(""), "空串 = 没配（合法）").toBe("");
      expect(parseUpstreamUrl("   "), "纯空白同样 = 没配").toBe("");
      // 「显式空串」与「压根没写」逐字段同值：这一格是本档的核心（不变量是**缺省值必须能显式
      // 写出来**，症状正是这两个形状分叉）。
      //
      // ⚠️ **必须走 `loadConfig` + argv 这条用户真实路径**，不能拿 `new ConfigStore({ upstreamUrl: "" })`
      // 去比：那个构造会经 `inferExplicitlyProvided` 把「显式给了空串」判成「没提供」并回落缺省 ——
      // 于是本档会在**实现其实分叉着**的情况下照样绿（假绿）。argv 里那个 `UPSTREAM_URL=` 才是
      // 模板复制到 `.env` / 命令行之后的真实形状。
      const viaArgv = async (argv: string[]) =>
        (
          await loadConfig({ env: {}, envFiles: [], argv, cwd, skipFileValidation: true })
        ).accessor;
      const absent = await viaArgv([]);
      const blank = await viaArgv(["UPSTREAM_URL="]);
      expect(blank.get("upstreamUrl"), "显式空串的落库值与缺省逐字相同").toBe(
        absent.get("upstreamUrl"),
      );
      expect(blank.get("upstreamHost"), "下游拆项不受影响").toBe(absent.get("upstreamHost"));
      // 反向：显式空串不许**顺带**把真值也放过（同一次调用里两个形状必须给出不同结论）
      expect(await viaArgv(["UPSTREAM_URL=http://h:3128"]).then((a) => a.get("upstreamUrl"))).toBe(
        "http://h:3128",
      );
      expect(() =>
        prepareRuntimeConfigStore(new ConfigStore({ upstreamUrl: "not a url" }), cwd),
      ).toThrow(/UPSTREAM_URL=not a url 非法/);
      expect(() =>
        prepareRuntimeConfigStore(new ConfigStore({ upstreamUrl: "http://h/path" }), cwd),
      ).toThrow(/UPSTREAM_URL/);
    });
  });
});