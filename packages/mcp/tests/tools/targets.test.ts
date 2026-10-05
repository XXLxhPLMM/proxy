/**
 * @fileoverview 「这次要动哪几个 manager」的三条规矩 —— 显式替换 / 环境缺省 / 悬空点名
 * @module tests/tools/targets
 * @description
 * 这一档钉的是 `@/store/targets.js` 的全部决策。三条各自有代价，少一条就是一次**写**打在
 * 计划外的机器上：
 *
 * ① 显式给了 `managers` ⇒ 就是那几条，**不与环境并集**
 * ② 没给 ⇒ 当前激活的环境；没有激活 ⇒ **报错给模型**（不静默回退到「全部 manager」）
 * ③ 悬空 id 当场拒，且**点名是哪一条**
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateEnv,
  addManager,
  createEnv,
  deactivateEnv,
  readManagers,
  removeManager,
  resolveTargets,
  updateManager,
} from "../../src/store/index.js";
import { cleanupHomes, tempHome } from "../shared.js";

let home = "";

beforeEach(() => {
  home = tempHome();
  addManager(home, { name: "生产", baseUrl: "http://10.0.0.1:8080", key: "k1" });
  addManager(home, { name: "预发", baseUrl: "http://10.0.0.2:8080", key: "k2" });
});

afterEach(() => {
  cleanupHomes();
});

describe("① 显式指定是替换，不是并集", () => {
  it("给了 managers 时**只**动那几条，哪怕当前激活的环境里有别的", () => {
    createEnv(home, { name: "prod", managers: ["m", "m-2"] });
    activateEnv("prod");
    const scope = resolveTargets(home, ["m-2"]);
    expect(scope.targets.map((one) => one.record.id)).toEqual(["m-2"]);
    expect(scope.reason).toContain("指定了 1 个");
  });

  it("每一项按 id 或 name 认（id 优先）", () => {
    expect(resolveTargets(home, ["m"]).targets[0]?.record.name).toBe("生产");
    expect(resolveTargets(home, ["生产"]).targets[0]?.record.id).toBe("m");
  });

  it("id 优先于同名：某条 manager 的 id 撞上别人的 name 时，id 那一票说了算", () => {
    updateManager(home, "m-2", { name: "m" });
    expect(resolveTargets(home, ["m"]).targets[0]?.record.name).toBe("生产");
  });

  it("顺序照给的顺序（那是有序操作的一部分）", () => {
    expect(resolveTargets(home, ["m-2", "m"]).targets.map((one) => one.record.id)).toEqual([
      "m-2",
      "m",
    ]);
  });

  it("认不出的 ref 点名它自己，并给出路", () => {
    expect(() => resolveTargets(home, ["ghost"])).toThrow(/ghost/);
    expect(() => resolveTargets(home, ["ghost"])).toThrow(/manager_list/);
  });

  it("空数组与非法项都拒（空数组不是「全部」，那是两件事）", () => {
    expect(() => resolveTargets(home, [])).toThrow(/非空/);
    expect(() => resolveTargets(home, ["  "])).toThrow(/id 或 name/);
    expect(() => resolveTargets(home, "m")).toThrow(/非空的 id\/name 数组/);
  });
});

describe("② 没给就用当前激活的环境", () => {
  it("激活后按环境的成员顺序展开", () => {
    createEnv(home, { name: "prod", managers: ["m-2", "m"] });
    activateEnv("prod");
    const scope = resolveTargets(home, undefined);
    expect(scope.targets.map((one) => one.record.id)).toEqual(["m-2", "m"]);
    expect(scope.reason).toContain("prod");
  });

  it("⚠️ 没有激活 ⇒ 报错给模型，**绝不**静默变成「动全部」", () => {
    deactivateEnv();
    expect(() => resolveTargets(home, undefined)).toThrow(/没有激活的环境/);
    // 报错文案必须说清出路，否则模型只会重试同一个调用
    expect(() => resolveTargets(home, undefined)).toThrow(/env_activate/);
    expect(() => resolveTargets(home, undefined)).toThrow(/managers/);
  });

  it("激活着的环境不在 envs.json 里 ⇒ 报错并点名（那份 JSON 可以被手改）", () => {
    activateEnv("ghost");
    expect(() => resolveTargets(home, undefined)).toThrow(/ghost/);
  });

  it("目标带的是真凭据（这一层是 key 唯一该到的地方）", () => {
    const target = resolveTargets(home, ["m"]).targets[0]!;
    expect(target.connection).toEqual({
      baseUrl: "http://10.0.0.1:8080",
      key: "k1",
      timeoutMs: 30000,
    });
  });
});

describe("③ 悬空 id 当场拒且点名", () => {
  it("⚠️ 环境里的 id 不在清单里 ⇒ 报错点名是哪个环境的哪一条", () => {
    createEnv(home, { name: "prod", managers: ["m"] });
    activateEnv("prod");
    // ⚠️ 手改 envs.json 制造悬空：写面本来就拒，而那份 JSON 可以被人直接编辑
    writeEnvsRaw(home, JSON.stringify({ environments: [{ name: "prod", managers: ["ghost"] }] }));
    const err = catchError(() => resolveTargets(home, undefined));
    expect(err).toContain("prod");
    expect(err).toContain("ghost");
  });

  it("⚠️ 手改成指向不存在的 id 时，报错要点名环境名与那条 id", () => {
    createEnv(home, { name: "prod", managers: ["m"] });
    activateEnv("prod");
    writeEnvsRaw(home, JSON.stringify({ environments: [{ name: "prod", managers: ["ghost"] }] }));
    const err = catchError(() => resolveTargets(home, undefined));
    expect(err).toContain("prod");
    expect(err).toContain("ghost");
    expect(err).toContain("env_update");
  });

  it("成员的顺序照环境的数组序", () => {
    createEnv(home, { name: "prod", managers: ["m", "m-2"] });
    activateEnv("prod");
    expect(resolveTargets(home, undefined).targets.map((one) => one.record.id)).toEqual(["m", "m-2"]);
  });
});

function writeEnvsRaw(homeDir: string, text: string): void {
  fs.writeFileSync(path.join(homeDir, ".swain-proxy", "envs.json"), text);
}

function catchError(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

describe("清单为空", () => {
  it("一个 manager 都没登记时，显式指定任何东西都报「清单里没有」", () => {
    removeManager(home, "m");
    removeManager(home, "m-2");
    expect(readManagers(home)).toEqual([]);
    expect(() => resolveTargets(home, ["m"])).toThrow(/manager_list/);
  });
});
