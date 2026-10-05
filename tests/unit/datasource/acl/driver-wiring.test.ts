/**
 * `ACL_DRIVER` 的**两个装配点**真的换了实现器 —— `createFileAccessControl`（判定期）与
 * `config/load.ts`（启动期强校验）。
 *
 * @description
 * 驱动名是**开放集合**，「配了 `ACL_DRIVER=mysql` 到底读的是不是 mysql」没有类型系统兜底；
 * 判定类用例一律给出**同一目标主机在两种驱动下的相反结果**（自定义档拒、json 档放行）。
 * ⚠️ 只钉判定期的话，「启动期走 json 档而运行期走自定义档」这种分裂不会被发现 ——
 * 三次变异实测与它们各自的判据形状见 `AGENTS.md`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore, configAccessorFromStore, loadConfig, type ConfigAccessor } from "@/config/index.js";
import { createFileAccessControl } from "@/core/access-control.js";
import { EMPTY_ACL, registerAclSource } from "@/datasource/acl/index.js";
import { CUSTOM, DENIED_HOST, newProbe, register, storeWith } from "./_acl-driver.js";

let dir = "";

/** 配置 store 侧的 accessor（判定装配层吃它） */
function accessorOf(store: ConfigStore): ConfigAccessor {
  return configAccessorFromStore(store);
}

/** 写一份**除 `other.example.com` 外全放行**的名单文件：json 档读它必然放行 `DENIED_HOST` */
function writePermissiveJson(name: string): string {
  const p = path.join(dir, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify({ target: { blacklist: ["other.example.com"] } }));
  return p;
}

/** 独立的 configDir（`loadConfig` 在这个 cwd 下解析 FIELDS 的路径缺省，不落在仓库里） */
function tempCwd(tag: string): string {
  return fs.mkdtempSync(path.join(dir, `${tag}-cwd-`));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-driver-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createFileAccessControl：`ACL_DRIVER` 真的决定用哪个实现器", () => {
  it("自定义驱动拒的 host 被拒；同一份名单文件在 json 档下同一个 host 放行", () => {
    const probe = newProbe();
    const off = register(probe);
    try {
      const file = writePermissiveJson("permissive");

      // 对照组：json 档读同一份文件 → 放行（黑名单里没有它）
      const jsonAccess = createFileAccessControl(
        accessorOf(storeWith({ aclDriver: "json", aclFile: file })),
      );
      expect(jsonAccess.checkTarget({ host: DENIED_HOST })).toEqual({ allowed: true });

      // 实验组：自定义驱动 → 拒绝，且 `source:"global"` 说明走的是全局名单那一层
      const customAccess = createFileAccessControl(
        accessorOf(storeWith({ aclDriver: CUSTOM, aclFile: file })),
      );
      expect(customAccess.checkTarget({ host: DENIED_HOST })).toEqual({
        allowed: false,
        reason: "blacklist",
        source: "global",
      });
      expect(probe.factoryCalls).toBeGreaterThanOrEqual(1);
      expect(probe.readCalls).toBeGreaterThanOrEqual(1);
    } finally {
      off();
    }
  });

  it("三个判定方法共用同一个驱动（换驱动同时换掉 clientIp / target / upstream 三组）", () => {
    const off = registerAclSource(
      CUSTOM,
      () => ({
        driver: CUSTOM,
        locator: () => "unit-test://acl",
        read: () => ({
          value: {
            clientIp: { whitelist: [], blacklist: ["198.51.100.7"] },
            target: { whitelist: [], blacklist: [DENIED_HOST] },
            upstream: { whitelist: [], blacklist: ["direct.example.com"] },
          },
          path: "unit-test://acl",
          exists: true,
        }),
        readStartup: async () => ({
          value: EMPTY_ACL,
          path: "unit-test://acl",
          exists: false,
        }),
      }),
    );
    try {
      const access = createFileAccessControl(accessorOf(storeWith({ aclDriver: CUSTOM })));
      expect(access.checkClient({ client: "198.51.100.7" })).toEqual({
        allowed: false,
        reason: "blacklist",
      });
      expect(access.checkTarget({ host: DENIED_HOST })).toEqual({
        allowed: false,
        reason: "blacklist",
        source: "global",
      });
      expect(access.checkRoute({ host: "direct.example.com" })).toEqual({
        direct: true,
        reason: "blacklist",
      });
    } finally {
      off();
    }
  });

  it("未注册的驱动名在**装配时**抛错并列出全部已注册项（绝不静默回落到 json 档）", () => {
    const config = accessorOf(storeWith({ aclDriver: "no-such-acl-driver" }));
    expect(() => createFileAccessControl(config)).toThrow(/no-such-acl-driver/);
    expect(() => createFileAccessControl(config)).toThrow(/json/);
  });
});

describe("loadConfig：启动期强校验走 `ACL_DRIVER` 指定的实现器", () => {
  it("自定义驱动的启动期读取被真正调用（`ACL_DRIVER` 经 env 生效）", async () => {
    const probe = newProbe();
    const off = register(probe);
    try {
      const context = await loadConfig({
        env: { ACL_DRIVER: CUSTOM },
        envFiles: [],
        argv: [],
        cwd: tempCwd("ok"),
      });
      expect(context.config.aclDriver).toBe(CUSTOM);
      expect(probe.startupCalls).toBe(1);
    } finally {
      off();
    }
  });

  it("自定义驱动的启动期错误让启动失败，且报错文案点名驱动而不是 ACL_FILE", async () => {
    const probe = newProbe();
    const off = register(probe, "自定义档的启动期错误");
    try {
      await expect(
        loadConfig({ env: { ACL_DRIVER: CUSTOM }, envFiles: [], argv: [], cwd: tempCwd("bad") }),
      ).rejects.toThrow(/ACL_DRIVER=unit-test-custom.*自定义档的启动期错误/);
      expect(probe.startupCalls).toBe(1);
    } finally {
      off();
    }
  });

  it("未注册的驱动名让 `loadConfig` 直接失败（不会退化成「名单缺失 = 空名单 = 全放行」）", async () => {
    await expect(
      loadConfig({
        env: { ACL_DRIVER: "no-such-acl-driver" },
        envFiles: [],
        argv: [],
        cwd: tempCwd("unknown"),
      }),
    ).rejects.toThrow(/no-such-acl-driver/);
  });

  it("内置 `json` 档的启动期坏内容仍中止启动（fail-closed 未因接线而松掉）", async () => {
    const cwd = tempCwd("json-bad");
    const file = path.join(cwd, "bad-acl.json");
    // 条目带端口 = 非法（名单条目不支持端口）
    fs.writeFileSync(file, JSON.stringify({ target: { blacklist: ["example.com:8080"] } }));
    await expect(
      loadConfig({ env: { ACL_FILE: file }, envFiles: [], argv: [], cwd }),
    ).rejects.toThrow(/ACL_FILE=.*格式非法/);
  });
});
