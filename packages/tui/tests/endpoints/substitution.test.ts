/**
 * `endpointPath` 的 `:username` 代入：逐段编码、穿越边界、缺段即抛
 *
 * @description
 * 判的是 `@/lib/http.js:endpointPath` 这个**函数**（表的自洽性在 `table.test.ts`）。所有判据都只
 * 作用在**被代入的那一段**上，理由在 `./AGENTS.md`。
 *
 * @module tests/endpoints
 */

import { describe, expect, it } from "vitest";
import { type Endpoint } from "@/api/index.js";
import { endpointPath } from "@/lib/http.js";

const USER_TEMPLATE = "/api/users/:username";
const USER_PREFIX = "/api/users/";

/** `endpointPath` 的结果里 `:username` 那一段（判据只作用在**被代入的那一段**上） */
function segmentOf(path: string): string {
  expect(path.startsWith(USER_PREFIX), `${path} 不以 ${USER_PREFIX} 开头`).toBe(true);
  return path.slice(USER_PREFIX.length);
}

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
