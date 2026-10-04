/**
 * 写面档：三条写路径与 `changed` / `notice` / `Effect` 三者的关系
 *
 * @description
 * 账号写（`user add` / `del` / `set` / `off`）的成败与一句话、台账写（`target add` / `del` / `switch`）
 * **只走回调且成功才给副作用**、以及 `user set` 七个字段每个只发**它自己那一个键**。三条写路径的失败各归
 * 一档（`TuiError` 逐字转述而**不塞原始异常**、非 `TuiError` 的异常一个字都不转述）。
 *
 * 共享的不变量（十条语义规则与各自的变异、替身纪律、拆档纪律）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/exec
 */

import { describe, expect, it } from "vitest";
import { exec } from "@/lib/exec/run.js";
import type { ChangeBody } from "@/api/index.js";
import { TuiError } from "@/lib/errors.js";
import { LedgerError } from "@/services/config/index.js";
import type { ManagerClient } from "@/services/index.js";
import {
  MESSAGE_CHANGED,
  commandOf,
  deps,
  errsOf,
  fakeClient,
  fakeLedger,
  joined,
  kvOf,
  notesOf,
} from "./_shared.js";
/* ── 写面：副作用与失败 ──────────────────────────────────────────────────── */

describe("写面：changed / notice / 副作用三者的关系", () => {
  it("`user del` 成功：一行 `message` + 「已改」", async () => {
    const { client, calls } = fakeClient({
      deleteAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
    });
    const result = await exec(commandOf("user del alice"), deps({ client }));

    expect(calls).toEqual(["deleteAccount"]);
    expect(kvOf(result, "写入")).toBe("已改");
    expect(notesOf(result)).toEqual([MESSAGE_CHANGED]);
    expect(result.effects).toEqual([]);
  });

  it("TuiError → 一句人读的判据（带 code 与 requestId），且不塞原始异常", async () => {
    const { client } = fakeClient({
      users: async () => {
        throw TuiError.wire({
          code: "unauthorized",
          message: "令牌不对",
          status: 401,
          requestId: "req-42",
          request: "GET /api/users",
        });
      },
    });
    const result = await exec(commandOf("users"), deps({ client }));

    expect(errsOf(result)).toHaveLength(1);
    expect(errsOf(result)[0]).toBe("unauthorized：令牌不对（requestId req-42）");
  });

  it("可重试的失败（timeout）多给一句「按 r」", async () => {
    const { client } = fakeClient({
      usage: async () => {
        throw TuiError.transport({
          code: "timeout",
          message: "请求超时（5000ms）",
          request: "GET /api/usage",
        });
      },
    });
    const result = await exec(commandOf("usage"), deps({ client }));

    expect(errsOf(result)[0]).toContain("timeout");
    expect(notesOf(result)).toContain("可重试：按 r 再来一次");
  });

  it("非 TuiError 的异常一个字都不转述（那个 message 可能带得出下层的字节）", async () => {
    const { client } = fakeClient({
      users: async () => {
        throw new Error("token=s3cret 挂在某个下层");
      },
    });
    const result = await exec(commandOf("users"), deps({ client }));

    expect(joined(result)).not.toContain("s3cret");
    expect(errsOf(result)).toHaveLength(1);
    expect(errsOf(result)[0]).toContain("未预期");
  });

  it("`user set` 的**值域收窄归解析层**了：这里拿到的已经是收窄过的形状", async () => {
    // ⚠️ 这一条曾经住在执行层（`quotaWindow week` 本地拒绝 + 一个请求都不发）。它搬到了
    // `@/commands/parse.js:readQuotaWindow`，理由是「值的域」是**解析**的判据，而执行层那份是**第二份**
    // —— 两份会漂，且漂了的后果是把一个服务端早就拒了的输入发出去。故这里断言的是**搬走之后
    // 仍然成立的那一半**：解析层拒掉的行压根到不了执行层（`commandOf` 抛的就是证据）。
    expect(() => commandOf("user set alice quotaWindow week")).toThrow();
  });

  it("`user add` 说清「建出来的是空密码账号」（命令表里没有密码形参）", async () => {
    const { client } = fakeClient({
      createAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
    });
    const result = await exec(commandOf("user add alice"), deps({ client }));

    expect(notesOf(result)).toContain(
      "/user add 没有密码形参，建出来的是空密码账号（要口令用 /user pass <用户名> <新密码>）",
    );
  });
});

/* ── 台账写：走回调，成功才给副作用 ──────────────────────────────────────── */

describe("台账写：只走回调，失败时不给副作用", () => {
  it("`target add` 把命令原样递给回调（token 逐字传下去，缺省超时保持 null）", async () => {
    const ledger = fakeLedger();
    const result = await exec(
      commandOf("target add prod http://127.0.0.1:3010 tok"),
      deps({ client: null, ...ledger.deps }, "target add prod http://127.0.0.1:3010 tok"),
    );

    expect(ledger.calls.add).toEqual([
      { name: "prod", baseUrl: "http://127.0.0.1:3010", token: "tok", timeoutMs: null },
    ]);
    expect(result.effects).toEqual([{ kind: "ledger-changed" }]);
  });

  it("给了超时就原样传数字（不换成毫秒串、不补缺省）", async () => {
    const ledger = fakeLedger();
    await exec(
      commandOf("target add prod http://127.0.0.1:3010 tok 3000"),
      deps({ client: null, ...ledger.deps }, "target add prod http://127.0.0.1:3010 tok 3000"),
    );

    expect(ledger.calls.add[0]?.timeoutMs).toBe(3000);
  });

  it("`target del` / `target switch` 各自的副作用（⚠️ 两者刻意不合并）", async () => {
    const one = fakeLedger();
    const deleted = await exec(
      commandOf("target del prod"),
      deps({ client: null, ...one.deps }, "target del prod"),
    );
    expect(one.calls.del).toEqual(["prod"]);
    expect(deleted.effects).toEqual([{ kind: "ledger-changed" }]);

    const two = fakeLedger();
    const switched = await exec(
      commandOf("target switch prod"),
      deps({ client: null, ...two.deps }, "target switch prod"),
    );
    expect(two.calls.switched).toEqual(["prod"]);
    expect(switched.effects).toEqual([{ kind: "target-switched", name: "prod" }]);
  });

  it("写失败（LedgerError）→ 一句判据，且**不给**副作用", async () => {
    for (const line of [
      "target add prod http://127.0.0.1:3010 tok",
      "target del prod",
      "target switch prod",
    ]) {
      const ledger = fakeLedger(new LedgerError("invalid-target", "台账里没有 id 为 prod 的端点"));
      const result = await exec(commandOf(line), deps({ client: null, ...ledger.deps }, line));

      expect(result.effects).toEqual([]);
      expect(errsOf(result)).toEqual(["invalid-target：台账里没有 id 为 prod 的端点"]);
      // ⚠️ 凭据不许跟着失败文案出去
      expect(joined(result)).not.toContain("tok");
    }
  });
});

/* ── `user set` 的分派：七个字段，逐字对上一份请求体 ──────────────────────── */

describe("⚠️ `user set` 的七个字段：每个只发**它自己那一个键**", () => {
  /**
   * 记录 `updateAccount` 真的收到的那份 patch
   * @description ⚠️ 判据锚在**真被构造出来的请求体**上，而不是「某个分支被执行了」——
   * 后者在一个把七个字段全写成 `disabled` 的实现下同样绿，而那会把 `user set … quotaBytes 1g`
   * 变成「顺手把这个账号停了」。
   */
  async function patchFor(line: string): Promise<readonly unknown[]> {
    const seen: unknown[][] = [];
    const client = {
      updateAccount: (_username: string, patch: unknown): Promise<ChangeBody> => {
        seen.push(Object.entries(patch as Record<string, unknown>));
        return Promise.resolve({ changed: true, message: MESSAGE_CHANGED });
      },
    } as unknown as ManagerClient;
    await exec(commandOf(line), deps({ client }, line));
    expect(seen).toHaveLength(1);
    return (seen[0] as unknown[][]).map((pair) => pair[1]);
  }

  it("七条命令各发一个键，且键名与服务端 `PATCH_KEYS` 逐字相同", async () => {
    // ⚠️ 判据是 **Object.keys 的集合**，不是「值对不对」：多发一个键就是「顺手改了别的」，
    // 少发一个键就是「这条命令做了别的事」（服务端会 400，而 `changed:false` 那支还会说「没动」）
    expect(await patchFor("user set alice disabled on")).toEqual([true]);
    expect(await patchFor("user set alice password pw")).toEqual(["pw"]);
    expect(await patchFor("user set alice quotaBytes 1g")).toEqual([1073741824]);
    expect(await patchFor("user set alice quotaWindow month")).toEqual(["month"]);
    expect(await patchFor("user set alice expiresAt clear")).toEqual(["clear"]);
    expect(await patchFor("user set alice targetWhitelist 1.2.3.4,*.example.com")).toEqual([
      ["1.2.3.4", "*.example.com"],
    ]);
    expect(await patchFor('user set alice targetBlacklist ""')).toEqual([[]]);
  });

  it("⚠️ 对照：键**只有**一个（把七个字段写成同一个键的实现会在这里红）", async () => {
    // 上面那串 `toEqual([值])` 已经说明「只有一个键」，这一条点明**为什么**这么写断言：
    // 它对「多带一个键」敏感，而 `expect(patch).toMatchObject(…)` 那种写法对它不敏感。
    expect(await patchFor("user set alice quotaBytes 1g")).toHaveLength(1);
  });
});
