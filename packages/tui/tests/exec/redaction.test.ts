/**
 * 凭据档：密码与 token 的原值一个字节都不许进 `rows`（不变量 ⑦）
 *
 * @description
 * 掩码是**固定长度**的（长度本身就是信息，故不许照着真实长度打点）、判据是**凭据类别**而不是命令名，
 * 用户名与密码是同一个串时也不许打错位置。两组长度差别很大的凭据各跑一次，比的是掩码串的长度逐字相同，
 * 而不是一个「看起来被打过码」。
 *
 * 共享的不变量（十条语义规则与各自的变异、替身纪律、拆档纪律）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/exec
 */

import { describe, expect, it } from "vitest";
import { exec, type ExecDeps } from "@/lib/exec/run.js";
import { MESSAGE_CHANGED, commandOf, deps, fakeClient, fakeLedger, joined } from "./_shared.js";
/* ── ⑦ 凭据不进任何一行 ──────────────────────────────────────────────────── */

describe("不变量 ⑦：密码与 token 一个字节都不许进 rows", () => {
  /**
   * 一组长度差别**很大**的凭据：长度本身就是信息（掩码固定长度就是为了不泄它）
   * @description ⚠️ 两条命令的**执行路径不同**（`user pass` 要控制面、`target add` 只写台账），
   * 故各自给齐自己那一条路径要的东西；这里比的是「掩码串的长度」在两组之间逐字相同。
   */
  const CREDENTIALS: readonly {
    label: string;
    line: string;
    secret: string;
    deps: () => ExecDeps;
  }[] = [
    {
      label: "4 字符的密码",
      line: 'user pass alice "x#$k"',
      secret: "x#$k",
      deps: () =>
        deps({
          client: fakeClient({
            updateAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
          }).client,
        }),
    },
    {
      label: "64 字符的 token",
      line: `target add prod http://127.0.0.1:3010 ${"t".repeat(64)}`,
      secret: "t".repeat(64),
      deps: () => deps({ client: null, ...fakeLedger().deps }),
    },
  ];

  it("两组凭据的掩码长度逐字相同（长度是信息），且原值一个字节都不在 rows 里", async () => {
    const texts: string[] = [];
    for (const one of CREDENTIALS) {
      const line = one.line;
      const result = await exec(commandOf(line), { ...one.deps(), line });

      expect(joined(result)).not.toContain(one.secret);
      // 回显那一行仍然在（操作者要看得见自己敲了什么），只是凭据那一格是固定长度的点
      const echo = result.rows.find((row) => row.kind === "echo");
      const text = echo?.kind === "echo" ? echo.text : "";
      expect(text).toContain("••••••");
      // 掩码**不透露长度**：两组各 6 个点，与真实长度无关
      expect(text.split("•").length - 1).toBe(6);
      texts.push(text);
    }
    // 两组的掩码片段逐字相同（一个 4 字符与一个 64 字符的凭据掩出同一个形状）
    expect(texts[0]?.split(" ").at(-1)).toBe("••••••");
    expect(texts[1]?.split(" ").at(-1)).toBe("••••••");
  });

  it("`user set … password` 同样掩码（掩码判据是凭据类别，不是命令名）", async () => {
    const { client } = fakeClient({
      updateAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
    });
    const result = await exec(
      commandOf("user set alice password s3cret"),
      deps({ client }, "user set alice password s3cret"),
    );

    expect(joined(result)).not.toContain("s3cret");
  });

  it("用户名叫**同一个串**时也不许打错位置（`user pass bob bob` 的密码必须被掩码）", async () => {
    const { client } = fakeClient({
      updateAccount: async () => ({ changed: true, message: MESSAGE_CHANGED }),
    });
    const result = await exec(
      commandOf("user pass bob bob"),
      deps({ client }, "user pass bob bob"),
    );

    const echo = result.rows.find((row) => row.kind === "echo");
    const text = echo?.kind === "echo" ? echo.text : "";
    // 用户名**逐字保留**（它不是凭据），而值那一格被换成掩码。
    // ⚠️ 回显**带前缀**：屏上印的那一串就是操作者回车时敲的那一串，而 `parseLine` 收的正是带前缀的。
    expect(text).toBe("/user pass bob ••••••");
    expect(joined(result)).not.toContain("s3cret");
  });
});
