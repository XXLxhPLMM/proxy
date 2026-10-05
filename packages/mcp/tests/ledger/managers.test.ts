/**
 * @fileoverview 台账两档共用的一条不变量：**坏内容即拒，绝不降级成空台账**
 * @module tests/ledger/managers
 * @description
 * 降级成空台账是最坏的一种「体贴」：调用方「重新加一遍」就会拿那份空台账覆盖掉存着 key 的
 * 那一份 —— 而 key 是明文存的，覆盖掉等于凭据蒸发且无人察觉。故这一档断言的是「**拒**」，
 * 且断言拒完之后**盘上那份数据逐字未变**。
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateEnv,
  addManager,
  createEnv,
  deactivateEnv,
  readEnvs,
  readManagers,
  redactManager,
  removeEnv,
  removeManager,
  setEnvMembers,
  updateManager,
} from "../../src/store/index.js";
import { McpError } from "../../src/utils/errors.js";
import { cleanupHomes, homeFile, tempHome } from "../shared.js";

let home = "";

beforeEach(() => {
  home = tempHome();
});

afterEach(() => {
  cleanupHomes();
});

function seed(): void {
  addManager(home, { name: "生产", baseUrl: "http://10.0.0.1:8080", key: "k1" });
  addManager(home, { name: "预发", baseUrl: "http://10.0.0.2:8080", key: "k2" });
}

describe("空台账", () => {
  it("两份文件都不存在时读到空清单，且不因此创建它们", () => {
    expect(readManagers(home)).toEqual([]);
    expect(readEnvs(home)).toEqual([]);
    expect(() => homeFile(home, "managers.json")).not.toThrow();
    expect(readManagers(home)).toEqual([]);
  });

  it("id 由名字的 slug 递增避让产生（同样输入给同样 id）", () => {
    seed();
    expect(readManagers(home).map((one) => one.id)).toEqual(["m", "m-2"]);
    addManager(home, { name: "生产", baseUrl: "http://10.0.0.3:8080", key: "k3" });
    expect(readManagers(home).map((one) => one.id)).toEqual(["m", "m-2", "m-3"]);
  });

  it("ASCII 名给出的 id 就是那个 slug 的小写形态", () => {
    addManager(home, { name: "Prod Cluster 01", baseUrl: "http://a:1", key: "k" });
    expect(readManagers(home)[0]?.id).toBe("prod-cluster-01");
  });
});

describe("坏内容即拒", () => {
  it("managers.json 不是合法 JSON ⇒ 抛，且盘上那份逐字未变", () => {
    seed();
    const before = readFile(home, "managers.json");
    writeFile(home, "managers.json", "{ 不是 json");
    expect(() => readManagers(home)).toThrow(McpError);
    expect(readFile(home, "managers.json")).toBe("{ 不是 json");
    expect(before).not.toBe("{ 不是 json");
  });

  it("缺 key 字段 ⇒ 抛（而不是把 key 当空串放行）", () => {
    writeFile(home, "managers.json", JSON.stringify({ managers: [{ id: "a", name: "n", baseUrl: "http://a" }] }));
    expect(() => readManagers(home)).toThrow(/第 1 条的 key/);
  });

  it("顶层不是对象 ⇒ 抛", () => {
    writeFile(home, "managers.json", "[]");
    expect(() => readManagers(home)).toThrow(McpError);
  });

  it("envs.json 里 managers 不是字符串数组 ⇒ 抛", () => {
    writeFile(home, "envs.json", JSON.stringify({ environments: [{ name: "e", managers: [1] }] }));
    expect(() => readEnvs(home)).toThrow(/字符串 id/);
  });
});

describe.skipIf(process.platform === "win32")("key 的防线 · mode 位", () => {
  it("目录 0700、文件 0600（token 与 key 就落在这些文件里）", () => {
    seed();
    expect(modeOf(homeFile(home, "managers.json"))).toBe("600");
    expect(modeOf(path.dirname(homeFile(home, "managers.json")))).toBe("700");
  });
});

describe("key 的防线", () => {
  it("掩码出口是唯一出口：读回的是 ***，且不泄露长度", () => {
    seed();
    const view = redactManager(readManagers(home)[0]!);
    expect(view.key).toBe("***");
    addManager(home, { name: "短", baseUrl: "http://x:1", key: "k" });
    addManager(home, { name: "长", baseUrl: "http://x:2", key: "k".repeat(200) });
    const keys = readManagers(home).map((one) => redactManager(one).key);
    expect(new Set(keys).size).toBe(1);
  });

  it("key 的两端空白被 trim（对面比的是摘要，而带空白的那个永远对不上）", () => {
    addManager(home, { name: "n", baseUrl: "http://a:1", key: "  s3cr3t  " });
    expect(readManagers(home)[0]?.key).toBe("s3cr3t");
  });

  it("空 key 拒（那是「没有任何凭据可比」）", () => {
    expect(() => addManager(home, { name: "n", baseUrl: "http://a:1", key: "   " })).toThrow(
      /不能为空/,
    );
  });
});

describe("改与删", () => {
  it("id 不可改：改名字后 id 逐字不变", () => {
    seed();
    updateManager(home, "m", { name: "新名字" });
    expect(readManagers(home)[0]).toMatchObject({ id: "m", name: "新名字" });
  });

  it("改没给的字段保持原样（没给 ≠ 清空）", () => {
    seed();
    updateManager(home, "m", { name: "改名" });
    expect(readManagers(home)[0]).toMatchObject({ baseUrl: "http://10.0.0.1:8080", key: "k1" });
  });

  it("空 patch 拒", () => {
    seed();
    expect(() => updateManager(home, "m", {})).toThrow(/至少要给一个/);
  });

  it("改不存在的 id 报的是「没有这个 id」而不是静默新建", () => {
    seed();
    expect(() => updateManager(home, "nope", { name: "x" })).toThrow(/没有 id 为 nope/);
    expect(readManagers(home)).toHaveLength(2);
  });

  it("删不存在的 id 抛（⚠️ 与「成功的 no-op」不同：那是删环境成员，这里是删一条登记）", () => {
    seed();
    expect(() => removeManager(home, "nope")).toThrow(/没有 id 为 nope/);
  });

  it("⚠️ 还被环境引用的 manager 不许删，且点名是哪个环境", () => {
    seed();
    createEnv(home, { name: "prod", managers: ["m"] });
    expect(() => removeManager(home, "m")).toThrow(/prod/);
    expect(readManagers(home)).toHaveLength(2);
    setEnvMembers(home, "prod", ["m-2"]);
    expect(() => removeManager(home, "m")).not.toThrow();
    expect(readManagers(home).map((one) => one.id)).toEqual(["m-2"]);
  });
});

describe("地址归一", () => {
  it("无 scheme 补 http，尾斜杠去掉", () => {
    addManager(home, { name: "n", baseUrl: "10.0.0.1:8080/", key: "k" });
    expect(readManagers(home)[0]?.baseUrl).toBe("http://10.0.0.1:8080");
  });

  it("只认 http / https", () => {
    expect(() => addManager(home, { name: "n", baseUrl: "file:///etc/passwd", key: "k" })).toThrow(
      /只支持 http/,
    );
  });

  it("空地址与带控制字符的地址都拒", () => {
    expect(() => addManager(home, { name: "n", baseUrl: "  ", key: "k" })).toThrow(/不能为空/);
    expect(() => addManager(home, { name: "n", baseUrl: "http://a:1\r\nX: 1", key: "k" })).toThrow(
      /控制字符/,
    );
  });
});

describe("激活状态只在内存", () => {
  it("envs.json 里没有任何一处记录激活", () => {
    seed();
    createEnv(home, { name: "prod", managers: ["m"] });
    activateEnv("prod");
    expect(readFile(home, "envs.json")).not.toContain("prod\":" + ' "active"');
    expect(readFile(home, "envs.json")).not.toContain("activeEnv");
  });

  it("正在激活的环境不许删", () => {
    seed();
    createEnv(home, { name: "prod", managers: ["m"] });
    activateEnv("prod");
    expect(() => removeEnv(home, "prod")).toThrow(/正在被激活/);
    deactivateEnv();
    expect(() => removeEnv(home, "prod")).not.toThrow();
  });

  it("环境重名拒（激活靠名字，重名会让「哪一个」取决于数组顺序）", () => {
    seed();
    createEnv(home, { name: "prod", managers: ["m"] });
    expect(() => createEnv(home, { name: "prod", managers: ["m-2"] })).toThrow(/已经有叫/);
  });

  it("成员 id 必须已登记，且**点名**是哪些不存在的", () => {
    seed();
    expect(() => createEnv(home, { name: "e", managers: ["m", "ghost"] })).toThrow(/ghost/);
  });

  it("空成员数组拒（空环境让「激活它」等于什么也不做）", () => {
    seed();
    expect(() => createEnv(home, { name: "e", managers: [] })).toThrow(/至少要有一个/);
  });

  it("重复成员拒", () => {
    seed();
    expect(() => createEnv(home, { name: "e", managers: ["m", "m"] })).toThrow(/两次/);
  });
});

function readFile(homeDir: string, file: string): string {
  return fs.readFileSync(homeFile(homeDir, file), "utf8");
}

function writeFile(homeDir: string, file: string, text: string): void {
  fs.mkdirSync(path.join(homeDir, ".swain-proxy"), { recursive: true });
  fs.writeFileSync(homeFile(homeDir, file), text);
}

/** POSIX 的 mode 位；⚠️ Windows 上 `stat` 不给这些位，故那一档靠 `skipIf` 挡掉 */
function modeOf(target: string): string {
  return (fs.statSync(target).mode & 0o777).toString(8);
}
