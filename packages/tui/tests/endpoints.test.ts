/**
 * `@/api/endpoints` — 端点表与 `:username` 代入的单测
 *
 * @description
 * ## 本档盯的事故（按「错了会怎样」排序）
 *
 * 1. **端点表少一条 / 多一条 / 拼错方法名**。表是本包对控制面契约的完整声明；少一条 = 本包少
 *    一个功能，多一条 = 本包对着一个永远 404 的路径发请求，而两侧都「绿」。牙齿在仓库根的
 *    `tests/unit/manager-tui-contract.test.ts`（从两侧源码现取后比集合）；本档只锁本包这一侧的
 *    自洽性（条数、`(method, path)` 不重复、形态合法）。
 * 2. **`:username` 不编码 = 路径穿越 / 请求行被截断**。`/` 多切一段、`?` 起查询串、`#` 起片段
 *    —— 后两者会让服务端**根本收不到**那段用户名，而症状是「界面说没这个账号」。
 * 3. **模板缺 `:username` 段时静默原样返回**。调用方拼错模板时，返回值长得完全像一个正常路径，
 *    于是错误一路走到服务端才以 404 的形态出现，指向一个无辜的端点。
 *
 * ## 判据为什么这么定
 *
 * - **逐段判**而不是对整条路径判裸字符：路径本身必然含 `/`（`/api/users/...`），对整条判会让
 *   这条断言恒红 —— 恒红的断言等于没有断言（根 `AGENTS.md`「写护栏时」）。
 * - **编码结果与 `encodeURIComponent` 逐字比对**：不抄一份自己算的期望串（那就是第二份判据），
 *   直接断言 `encodeURIComponent(username)` 出现在结果里，且该段不含裸分隔符。
 * - **`..` 与 `:username` 后缀两处标注为已知缺口**并锁**实测形态**：本档不把待裁决的分歧写成
 *   正向契约，也不用一条「反正会红」的断言假装护栏在生效（判据锚点必须锚在今天仍然存在的形状上）。
 *
 * ## 防假绿的位置
 *
 * - 「`(method, path)` 无重复」用 `Set.size === length`；**同时**独立断言条数是 12。少一个断言时，
 *   另一条仍在；两条都在时，加一条重复项会让两条同时红，而不是靠某一条偶然生效。
 * - 「模板缺段即抛错」断言的是**抛错**而不是错误文案：文案可以被重写，抛不抛是契约。
 *
 * @module tests/endpoints
 */

import { describe, expect, it } from "vitest";
import { ENDPOINTS, endpointPath, type Endpoint } from "@/api/index.js";

const USER_TEMPLATE = "/api/users/:username";
const USER_PREFIX = "/api/users/";

/** 表里出现过的四种方法（表外的动词在服务端一律 405，故它们不该出现在这张表里） */
const METHODS = ["GET", "POST", "PUT", "DELETE"];

/** `endpointPath` 的结果里 `:username` 那一段（判据只作用在**被代入的那一段**上） */
function segmentOf(path: string): string {
  expect(path.startsWith(USER_PREFIX), `${path} 不以 ${USER_PREFIX} 开头`).toBe(true);
  return path.slice(USER_PREFIX.length);
}

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

describe("`:username` 代入", () => {
  it("正常用户名逐字代入", () => {
    expect(endpointPath(USER_TEMPLATE, "alice")).toBe("/api/users/alice");
  });

  it("白名单字符集内的成员逐字保留（编码不许顺手改变合法名）", () => {
    for (const name of ["a.b_c-d", "A1", "..b", "a~b"]) {
      const path = endpointPath(USER_TEMPLATE, name);
      // `~` 在 encodeURIComponent 的「不转义」清单里，其余四个也不是分隔符
      expect(segmentOf(path), `${name} 被无谓地编码了`).toBe(name);
    }
  });

  it("**防路径穿越**：`/` `?` `#` 逐个编码掉（不留裸字符）", () => {
    // 服务端在 `decodeURIComponent` 之后才判字符白名单（`routes/input.ts`），本端不编码就是
    // 把穿越交给运气；而 `?` / `#` 更狠 —— 它们会**改写请求行**，服务端压根收不到那段名字。
    const attacks: Array<[string, string]> = [
      ["../../etc/passwd", "..%2F..%2Fetc%2Fpasswd"],
      ["a/b", "a%2Fb"],
      ["a?b=c", "a%3Fb%3Dc"],
      ["a#b", "a%23b"],
      ["al ice", "al%20ice"],
      ["a\\b", "a%5Cb"],
    ];
    for (const [raw, expected] of attacks) {
      const path = endpointPath(USER_TEMPLATE, raw);
      const segment = segmentOf(path);
      expect(segment, `${JSON.stringify(raw)} 的编码结果不对`).toBe(expected);
      expect(segment, `${JSON.stringify(raw)} 留了裸 /`).not.toContain("/");
      expect(path, `${JSON.stringify(raw)} 留了裸 ?（会起查询串）`).not.toContain("?");
      expect(path, `${JSON.stringify(raw)} 留了裸 #（会起片段）`).not.toContain("#");
      // 逐字等于 encodeURIComponent：判据不抄第二份，自己重算一遍
      expect(segment).toBe(encodeURIComponent(raw));
    }
  });

  it("空格变 `%20` 而不是 `+`（`+` 只在查询串的表单解码里才是空格）", () => {
    expect(segmentOf(endpointPath(USER_TEMPLATE, "a b c"))).toBe("a%20b%20c");
    expect(endpointPath(USER_TEMPLATE, "a b")).not.toContain("+");
  });

  it("百分号被编码（防「双重解码」把 `%2F` 还原成裸分隔符）", () => {
    expect(segmentOf(endpointPath(USER_TEMPLATE, "a%2Fb"))).toBe("a%252Fb");
  });

  it("非 ASCII 按 UTF-8 百分号编码（用户名可以是中文）", () => {
    expect(segmentOf(endpointPath(USER_TEMPLATE, "张三"))).toBe(encodeURIComponent("张三"));
  });

  it("⚠️ 已知缺口：`..` **不被**本档中和（`encodeURIComponent` 不转义 `.`）", () => {
    // 真正的闸门在服务端：`requireSafeUsername` 逐条拒 `..` / `.` / 路径分隔符
    // （`routes/input.ts`）。本档锁的是**实测形态**而不是「本端已挡住」的承诺 ——
    // 有人给本端补上点段收窄时这条会红，那时把它改成正向断言。
    expect(segmentOf(endpointPath(USER_TEMPLATE, ".."))).toBe("..");
    // 且这条路径经 `fetch` 的 URL 解析后会被**改写**成 `/api/`（点段被消解）：
    // 那不是穿越（服务端只会看到一个不存在的端点），但症状是 404，值得在事故单里认出来。
    expect(new URL(`http://127.0.0.1:3010${endpointPath(USER_TEMPLATE, "..")}`).pathname).toBe(
      "/api/",
    );
  });

  it("同一段里出现多次同名占位符时全部代入（逐段替换，不只第一处）", () => {
    const template: Endpoint["path"] = "/api/users/:username/acl/:username";
    expect(endpointPath(template, "a/b")).toBe("/api/users/a%2Fb/acl/a%2Fb");
  });

  it("模板里没有 `:username` 段 ⇒ 抛错（不是静默原样返回）", () => {
    // 原样返回的失败模式：返回值长得完全像一个正常路径，于是错误一路走到服务端才以「某个无辜
    // 端点 404」的形态出现。故这里断言的是**抛错**这个事实，不锁文案。
    for (const template of ["/api/status", "/api/users", "/api/acl", "", "/api/users/"]) {
      expect(() => endpointPath(template, "alice"), `${template} 应当抛错`).toThrow();
    }
  });

  it("占位符是 `:username` 的**超集**时（`:usernames`）⇒ 抛错，不静默原样返回", () => {
    // ⚠️ 守卫与替换必须用**同一条**判据（都是「整段等于 `:username`」）。用子串判的话，
    // `:usernames` 会通过守卫却原样返回 —— 返回值长得完全像一个正常路径，于是带着占位符的
    // URL 一路走到服务端才以「某个无辜端点 404」的形态出现。
    expect(() => endpointPath("/api/users/:usernames", "alice")).toThrow();
    expect(() => endpointPath("/api/users/x:username", "alice")).toThrow();
  });

  it("`..` 会原样穿过本端（真闸门在服务端），但症状是 404 而不是 400", () => {
    // `encodeURIComponent` 不转义 `.`，所以 `..` 到得了路径里。**这一档是对的**：真正的闸门
    // 是服务端 `requireSafeUsername`（字符集白名单之外直接 400），本端再发明一份字符集会
    // 与服务端漂（而且一定漂在某处）。
    // 锁它是为了让人知道**排查方向**：`fetch` 的 URL 解析把 `/api/users/..` 消解成 `/api/`，
    // 于是症状是 404 —— 先怀疑地址，别怀疑权限，更别以为本端漏了编码。
    expect(endpointPath("/api/users/:username", "..")).toBe("/api/users/..");
  });
});

describe("两种路径模板都能代入", () => {
  it("`/api/usage/:username` 走同一套编码（读面与写面的穿越边界必须一样宽）", () => {
    expect(endpointPath("/api/usage/:username", "a/b")).toBe("/api/usage/a%2Fb");
    expect(endpointPath("/api/usage/:username", "al ice")).toBe("/api/usage/al%20ice");
  });
});
