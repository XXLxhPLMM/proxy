/**
 * 对话那半张结果区落盘：`messages` 一格一行、`seq` 的来源、收口与清空、以及**坏内容即拒**
 *
 * @description
 * ⚠️ 判据的对象是**那几行**（从一个不认识本包的句柄倒表）与读回来的 `LogEntry[]`：
 * 落盘的形状必须与 `LogEntry` **同构**，否则「按 `seq` 读回来重建」就多一次拼接。
 * 编解码本身的判据（12 个变体组合的往返、未知 `kind` 即抛）在 `tests/log/codec.test.ts`。
 *
 * @module tests/sqlite
 */

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maskEcho, type LogEntry, type Turn } from "@/lib/log/index.js";
import {
  LedgerError,
  appendMessages,
  clearMessages,
  closeLedgerDb,
  readMessages,
  saveSession,
  trimMessages,
  upsertProvider,
  writeLedger,
  type ProviderRecord,
} from "@/services/config/index.js";
import { rawRows, removeCreated, tempDb, withRaw } from "./_shared.js";

afterEach(() => {
  closeLedgerDb();
  vi.restoreAllMocks();
  removeCreated();
});

/** 一格对话的入参形态（⚠️ `id` 从 1 起，与 `@/lib/log/rows.js:append` 同一条纪律） */
function entry(id: number, at: number, turns: readonly Turn[]): LogEntry {
  return { id, at, turns };
}

const NOTE: Turn = { kind: "notice", rows: [{ kind: "note", text: "存好了" }] };

function withSession(id = "s1") {
  const file = tempDb();
  saveSession(file, { id, name: "会话 1", createdAt: 1, updatedAt: 1 });
  return file;
}

/**
 * 一格**回显**对话（`maskEcho` 的产物形态）
 * @description ⚠️ 凭据从弹窗的输入格进来，而那一圈不回显 —— 落盘这一层写的是**打码之后**那一份，
 * 故这里直接把掩码**算出来**再拼进行里（那是掩码的唯一出口，也是屏上那一圈真实给出的东西）。
 * ⚠️ 而拼进去的其余部分是**人读的名字与地址**：它们不是凭据，必须原样留着 ——
 * 一条全被抹掉的回显与一条没有回显在屏上看起来一样。
 */
function echoEntry(id: number, at: number, text: string): LogEntry {
  return entry(id, at, [{ kind: "tool-call", echo: { kind: "echo", text } }]);
}

/** 造一份带真凭据的 provider（凭据走**写入面**落库，于是「落盘那一格是明文」这件事是真的） */
function withSecretProvider(file: string, apiKey: string): ProviderRecord {
  const record: ProviderRecord = {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: "openai",
    apiKey,
  };
  upsertProvider(file, record);
  return record;
}

describe("对话落盘：一格一行，`seq` 恒等于 `LogEntry.id`", () => {
  it("追加 / 读回：`seq` 与 `at` 逐字来自入参，而落盘的字节就是那一格的 JSON", () => {
    const file = withSession();
    appendMessages(file, "s1", [entry(1, 100, [NOTE]), entry(2, 200, [NOTE])]);

    expect(rawRows(file, "messages")).toEqual([
      { session_id: "s1", seq: 1, at: 100, turns: '[{"kind":"notice","rows":[{"kind":"note","text":"存好了"}]}]' },
      { session_id: "s1", seq: 2, at: 200, turns: '[{"kind":"notice","rows":[{"kind":"note","text":"存好了"}]}]' },
    ]);
    expect(readMessages(file, "s1")).toEqual([entry(1, 100, [NOTE]), entry(2, 200, [NOTE])]);
  });

  it("⚠️ **落盘的形状与 `LogEntry` 同构**：读回来逐字相等（多一次拼接就分不开了）", () => {
    const file = withSession();
    const table: Turn = {
      kind: "tool-result",
      rows: [
        { kind: "head", text: "账号" },
        { kind: "kv", key: "模式", value: "master", tone: "ok" },
        { kind: "table", head: ["用户名", "字节"], rows: [["bob", "1024"]], right: [1] },
      ],
    };
    appendMessages(file, "s1", [entry(7, 700, [{ kind: "user", text: "查一下" }, table])]);

    expect(readMessages(file, "s1")).toEqual([entry(7, 700, [{ kind: "user", text: "查一下" }, table])]);
  });

  it("⚠️ 两个会话的对话**互不串**（`session_id` 是主键的一半）", () => {
    const file = tempDb();
    saveSession(file, { id: "s1", name: "会话 1", createdAt: 1, updatedAt: 1 });
    saveSession(file, { id: "s2", name: "会话 2", createdAt: 1, updatedAt: 1 });
    appendMessages(file, "s1", [entry(1, 100, [NOTE])]);
    appendMessages(file, "s2", [entry(1, 999, [NOTE])]);

    expect(readMessages(file, "s1")).toEqual([entry(1, 100, [NOTE])]);
    expect(readMessages(file, "s2")).toEqual([entry(1, 999, [NOTE])]);
  });

  it("⚠️ **升序读回**（落盘的顺序与读出来的顺序必须同一个）", () => {
    const file = withSession();
    appendMessages(file, "s1", [entry(3, 300, [NOTE]), entry(1, 100, [NOTE]), entry(2, 200, [NOTE])]);

    expect(readMessages(file, "s1").map((one) => one.id)).toEqual([1, 2, 3]);
  });

  it("追加空数组是成功的 no-op（而**不**开事务：那一个字节都不该落）", () => {
    const file = withSession();
    const before = fs.existsSync(file);
    expect(before).toBe(true);

    appendMessages(file, "s1", []);

    expect(rawRows(file, "messages")).toEqual([]);
  });

  it("库不存在 ⇒ 空对话，且**不**因此创建那个库", () => {
    const file = tempDb();
    expect(readMessages(file, "s1")).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("⚠️ 同一个 `seq` 记两遍 ⇒ 抛（一个会话被记两遍会让「按 seq 读回来」有两种答案）", () => {
    const file = withSession();
    appendMessages(file, "s1", [entry(1, 100, [NOTE])]);

    expect(() => appendMessages(file, "s1", [entry(1, 200, [NOTE])])).toThrowError(LedgerError);
    expect(readMessages(file, "s1")).toEqual([entry(1, 100, [NOTE])]);
  });
});

describe("收口与清空", () => {
  it("⚠️ 收口：下界等于桶里第一格的 `id` 时，最老的那些整条没了，而留下的**一条不少**", () => {
    const file = withSession();
    appendMessages(file, "s1", [
      entry(1, 100, [NOTE]),
      entry(2, 200, [NOTE]),
      entry(3, 300, [NOTE]),
    ]);

    trimMessages(file, "s1", 3);

    expect(readMessages(file, "s1").map((one) => one.id)).toEqual([3]);
    expect(rawRows(file, "messages")).toHaveLength(1);
  });

  it("收口的下界是第一格 ⇒ 一条都不删（桶里最老的那一格还在）", () => {
    const file = withSession();
    appendMessages(file, "s1", [entry(1, 100, [NOTE]), entry(2, 200, [NOTE])]);

    trimMessages(file, "s1", 1);

    expect(readMessages(file, "s1").map((one) => one.id)).toEqual([1, 2]);
  });

  it("收口一个下界比最大的 `seq` 还大的 ⇒ 整个会话空了（反向自检：上面那组不是恒空）", () => {
    const file = withSession();
    appendMessages(file, "s1", [entry(1, 100, [NOTE]), entry(2, 200, [NOTE])]);

    trimMessages(file, "s1", 99);

    expect(readMessages(file, "s1")).toEqual([]);
  });

  it("清空：整格对话没了，而**会话与侧边栏那一行都留着**", () => {
    const file = withSession();
    appendMessages(file, "s1", [entry(1, 100, [NOTE])]);

    clearMessages(file, "s1");

    expect(readMessages(file, "s1")).toEqual([]);
    expect(rawRows(file, "sessions")).toHaveLength(1);
  });

  it("清空一个本来就空的是成功的 no-op", () => {
    const file = withSession();
    expect(() => clearMessages(file, "s1")).not.toThrow();
    expect(readMessages(file, "s1")).toEqual([]);
  });
});

describe("坏内容即拒（⚠️ **绝不**降级成空对话）", () => {
  /** 往 `turns` 那一格塞一段不是本包形状的字节（⚠️ 从外面塞：走本包的接口造不出坏形状） */
  function withBadTurns(file: string, turns: string, seq = 1): void {
    closeLedgerDb();
    withRaw(file, (db) =>
      db
        .prepare("INSERT INTO messages(session_id, seq, at, turns) VALUES(?, ?, ?, ?)")
        .run("s1", seq, 100, turns),
    );
  }

  it("`turns` 不是 JSON ⇒ 抛 `unreadable`，而**没有降级成空对话**", () => {
    const file = withSession();
    withBadTurns(file, "这不是 JSON");

    let thrown: unknown;
    try {
      readMessages(file, "s1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LedgerError);
    expect((thrown as LedgerError).code).toBe("unreadable");
  });

  it("⚠️ `turns` 是合法 JSON 但**不像一个 `Turn`** ⇒ 抛（缺一档就当 `note` 是那句要防的假事实）", () => {
    const file = withSession();
    withBadTurns(file, '[{"kind":"没听说过的变体","text":"x"}]');

    expect(() => readMessages(file, "s1")).toThrowError(LedgerError);
  });

  it("⚠️ **错误文案不引用载荷**（`turns` 里躺着的是一句用户聊天消息，而它会进文案）", () => {
    const file = withSession();
    const secret = "这句话不该出现在错误文案里";
    withBadTurns(file, JSON.stringify([{ kind: "note", text: secret }]));

    let thrown: unknown;
    try {
      readMessages(file, "s1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LedgerError);
    expect((thrown as LedgerError).message).not.toContain(secret);
    // ⚠️ 反向自检：文案**点名了出错的那一格**，而那句话真的进了这一格
    expect((thrown as LedgerError).message).toContain("turns");
  });

  it("⚠️ 拒读之后**盘上那份一个字节都没变**（倒表比，不用逐字节 —— WAL 下数据可能整段还在 `-wal` 里）", () => {
    const file = withSession();
    withBadTurns(file, '{"kind":"note"');
    const before = rawRows(file, "messages");

    expect(() => readMessages(file, "s1")).toThrowError(LedgerError);

    expect(rawRows(file, "messages")).toEqual(before);
    expect(rawRows(file, "messages")).toHaveLength(1);
  });

  it("`seq` 不是整数 ⇒ 抛（那一格是主键的一半，而主键那一位是「按 seq 读回来」的排序依据）", () => {
    const file = withSession();
    closeLedgerDb();
    withRaw(file, (db) =>
      db.prepare("INSERT INTO messages(session_id, seq, at, turns) VALUES('s1', 'x', 1, '[]')").run(),
    );

    expect(() => readMessages(file, "s1")).toThrowError(LedgerError);
  });
});

describe("⚠️ 落盘的字节里没有明文凭据（凭据在进对话之前就打过码）", () => {
  it("provider 那一格与台账那一格各躺一个真凭据，而 `messages` 那几行里找不到它们", () => {
    const file = withSession();
    const apiKey = "sk-live-DO-NOT-LEAK-0123456789";
    const token = "tk-live-DO-NOT-LEAK-0123456789";
    // ⚠️ 凭据经**写入面**真落库（落盘那一格是明文，防线是 `0600` 库而不是加密）——
    // 于是下面「`messages` 里没有它」证明的是「对话那一层不打码」，而不是「压根没写过」
    withSecretProvider(file, apiKey);
    writeLedger(file, {
      version: 1,
      selected: "prod",
      targets: [
        { id: "prod", name: "生产", baseUrl: "http://127.0.0.1:3010", token, timeoutMs: 5000 },
      ],
    });
    appendMessages(file, "s1", [
      echoEntry(1, 100, `OpenAI · /providers key ${maskEcho("provider-key", apiKey)}`),
      echoEntry(2, 200, `生产 · /targets token ${maskEcho("target-add", token)}`),
    ]);

    // ⚠️ 判据落在**那几行的字节**上（`-wal` 里也可能躺着），而不只是读面返回了什么
    const bytes = JSON.stringify(rawRows(file, "messages"));
    expect(bytes).not.toContain(apiKey);
    expect(bytes).not.toContain(token);
    // ⚠️ 反向自检一：那两个真凭据**确实躺在同一个库里**（在它们该在的那两格上）——
    // 否则上面两条在「一个字节都没写进去」时也成立
    expect(JSON.stringify(rawRows(file, "providers"))).toContain(apiKey);
    expect(JSON.stringify(rawRows(file, "targets"))).toContain(token);
    // ⚠️ 反向自检二：掩码形态**确实在**盘上，而人读的那几段**原样留着**
    // （全被抹掉的回显与一条没有回显在屏上看起来一样）
    expect(bytes).toContain(maskEcho("provider-key", apiKey));
    expect(bytes).toContain(maskEcho("target-add", token));
    expect(bytes).toContain("OpenAI");
    expect(bytes).toContain("生产");
    // ⚠️ 反向自检三：这两行**真的在盘上**（`readMessages` 是从盘上读的，那才是同一批字节的读面）
    expect(readMessages(file, "s1")).toHaveLength(2);
  });

  it("⚠️ 读回来的那份也一样没有（编解码不许把明文塞回来）", () => {
    const file = withSession();
    const apiKey = "sk-live-DO-NOT-LEAK-0123456789";
    withSecretProvider(file, apiKey);
    appendMessages(file, "s1", [
      echoEntry(1, 100, `OpenAI · /providers key ${maskEcho("provider-key", apiKey)}`),
    ]);

    expect(JSON.stringify(readMessages(file, "s1"))).not.toContain(apiKey);
    expect(JSON.stringify(readMessages(file, "s1"))).toContain(maskEcho("provider-key", apiKey));
  });

  it("⚠️ **掩码那一侧的红线：明文那一段无论多长都换成同一个掩码**（固定长度 ⇒ 不泄长度）", () => {
    const file = withSession();
    const short = "sk-1";
    const long = `sk-${"x".repeat(200)}`;
    withSecretProvider(file, short);
    closeLedgerDb();
    // ⚠️ 两份长度差三个数量级的凭据，落盘的那一格必须是**同一个形状**
    appendMessages(file, "s1", [
      echoEntry(1, 100, `OpenAI · /providers key ${maskEcho("provider-key", short)}`),
      echoEntry(2, 200, `OpenAI · /providers key ${maskEcho("provider-key", long)}`),
    ]);

    const bytes = JSON.stringify(rawRows(file, "messages"));
    expect(bytes).not.toContain(short);
    expect(bytes).not.toContain(long);
    expect(maskEcho("provider-key", short)).toBe(maskEcho("provider-key", long));
    // ⚠️ 反向自检：那两行都在盘上（否则「找不到明文」可能只是「什么都没写」）
    expect(rawRows(file, "messages")).toHaveLength(2);
  });
});