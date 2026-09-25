import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAuthUsers, readAuthUsers, validateAuthUsers } from "@/config/auth-users.js";
import { set, testConfig } from "../helpers/config.js";
import { restoreConfig, snapshotConfig } from "../helpers/config.js";

describe("config/auth-users validateAuthUsers", () => {
  it("合法账号表：保留顺序，密码允许空串（uid 模式只用用户名）", () => {
    const accounts = [
      { username: "alice", password: "pw1" },
      { username: "bob", password: "" },
    ];
    expect(validateAuthUsers(accounts)).toEqual(accounts);
  });

  it("空数组合法", () => {
    expect(validateAuthUsers([])).toEqual([]);
  });

  it("非数组 / 元素非对象 非法", () => {
    expect(validateAuthUsers({})).toBeUndefined();
    expect(validateAuthUsers(null)).toBeUndefined();
    expect(validateAuthUsers("x")).toBeUndefined();
    expect(validateAuthUsers(["x"])).toBeUndefined();
    expect(validateAuthUsers([[]])).toBeUndefined();
    expect(validateAuthUsers([null])).toBeUndefined();
  });

  it("缺 password / password 非 string 非法", () => {
    expect(validateAuthUsers([{ username: "a" }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "a", password: 123 }])).toBeUndefined();
  });

  it("username 空串或含 ':' 非法", () => {
    expect(validateAuthUsers([{ username: "", password: "x" }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "a:b", password: "x" }])).toBeUndefined();
  });

  it("重复用户名非法", () => {
    expect(
      validateAuthUsers([
        { username: "a", password: "x" },
        { username: "a", password: "y" },
      ]),
    ).toBeUndefined();
  });

  it("未知键非法", () => {
    expect(validateAuthUsers([{ username: "a", password: "x", role: "admin" }])).toBeUndefined();
  });
});

describe("config/auth-users readAuthUsers", () => {
  let dir: string;
  let snap: Record<string, unknown>;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-users-test-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // 保存并静音日志，避免非法文件用例把 warn 写进项目 log 目录
    snap = snapshotConfig(["authUsersFile", "logLevel", "logFile"]);
    set("logLevel", "silent");
    set("logFile", "");
  });

  afterEach(() => {
    restoreConfig(snap);
  });

  it("文件缺失 → 空数组且无 error", () => {
    const r = readAuthUsers({ config: testConfig, force: true, path: path.join(dir, "missing.json") });
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual([]);
  });

  it("合法文件 → 账号顺序原样保留", () => {
    const p = path.join(dir, "ok.json");
    const accounts = [
      { username: "bob", password: "b" },
      { username: "alice", password: "" },
    ];
    fs.writeFileSync(p, JSON.stringify(accounts));
    const r = readAuthUsers({ config: testConfig, force: true, path: p });
    expect(r.exists).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual(accounts);
    expect(r.value.map((a) => a.username)).toEqual(["bob", "alice"]);
  });

  it("非法结构（缺 password）→ 记 error 并保留上一份有效值", () => {
    const p = path.join(dir, "retain.json");
    fs.writeFileSync(p, JSON.stringify([{ username: "alice", password: "pw" }]));
    const first = readAuthUsers({ config: testConfig, force: true, path: p });
    expect(first.error).toBeUndefined();
    expect(first.value).toEqual([{ username: "alice", password: "pw" }]);

    fs.writeFileSync(p, JSON.stringify([{ username: "alice" }]));
    const second = readAuthUsers({ config: testConfig, force: true, path: p });
    expect(second.error).toBeTruthy();
    expect(second.value).toEqual([{ username: "alice", password: "pw" }]);
  });

  it("非法 JSON → 同样保留上一份有效值", () => {
    const p = path.join(dir, "bad-json.json");
    fs.writeFileSync(p, JSON.stringify([{ username: "carol", password: "c" }]));
    expect(readAuthUsers({ config: testConfig, force: true, path: p }).value).toEqual([
      { username: "carol", password: "c" },
    ]);

    fs.writeFileSync(p, "{ 坏 JSON");
    const r = readAuthUsers({ config: testConfig, force: true, path: p });
    expect(r.error).toBeTruthy();
    expect(r.value).toEqual([{ username: "carol", password: "c" }]);
  });

  it("loadAuthUsers：经 store 的 authUsersFile 读取", () => {
    const p = path.join(dir, "store.json");
    fs.writeFileSync(p, JSON.stringify([{ username: "dave", password: "d" }]));
    set("authUsersFile", p);
    expect(loadAuthUsers(testConfig)).toEqual([{ username: "dave", password: "d" }]);
  });
});
