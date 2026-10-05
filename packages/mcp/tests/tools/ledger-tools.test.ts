/**
 * @fileoverview 台账类工具那一族 —— 从模型的角度看这一层的四条纪律
 * @module tests/tools/ledger-tools
 * @description
 * 这一档断的是**工具面**（不是 `@/store/` 那一层）：模型调一次拿到什么。四条各自有代价：
 *
 * ① 返回值里**永远没有** key 的明文（哪怕刚 add 完）
 * ② 没激活时报错**带出路**（`env_activate` / `managers` 参数）
 * ③ ⚠️ 重名 / 空成员 / 悬空 id 都在**写面**拒掉，不是运行时才炸
 * ④ ⚠️ 激活是**进程内存**态：deactivate 之后 `env_list` 立刻读得到 null
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOLS } from "../../src/tools/index.js";
import { cleanupHomes, callTool, tempHome, toolNamed } from "../shared.js";

/** ⚠️ 那十二个「要动哪几个」的工具（**不是**「台账里有哪些」那一族） */
const OPERATION_TOOL_NAMES = [
  "status",
  "config",
  "account_list",
  "account_get",
  "account_create",
  "account_update",
  "account_delete",
  "acl_get",
  "acl_add",
  "acl_remove",
  "usage_list",
  "usage_get",
] as const;

/** 判据是**这张表**，不是「有没有 managers 形参」—— 台账族有一个同名的、语义完全不同的形参 */
function isTargetPicker(name: string): boolean {
  return (OPERATION_TOOL_NAMES as readonly string[]).includes(name);
}

beforeEach(() => {
  tempHome();
});

afterEach(() => {
  cleanupHomes();
});

async function addTwo(): Promise<void> {
  const a = await callTool("manager_add", {
    name: "生产",
    baseUrl: "http://10.0.0.1:8080",
    key: "secret-one",
  });
  const b = await callTool("manager_add", {
    name: "预发",
    baseUrl: "http://10.0.0.2:8080",
    key: "secret-two",
  });
  expect(a.error).toBeNull();
  expect(b.error).toBeNull();
}

describe("① key 的明文一次都不许出现在返回值里", () => {
  it("manager_add 的返回值不含明文 key", async () => {
    const result = await callTool("manager_add", {
      name: "n",
      baseUrl: "http://a:1",
      key: "super-secret-value",
    });
    expect(result.text).not.toContain("super-secret-value");
    expect(result.text).toContain("***");
  });

  it("manager_list 不含任何一条的明文 key", async () => {
    await addTwo();
    const result = await callTool("manager_list");
    expect(result.text).not.toContain("secret-one");
    expect(result.text).not.toContain("secret-two");
  });

  it("⚠️ manager_update 换了 key 之后返回值仍不含新 key", async () => {
    await addTwo();
    const result = await callTool("manager_update", { id: "m", key: "brand-new-secret" });
    expect(result.error).toBeNull();
    expect(result.text).not.toContain("brand-new-secret");
  });

  it("env_list 与 env_create 同样不含（它们连 key 都不该碰到）", async () => {
    await addTwo();
    await callTool("env_create", { name: "prod", managers: ["m"] });
    expect((await callTool("env_list")).text).not.toContain("secret");
    expect((await callTool("env_create", { name: "p2", managers: ["m"] })).text).not.toContain(
      "secret",
    );
  });
});

describe("② 空清单与没激活都要说清出路", () => {
  it("manager_list 在空清单时给出下一步", async () => {
    const result = await callTool("manager_list");
    expect(result.text).toContain("manager_add");
    expect(result.text).toContain('"count": 0');
  });

  it("env_list 在空清单时给出下一步", async () => {
    expect((await callTool("env_list")).text).toContain("env_create");
  });

  it("⚠️ 操作类工具在没激活时报错，且文案点名两条出路", async () => {
    await addTwo();
    const result = await callTool("account_list");
    expect(result.error).toMatch(/没有激活的环境/);
    expect(result.error).toMatch(/env_activate/);
    expect(result.error).toMatch(/managers/);
  });

  it("env_activate 一个不存在的环境 ⇒ 报错并列出现有的", async () => {
    await addTwo();
    await callTool("env_create", { name: "prod", managers: ["m"] });
    const result = await callTool("env_activate", { name: "ghost" });
    expect(result.error).toMatch(/没有叫 ghost 的环境/);
    expect(result.error).toMatch(/prod/);
  });
});

describe("③ 写面当场拒，而不是运行时才炸", () => {
  it("环境重名当场拒，且原有那个没被动过", async () => {
    await addTwo();
    await callTool("env_create", { name: "prod", managers: ["m"] });
    const again = await callTool("env_create", { name: "prod", managers: ["m-2"] });
    expect(again.error).toMatch(/已经有叫 prod/);
    const listed = JSON.parse((await callTool("env_list")).text) as {
      environments: { name: string; managers: string[] }[];
    };
    expect(listed.environments).toHaveLength(1);
    expect(listed.environments[0]?.managers).toEqual(["m"]);
  });

  it("成员 id 未登记当场拒，并点名是哪些", async () => {
    await addTwo();
    const result = await callTool("env_create", { name: "e", managers: ["m", "ghost"] });
    expect(result.error).toMatch(/ghost/);
  });

  it("空成员当场拒（⚠️ 拒在**形参读取**那一档，而写面的那道是第二道 —— 删掉前者只会让请求晚一步才失败）", async () => {
    await addTwo();
    expect((await callTool("env_create", { name: "e", managers: [] })).error).toMatch(
      /非空的字符串数组/,
    );
    expect((await callTool("env_create", { name: "e", managers: ["m"] })).error).toBeNull();
  });

  it("⚠️ 删一个还被引用的 manager 当场拒，点名是哪个环境", async () => {
    await addTwo();
    await callTool("env_create", { name: "prod", managers: ["m"] });
    const result = await callTool("manager_remove", { id: "m" });
    expect(result.error).toMatch(/prod/);
    expect(result.error).toMatch(/env_update/);
  });

  it("正在激活的环境不许删，且文案说清先做什么", async () => {
    await addTwo();
    await callTool("env_create", { name: "prod", managers: ["m"] });
    await callTool("env_activate", { name: "prod" });
    const result = await callTool("env_remove", { name: "prod" });
    expect(result.error).toMatch(/env_deactivate/);
  });

  it("空 patch 的 manager_update 当场拒", async () => {
    await addTwo();
    expect((await callTool("manager_update", { id: "m" })).error).toMatch(/至少要给一个/);
  });
});

describe("④ 激活是进程内存态", () => {
  it("activate 之后 env_list 读得到，deactivate 之后立刻读不到", async () => {
    await addTwo();
    await callTool("env_create", { name: "prod", managers: ["m"] });
    expect(JSON.parse((await callTool("env_list")).text).activeEnv).toBeNull();

    const on = await callTool("env_activate", { name: "prod" });
    expect(on.error).toBeNull();
    expect(JSON.parse((await callTool("env_list")).text).activeEnv).toBe("prod");

    await callTool("env_deactivate");
    expect(JSON.parse((await callTool("env_list")).text).activeEnv).toBeNull();
  });

  it("⚠️ 激活的返回值就把成员列出来（模型不该为「我激活了什么」再调一次）", async () => {
    await addTwo();
    await callTool("env_create", { name: "prod", managers: ["m", "m-2"] });
    const parsed = JSON.parse((await callTool("env_activate", { name: "prod" })).text) as {
      managers: string[];
    };
    expect(parsed.managers).toEqual(["m", "m-2"]);
  });

  it("env_list 逐个标出哪个正被激活", async () => {
    await addTwo();
    await callTool("env_create", { name: "a", managers: ["m"] });
    await callTool("env_create", { name: "b", managers: ["m-2"] });
    await callTool("env_activate", { name: "b" });
    const parsed = JSON.parse((await callTool("env_list")).text) as {
      environments: { name: string; active: boolean }[];
    };
    expect(parsed.environments.map((one) => one.active)).toEqual([false, true]);
  });

  it("deactivate 在没激活时是成功的 no-op（幂等）", async () => {
    const first = await callTool("env_deactivate");
    const second = await callTool("env_deactivate");
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(JSON.parse(second.text).activeEnv).toBeNull();
  });
});

describe("工具表本身", () => {
  it("台账 10 个 + 操作 12 个，一个不多一个不少", () => {
    expect(TOOLS).toHaveLength(22);
  });

  it("⚠️ 名字唯一（重复名会让 tools/list 出现两份，而客户端按名调用只中一个）", () => {
    const names = TOOLS.map((one) => one.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("每个工具都有名字、说明与一张入参表（说明短于 10 字 ⇒ 模型只能靠猜）", () => {
    for (const tool of TOOLS) {
      expect(tool.name, "name").not.toBe("");
      expect(tool.description.length, `${tool.name} 的说明`).toBeGreaterThanOrEqual(10);
      expect(tool.inputSchema.type, `${tool.name} 的 inputSchema`).toBe("object");
    }
  });

  it("⚠️ 十二个**操作类**工具的 managers 说明逐字相同（同名形参两种说法 ⇒ 模型照宽松那份填）", () => {
    const texts = new Set(
      OPERATION_TOOL_NAMES.map((name) => toolNamed(name).inputSchema.properties["managers"]?.description),
    );
    expect(texts.size).toBe(1);
    expect([...texts][0]).toContain("当前激活的环境");
    expect([...texts][0]).toContain("不与环境合并");
  });

  it("⚠️ `managers` 这一格**恒不在** required 里（缺省即「当前环境」）", () => {
    // ⚠️ 判据是 `inputSchema` 里那个形参**名**：`env_create` 有一个**必填**的 `managers`
    // （成员 id 数组），而它不是「要动哪几个」那一格 —— 按名字断言会把两个同名形参混为一谈
    for (const tool of TOOLS) {
      const described = tool.inputSchema.properties["managers"];
      if (described === undefined) {
        continue;
      }
      if (isTargetPicker(tool.name)) {
        expect(tool.inputSchema.required ?? [], `${tool.name} 的 required`).not.toContain("managers");
      }
    }
  });

  it("⚠️ 台账类工具的 managers（成员 id 数组）是真的必填 —— 它是另一个形参", () => {
    for (const name of ["env_create", "env_update"]) {
      const tool = toolNamed(name);
      expect(tool.inputSchema.required, `${name} 的 required`).toContain("managers");
      expect(tool.inputSchema.properties["managers"]?.description).toContain("id");
    }
  });

  it("闭集形参在 schema 里带 enum（模型照着填，而不是靠猜）", () => {
    const add = toolNamed("acl_add");
    expect(add.inputSchema.properties["group"]?.enum).toEqual(["clientip", "target", "upstream"]);
    expect(add.inputSchema.properties["list"]?.enum).toEqual(["whitelist", "blacklist"]);
    expect(add.inputSchema.required).toEqual(["group", "list", "entry"]);
  });

  it("写操作的必填项与读操作不同（account_update 只要 username，create 还要 password）", () => {
    expect(toolNamed("account_update").inputSchema.required).toEqual(["username"]);
    expect(toolNamed("account_create").inputSchema.required).toEqual(["username", "password"]);
  });
});
