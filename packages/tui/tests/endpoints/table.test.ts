/**
 * 端点表的自洽性：条数、`(method, path)` 无重复、形态合法、模板集合封闭
 *
 * @description
 * 判的是 `ENDPOINTS` 这张**字面量**（`@/api/endpoints/` 装配成的那条平表）；`:username` 代入的
 * 行为在 `substitution.test.ts`。⚠️ 路径集合与仓库根那道牙各管一半，判据与不变量在 `./AGENTS.md`。
 *
 * @module tests/endpoints
 */

import { describe, expect, it } from "vitest";
import { ENDPOINTS } from "@/api/index.js";

/** 表里出现过的四种方法（表外的动词在服务端一律 405，故它们不该出现在这张表里） */
const METHODS = ["GET", "POST", "PUT", "DELETE"];

describe("端点表：完整、自洽、形态合法", () => {
  it("恰好 12 条（这是「本包覆盖控制面全部端点」的那份清单）", () => {
    expect(ENDPOINTS).toHaveLength(12);
  });

  it("`(method, path)` 组合无重复（重复会让「哪一条生效」取决于数组顺序）", () => {
    const pairs = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    const distinct = new Set(pairs);
    // 防假绿：distinct 恒等于一个空集合时这条也成立，故与条数绑在一起断言
    expect(distinct.size).toBe(pairs.length);
    expect(distinct.size).toBe(ENDPOINTS.length);
  });

  it("方法只在四种之内，且路径一律以 `/api/` 开头（形态错的东西一律当场拒）", () => {
    for (const endpoint of ENDPOINTS) {
      expect(METHODS, `${endpoint.method} 不在四种方法内`).toContain(endpoint.method);
      expect(endpoint.path, `${endpoint.path} 不在 /api/ 下`).toMatch(/^\/api\//);
      expect(endpoint.path.endsWith("/"), `${endpoint.path} 带尾斜杠`).toBe(false);
      expect(endpoint.path, `${endpoint.path} 含空格`).not.toMatch(/\s/);
    }
  });

  it("含路径参数的模板只有两种（新增一种模板必须连带改调用点，而不是让它悄悄长出来）", () => {
    const templates = new Set(ENDPOINTS.filter((e) => e.path.includes(":")).map((e) => e.path));
    expect([...templates].sort()).toEqual(["/api/usage/:username", "/api/users/:username"]);
    for (const endpoint of ENDPOINTS) {
      expect(endpoint.path.includes(":"), `${endpoint.path} 的占位符名不是 :username`).toBe(
        endpoint.path.includes(":username"),
      );
    }
  });

  it("同一路径上的多条只差方法（不重复的是**组合**，路径本身可以重复）", () => {
    const byPath = new Map<string, string[]>();
    for (const endpoint of ENDPOINTS) {
      byPath.set(endpoint.path, [...(byPath.get(endpoint.path) ?? []), endpoint.method]);
    }
    for (const [path, methods] of byPath) {
      expect(new Set(methods).size, `${path} 上有重复方法`).toBe(methods.length);
    }
    // 防假绿：路径一个都不重复的话上面那条循环空转，故点名当前确实存在的两条多方法路径
    expect(byPath.get("/api/users")?.sort()).toEqual(["GET", "POST"]);
    expect(byPath.get("/api/acl")?.sort()).toEqual(["DELETE", "GET", "POST"]);
  });
});
