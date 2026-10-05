/**
 * `readAuthUsers` / `loadAuthUsers` 读面：文件缺失、顺序保留、坏文件保留上一份有效值。
 *
 * 读面**零直接读取器**与「坏内容保留上一份而不是清成空表」的理由在 `./AGENTS.md`；
 * 本档只答读面自己的那几种返回形状。
 *
 * @module tests/unit/config/auth-users
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAuthUsers, readAuthUsers } from "@/datasource/users/index.js";
import { restoreConfig, set, snapshotConfig } from "../../../helpers/config.js";
import { acc } from "./_auth-users.js";

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
    const r = readAuthUsers({
      locator: acc(),
      force: true,
      path: path.join(dir, "missing.json"),
    });
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
    const r = readAuthUsers({ locator: acc(), force: true, path: p });
    expect(r.exists).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual(accounts);
    expect(r.value.map((a) => a.username)).toEqual(["bob", "alice"]);
  });

  it("非法结构（缺 password）→ 记 error 并保留上一份有效值", () => {
    const p = path.join(dir, "retain.json");
    fs.writeFileSync(p, JSON.stringify([{ username: "alice", password: "pw" }]));
    const first = readAuthUsers({ locator: acc(), force: true, path: p });
    expect(first.error).toBeUndefined();
    expect(first.value).toEqual([{ username: "alice", password: "pw" }]);

    fs.writeFileSync(p, JSON.stringify([{ username: "alice" }]));
    const second = readAuthUsers({ locator: acc(), force: true, path: p });
    expect(second.error).toBeTruthy();
    expect(second.value).toEqual([{ username: "alice", password: "pw" }]);
  });

  it("非法 JSON → 同样保留上一份有效值", () => {
    const p = path.join(dir, "bad-json.json");
    fs.writeFileSync(p, JSON.stringify([{ username: "carol", password: "c" }]));
    expect(readAuthUsers({ locator: acc(), force: true, path: p }).value).toEqual([
      { username: "carol", password: "c" },
    ]);

    fs.writeFileSync(p, "{ 坏 JSON");
    const r = readAuthUsers({ locator: acc(), force: true, path: p });
    expect(r.error).toBeTruthy();
    expect(r.value).toEqual([{ username: "carol", password: "c" }]);
  });

  it("loadAuthUsers：经 store 的 authUsersFile 读取", () => {
    const p = path.join(dir, "store.json");
    fs.writeFileSync(p, JSON.stringify([{ username: "dave", password: "d" }]));
    set("authUsersFile", p);
    expect(loadAuthUsers(acc())).toEqual([{ username: "dave", password: "d" }]);
  });
});
