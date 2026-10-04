/**
 * 读命令那一屏表：格子里只放服务端给的事实（不变量 ⑥ / ⑧ / ⑨ + 表的形状）
 *
 * @description
 * 账本只给 `dir` 不给文件名时本层不许编一个出来（来源一格的三态逐字：不在 env 文件 / 宿主env / CLI）、
 * `quota` 的 `0` 渲染成 `∞` 而不是「0 字节」、空集必须给一句文案而不给一张只有表头的表，
 * 以及五处读的表头与每行列数逐字相等（`log.ts` 不替短行对齐）。
 *
 * 共享的不变量（十条语义规则与各自的变异、替身纪律、拆档纪律）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/exec
 */

import { describe, expect, it } from "vitest";
import { exec } from "@/lib/exec/run.js";
import { UNLIMITED } from "@/lib/format.js";
import type { AclBody, ConfigBody } from "@/api/index.js";
import type { LogRow } from "@/lib/log/index.js";
import type { ManagerClient } from "@/services/index.js";
import {
  SIDE_EFFECT,
  USAGE_NOTE,
  commandOf,
  deps,
  fakeClient,
  joined,
  kvOf,
  notesOf,
  statusBody,
  tableOf,
  usageBody,
  usersBody,
} from "./_shared.js";

function configBody(): ConfigBody {
  return {
    configDir: "/etc/proxy",
    envFiles: ["/etc/proxy/.env"],
    keys: [
      {
        key: "PORT",
        env: "PORT",
        phase: "runtime",
        restartRequired: false,
        secret: false,
        value: 3010,
        fileOrigin: "/etc/proxy/.env",
        fromEnv: false,
        fromArgv: false,
      },
      {
        key: "MANAGER_TOKEN",
        env: "MANAGER_TOKEN",
        phase: "startup",
        restartRequired: true,
        secret: true,
        value: "***",
        // ⚠️ `undefined` 的含义是「不在任何 env 文件里」，**不是**「来自缺省」。⚠️ 且
        // `fromEnv` / `fromArgv` 都为假：这样这一条**真的**落在 `originCell` 的 `undefined`
        // 那一支上 —— 守 ⑥ 的「不许编文件名」锚的是**那一支**，而另两条（fromEnv / fromArgv）
        // 会在更早的分支上返回，锚不到。
        fileOrigin: undefined,
        fromEnv: false,
        fromArgv: false,
      },
    ],
    summary: { total: 2, startup: 1, runtime: 1, secrets: ["MANAGER_TOKEN"] },
  };
}

function aclBody(): AclBody {
  return {
    acl: {
      clientIp: { whitelist: ["10.0.0.0/8"], blacklist: [] },
      target: { whitelist: [], blacklist: ["b.example"] },
      upstream: { whitelist: [], blacklist: [] },
    },
  };
}

/**
 * 按表头名找列号
 * @description ⚠️ **必须 trim**：`planColumns` 把表头补到该列的宽度，故 `head[i]` 尾部带空格，
 * 而 `indexOf("配额")` 恒是 -1 —— 而 -1 会让后面那一格读到**别的列**上（`row[-1]` 是 `undefined`，
 * 于是断言看起来「只是拿不到值」）。trim 之后找不到就抛，那才是「列名写错了」的可见信号。
 */
function columnOf(table: Extract<LogRow, { kind: "table" }>, header: string): number {
  const at = table.head.findIndex((one) => one.trim() === header);
  if (at < 0) throw new Error(`表里没有这一列：${header}（现有表头 ${table.head.join(" / ")}）`);
  return at;
}

/* ── ⑥ `fileOrigin === undefined` 时不编文件名 ────────────────────────────── */

describe("不变量 ⑥：账本只给 dir 不给文件名，本层不许编一个出来", () => {
  it("config：没有任何一行含 `.json`（变异：给来源拼 `usage.jsonl` → 这里红）", async () => {
    const { client } = fakeClient({ config: async () => configBody() });
    const result = await exec(commandOf("config"), deps({ client }));

    expect(joined(result)).not.toContain(".json");
    // ⚠️ 与「这一屏确实显示了点东西」成对断言，否则空结果也会绿
    expect(joined(result).length).toBeGreaterThan(20);
    // `undefined` 的含义是「不在任何 env 文件里」，不是「来自缺省」
    const table = tableOf(result);
    const originColumn = columnOf(table, "来源");
    const tokenRow = table.rows.find((row) => row[0]?.trim() === "MANAGER_TOKEN");
    expect(tokenRow).toBeDefined();
    expect(tokenRow?.[originColumn]?.trim()).toBe("不在 env 文件");
  });

  it("config：`fromEnv` / `fromArgv` 两个事实照实呈现（对照组：证明上面那格不是恒定文案）", async () => {
    const { client } = fakeClient({
      config: async () => ({
        ...configBody(),
        keys: [
          { ...configBody().keys[0]!, fileOrigin: undefined, fromEnv: true, fromArgv: false },
          {
            ...configBody().keys[0]!,
            key: "AUTH_USERS_FILE",
            fileOrigin: undefined,
            fromEnv: false,
            fromArgv: true,
          },
        ],
      }),
    });
    const result = await exec(commandOf("config"), deps({ client }));
    const table = tableOf(result);
    const originColumn = columnOf(table, "来源");

    expect(table.rows[0]?.[originColumn]?.trim()).toBe("宿主env");
    expect(table.rows[1]?.[originColumn]?.trim()).toBe("CLI");
  });

  it("config：来源一格说「不在 env 文件」而不是「来自缺省」", async () => {
    const { client } = fakeClient({ config: async () => configBody() });
    const result = await exec(commandOf("config"), deps({ client }));

    expect(joined(result)).toContain("不在 env 文件");
    expect(joined(result)).not.toContain("缺省");
  });

  it("config <键名>：单键也走同一条来源判据", async () => {
    const { client, calls } = fakeClient({ config: async () => configBody() });
    const result = await exec(commandOf("config PORT"), deps({ client }));

    expect(calls).toEqual(["config"]);
    expect(kvOf(result, "来源")).toBe("/etc/proxy/.env");
    expect(kvOf(result, "值")).toBe("3010");
  });

  it("status：用量账本那一行只有 driver + dir，没有文件名", async () => {
    const { client } = fakeClient({ status: async () => statusBody() });
    const result = await exec(commandOf("status"), deps({ client }));

    expect(kvOf(result, "用量账本")).toBe("sqlite  /etc/proxy/usage");
    expect(joined(result)).not.toContain(".json");
  });
});

/* ── ⑧ `quota` 的 `0` 是「不限量」 ────────────────────────────────────────── */

describe("不变量 ⑧：quota 字节数 0 渲染成 ∞", () => {
  it("那一格就是 `∞`（变异：直接打 String(0) → 这里红）", async () => {
    const { client } = fakeClient({ users: async () => usersBody() });
    const result = await exec(commandOf("users"), deps({ client }));

    const table = tableOf(result);
    const quotaColumn = columnOf(table, "配额");
    const bob = table.rows.find((row) => row[0]?.trim() === "bob");
    // ⚠️ **trim 那一格**：`planColumns` 把它补到列宽，尾部的空格是排版而不是内容
    expect(bob?.[quotaColumn]?.trim()).toBe(UNLIMITED);
    // ⚠️ 三个「不是」逐个钉：不是 `0`、不是 `—`、也不是「不限量」那三个字
    expect(bob?.[quotaColumn]).not.toContain("0");
    expect(bob?.[quotaColumn]?.trim()).not.toBe("—");
    expect(bob?.[quotaColumn]).not.toContain("不限量");
    // 对照组：另一个账号的**有**限配额照常渲染（证明上一组不是碰巧）
    const alice = table.rows.find((row) => row[0]?.trim() === "alice");
    expect(alice?.[quotaColumn]).toContain("1 GiB");
  });
});

/* ── ⑨ 空集必须出文案 ────────────────────────────────────────────────────── */

describe("不变量 ⑨：空集出文案，不给一张只有表头的表", () => {
  it("users 为空：没有 table 行、有一条 note（变异：允许空表 → 这里红）", async () => {
    const { client } = fakeClient({ users: async () => ({ accounts: [] }) });
    const result = await exec(commandOf("users"), deps({ client }));

    expect(result.rows.some((row) => row.kind === "table")).toBe(false);
    expect(notesOf(result)).toHaveLength(1);
    expect(notesOf(result)[0]).toContain("账号表是空的");
  });

  it("acl 六份名单都空：同上", async () => {
    const { client } = fakeClient({
      acl: async () => ({
        acl: {
          clientIp: { whitelist: [], blacklist: [] },
          target: { whitelist: [], blacklist: [] },
          upstream: { whitelist: [], blacklist: [] },
        },
      }),
    });
    const result = await exec(commandOf("acl"), deps({ client }));

    expect(result.rows.some((row) => row.kind === "table")).toBe(false);
    expect(notesOf(result)).toHaveLength(1);
  });

  it("usage 没有记录：同上", async () => {
    const { client } = fakeClient({ usage: async () => ({ ...usageBody(), usage: [] }) });
    const result = await exec(commandOf("usage"), deps({ client }));

    expect(result.rows.some((row) => row.kind === "table")).toBe(false);
    // ⚠️ 空集**不许**把三段限定一起省掉：它们讲的是「这个空是什么意思」
    expect(notesOf(result)).toContain(SIDE_EFFECT);
    expect(notesOf(result)).toContain(USAGE_NOTE);
  });

  it("对照组：非空时确有表（证明上面三组不是恒真）", async () => {
    const { client } = fakeClient({ users: async () => usersBody() });
    const result = await exec(commandOf("users"), deps({ client }));

    expect(result.rows.some((row) => row.kind === "table")).toBe(true);
  });
});

/* ── 表的形状 ────────────────────────────────────────────────────────────── */

describe("表格：表头与每行列数必须逐字相等", () => {
  it("users / usage / acl / config / help 五处都成立（`log.ts` 不替短行对齐）", async () => {
    const cases: readonly (readonly [string, ManagerClient | null, string])[] = [
      ["users", fakeClient({ users: async () => usersBody() }).client, "users"],
      ["usage", fakeClient({ usage: async () => usageBody() }).client, "usage"],
      ["acl", fakeClient({ acl: async () => aclBody() }).client, "acl"],
      ["config", fakeClient({ config: async () => configBody() }).client, "config"],
      ["help", null, "help"],
    ];
    for (const [label, client, line] of cases) {
      const result = await exec(commandOf(line), deps({ client }, line));
      const table = tableOf(result);
      for (const row of table.rows) {
        expect([label, row.length]).toEqual([label, table.head.length]);
      }
      // ⚠️ 与「真的排过版」成对断言：不排版的话每格都是原值，两条断言会一起绿
      expect(table.rows.length).toBeGreaterThan(0);
      expect(table.rows[0]?.length).toBe(table.head.length);
    }
  });

  it("窄到只剩一列时仍然等长（丢列那条路）", async () => {
    const { client } = fakeClient({ users: async () => usersBody() });
    const result = await exec(commandOf("users"), deps({ client, width: 10 }, "users"));
    const table = tableOf(result);

    expect(table.head.length).toBeGreaterThan(0);
    for (const row of table.rows) expect(row.length).toBe(table.head.length);
  });
});
