/**
 * @fileoverview `core/identity/factory.ts` 快照记忆化的失效判据护栏
 * @module tests/unit/identity-snapshot-memo
 * @description
 * `createIdentityFromConfig` 的动态门面按**输入身份**记忆 `FileAccountIdentity` 快照
 * （`liveSnapshots`，按 `ConfigAccessor` 隔离）。失效判据是六样输入：
 * `accounts`（`loadAuthUsers` 返回数组的**对象身份**）+ `enabled` / `type` /
 * `jwtSecret` / `enableLogging`（四个标量值）+ `jwtVerify`（注入位的**函数引用**）。
 *
 * ⚠️ **本档存在的理由（一个零覆盖缺口的补齐）**：`memo.accounts === accounts` 这一句
 * 曾**完全没有护栏**——删掉它，全量用例**逐条全绿**，而 `users.json` 的热加载从此
 * **永久失效**（账号表永远停在旧内容）。它是整个记忆化方案的地基：六项判据里少比一项
 * 就是一处能**悄悄**失效的热加载。
 *
 * 本档三条纪律（与 `traffic/` 那条「定时器必然引入让出点 → 作废无锁论证」同源）：
 * 1. **每一条判据都有专属用例**，失败原因明确——不是靠某条无关用例顺带变红。
 * 2. **节流处理照抄既有手法**（`auth-users.test.ts` 的 `vi.useFakeTimers()` +
 *    `vi.advanceTimersByTime(1500)` + 单调递增 `fs.utimesSync`），不自己发明。
 * 3. **零定时器 / 零 TTL / 零轮询是源码级事实**：判据是「输入身份」不是「时间」，
 *    时间判据会把正确性耦合到 `readJsonCached` 的 1s `maxAgeMs` 上。
 *
 * **诚实记录一处本档做不到的事**：记忆化「命中」在行为面**不可观测**（命中与否的输出
 * 永远相同——不命中就重建，重建后的结果与命中那份一致），所以「输入未变即复用同一份
 * 快照」这条只有**源码级**断言能锁（见「记忆表的判据链」那组）。反过来，「输入变了就
 * 必须失效」是**行为可观测**的，故本档主体是行为用例。
 *
 * **为什么另起一档而不是并进 `identity.test.ts` / `identity-credential-seam.test.ts`**：
 * 那两档各有自己的夹具纪律（前者是判定真值表、共用 `testConfig` 的快照/复原；后者是
 * 端口接缝、不落盘文件）。本档需要**每例一份私有 `ConfigStore` + 私有 users.json +
 * 假时钟**，塞进去会污染那两档的夹具假设，而记忆化这件事也值得一个能按名检索到的名字。
 *
 * **已用变异测试逐条验证**（临时删掉 `live()` 判据链里的对应一句 → 立刻变红 → 还原并
 * sha256 校验 `src/` 逐字未变）：删 `memo.accounts` / `memo.enabled` / `memo.type` /
 * `memo.jwtSecret` / `memo.enableLogging` / `memo.jwtVerify` 各自命中对应的行为用例；
 * 往 `factory.ts` 插一行 `setInterval` → 命中「零定时器」那条。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { createIdentityFromConfig } from "@/core/identity.js";
import { ConfigStore, configAccessorFromStore, loadAuthUsers, type ConfigAccessor } from "@/config/index.js";
import type { CoreContext } from "@/core/context.js";
import type {
  AuthAccount,
  IdentityContext,
  IdentityOptions,
  IdentityProvider,
} from "@/core/types/identity.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";
import { testContextFor } from "../helpers/config.js";
import { codeOf, offendingLines } from "../helpers/source-scan.js";

/** base64 编码辅助（Basic 凭证的常见形态） */
function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

/** 签发 HS256 JWT（与内置校验器 `defaultJwtVerify` 共用 node:crypto HMAC） */
function signJwt(payload: unknown, secret: string): string {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

/** 手搓一个 `IdentityContext`（身份端口的入参是只读事实包，测试自己造最省事） */
function ctxWith(
  headers: Record<string, string>,
  onAuthEvent?: (e: ProxyAuthEvent) => void,
): IdentityContext {
  return {
    protocol: "http",
    req: {
      method: "GET",
      headers,
      url: "/",
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    socket: {} as unknown as Duplex,
    // 用 RFC 2606 保留 TLD（`.invalid`）而不是 `example.com`：后者**算公网**
    // （`.com` 之下、真的可解析），会让 `unit/no-external-network.test.ts` 的
    // B 面「未申报即红」立刻命中。本档不建链，这个字段只进审计事件的 `target`。
    authority: "target.invalid:80",
    onAuthEvent,
  };
}

/** `Basic <b64>` 形态的 Proxy-Authorization 头 */
function basicHeader(user: string, pass: string): Record<string, string> {
  return { "proxy-authorization": `Basic ${b64(`${user}:${pass}`)}` };
}

/** 观察面占位：只用来给 `loadAuthUsers` 做前提断言，不需要任何事件 */
const noopOnEvent = (): void => undefined;

describe("identity/factory 快照记忆化的失效判据", () => {
  let dir: string;
  let usersFile: string;
  let store: ConfigStore;
  let accessor: ConfigAccessor;
  let ctx: CoreContext;
  /**
   * 单调递增的 mtime 写入：绕开文件系统时间戳粒度，让「内容已变」这件事是确定的
   * （手法照抄 `auth-users.test.ts`，不自己发明）
   */
  let mtime = 0;

  /** 把账号表写进 users.json 并返回该文件路径 */
  function writeUsers(accounts: AuthAccount[]): string {
    mtime += 1000;
    fs.writeFileSync(usersFile, JSON.stringify(accounts));
    fs.utimesSync(usersFile, mtime / 1000, mtime / 1000);
    return usersFile;
  }

  /** 越过 `readJsonCached` 的 1s stat 节流窗口（fake timers 控时钟，同既有手法） */
  function crossThrottle(): void {
    vi.advanceTimersByTime(1500);
  }

  /** 用当前 store 的值建一个动态门面（形参是 CoreContext 三件套整体注入） */
  function newProvider(): IdentityProvider & { jwtVerify?: IdentityOptions["jwtVerify"] } {
    return createIdentityFromConfig(ctx);
  }

  beforeEach(() => {
    // 假时钟必须在**第一次**读账号表之前装上：`readJsonCached` 的节流窗口用 `Date.now()`
    // 算 `checkedAt`，不装假时钟就只能靠真 `sleep(1100)`（慢且依赖墙钟）
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-snapshot-memo-"));
    usersFile = path.join(dir, "users.json");
    mtime = 0;
    // 每例一份**私有** store：记忆表 `liveSnapshots` 与 `readJsonCached` 的节流缓存都按
    // accessor / 路径隔离，私有实例让用例之间零串号
    store = new ConfigStore();
    // ⚠️ 必须显式钉住 `authUsersFile`：不钉的话 `ConfigStore` 的缺省是相对路径
    // `cfg/users.json`（按 cwd 解析 = 仓库根），会**静默读到开发者本地的账号表**——
    // 症状是断言里凭空多出别人机器上的账号，且本机红、CI 绿。
    store.set("authUsersFile", usersFile);
    accessor = configAccessorFromStore(store);
    ctx = testContextFor(accessor);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── 0. 前提：对象身份判据为什么成立 ──────────────────────────────────────────
  // 这一条不是热加载用例，而是**热加载用例的地基**：`memo.accounts === accounts` 之所以
  // 能当判据，前提是「内容未变时 `loadAuthUsers` 返回同一个数组对象；内容真变了才换」。
  // 地基塌了，上面那几条即便全绿也证明不了任何东西。
  it("前提：内容未变时 loadAuthUsers 返回同一个数组对象，越过节流且内容变了才换新对象", () => {
    writeUsers([{ username: "alice", password: "pw1" }]);
    const first = loadAuthUsers(accessor, noopOnEvent);
    expect(first).toHaveLength(1);

    // 内容未变（连写都不写）：跨过节流窗口也仍是**同一个对象**
    crossThrottle();
    const unchanged = loadAuthUsers(accessor, noopOnEvent);
    expect(unchanged, "内容未变时必须复用同一个对象，否则对象身份判据站不住").toBe(first);

    // 内容真变了 + 越过节流：换新对象（这正是判据要捕捉的那一次变化）
    writeUsers([{ username: "bob", password: "pw2" }]);
    crossThrottle();
    const changed = loadAuthUsers(accessor, noopOnEvent);
    expect(changed, "内容变了必须换新对象").not.toBe(first);
    expect(changed.map((a) => a.username)).toEqual(["bob"]);
  });

  // ── 1. accounts（对象身份）—— 本档的核心交付 ────────────────────────────────
  it("改写 users.json 后新账号放行、旧账号不再放行（identify 与 isOwnCredential 两条路径）", async () => {
    store.set("authEnabled", true);
    store.set("authType", "basic");
    store.set("authLogging", true);
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    expect((await provider.identify(ctxWith(basicHeader("alice", "pw1")))).passed).toBe(true);
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(true);

    // 前提断言：这一轮改写**真的**让输入换了对象（否则下面的红绿分不清是判据没生效
    // 还是输入压根没变——这是「红在正确的地方」的保证）
    const before = loadAuthUsers(accessor, noopOnEvent);

    // 改写 users.json：alice 换成 bob（账号名与密码都不同，size 与 mtime 同时变）
    writeUsers([{ username: "bob", password: "pw2" }]);
    crossThrottle();
    const after = loadAuthUsers(accessor, noopOnEvent);
    expect(after, "前提：输入对象确实换了").not.toBe(before);

    // 识别路径：旧凭证不再放行，新凭证放行
    expect((await provider.identify(ctxWith(basicHeader("alice", "pw1")))).passed).toBe(false);
    const bob = await provider.identify(ctxWith(basicHeader("bob", "pw2")));
    expect(bob.passed).toBe(true);
    expect(bob.username).toBe("bob");

    // 出站剥离路径：**同一份** live 闭包，两条路径必须同步换
    // （判据读一份、识别读另一份 = 能过鉴权的凭证没被剥 = 凭证泄漏）
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(false);
    expect(provider.isOwnCredential("authorization", `Basic ${b64("bob:pw2")}`)).toBe(true);
  });

  it("同一个账号换密码（口令轮换）同样立刻生效，且审计事件跟着换", async () => {
    store.set("authEnabled", true);
    store.set("authType", "basic");
    store.set("authLogging", true);
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    const seen: ProxyAuthEvent[] = [];
    const onAuthEvent = (e: ProxyAuthEvent): void => {
      seen.push(e);
    };
    // 口令轮换是「用户名不变、密码变」——上一条（换用户名）不覆盖这个形态
    const ok = await provider.identify(ctxWith(basicHeader("alice", "pw1"), onAuthEvent));
    expect(ok.passed).toBe(true);
    expect(ok.username).toBe("alice");
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(true);

    writeUsers([{ username: "alice", password: "pw2" }]);
    crossThrottle();

    // 旧口令在两条路径上都必须失效
    expect((await provider.identify(ctxWith(basicHeader("alice", "pw1"), onAuthEvent))).passed).toBe(
      false,
    );
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(false);
    // 新口令放行（否则这条会退化成「换密码 = 全员拒」）
    const rotated = await provider.identify(ctxWith(basicHeader("alice", "pw2"), onAuthEvent));
    expect(rotated.passed).toBe(true);
    expect(rotated.username).toBe("alice");
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw2")}`)).toBe(true);

    // 审计：三轮各一条，结论与身份跟着快照换（`user` 只在放行时写）
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ passed: true, user: "alice" });
    expect(seen[1]).toMatchObject({ passed: false, attempted: "alice" });
    expect(seen[2]).toMatchObject({ passed: true, user: "alice" });
  });

  // ── 2. enabled（标量值） ───────────────────────────────────────────────────
  it("热改 authEnabled false→true：判定翻转（关闭时恒放行，开启后无凭证即拒）", async () => {
    store.set("authEnabled", false);
    store.set("authType", "basic");
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    // 关闭态：恒放行，且出站判据恒否（没有身份就没有「自己的凭证」）
    expect(provider.isEnabled).toBe(false);
    expect((await provider.identify(ctxWith({}))).passed).toBe(true);
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(false);

    store.set("authEnabled", true);
    // 开启态：判定立刻翻转，三处（isEnabled / identify / isOwnCredential）同步
    expect(provider.isEnabled).toBe(true);
    expect((await provider.identify(ctxWith({}))).passed).toBe(false);
    expect((await provider.identify(ctxWith(basicHeader("alice", "pw1")))).passed).toBe(true);
    expect((await provider.identify(ctxWith(basicHeader("alice", "nope")))).passed).toBe(false);
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(true);

    // 反向：改回关闭同样即时生效（证明这条判据不是「只认变 true」）
    store.set("authEnabled", false);
    expect(provider.isEnabled).toBe(false);
    expect((await provider.identify(ctxWith(basicHeader("alice", "nope")))).passed).toBe(true);
  });

  // ── 3. type（标量值）—— 判据形态完全不同的一档 ─────────────────────────────
  it("热改 authType basic→uid：比对形态整个换掉（错密码 basic 拒 / uid 放行）", async () => {
    store.set("authEnabled", true);
    store.set("authLogging", false);
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    // basic：比对密码，`alice:WRONG` 不在账号表 → 拒
    store.set("authType", "basic");
    expect((await provider.identify(ctxWith(basicHeader("alice", "pw1")))).passed).toBe(true);
    expect((await provider.identify(ctxWith(basicHeader("alice", "WRONG")))).passed).toBe(false);
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:WRONG")}`)).toBe(false);

    // uid：只比用户名，密码不参与判定 → 同一条凭证翻转成放行
    store.set("authType", "uid");
    const r = await provider.identify(ctxWith(basicHeader("alice", "WRONG")));
    expect(r.passed, "切到 uid 后错密码也该命中（判据形态必须真的换了）").toBe(true);
    expect(r.username).toBe("alice");
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:WRONG")}`)).toBe(true);

    // 反向证明「不是无脑放行」：uid 下用户名不在表内仍拒，且正确密码仍放行
    expect((await provider.identify(ctxWith(basicHeader("mallory", "pw1")))).passed).toBe(false);
    expect((await provider.identify(ctxWith(basicHeader("alice", "pw1")))).passed).toBe(true);
    // kind 也跟着换（它是配置现读，与快照无关，但同属「切类型立刻生效」这条能力）
    expect(provider.kind).toBe("uid");
  });

  it("热改 authType basic→none：判据与识别一起变成恒不判人", async () => {
    store.set("authEnabled", true);
    store.set("authType", "basic");
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    expect(provider.isEnabled).toBe(true);
    expect((await provider.identify(ctxWith(basicHeader("alice", "pw1")))).passed).toBe(true);

    store.set("authType", "none");
    expect(provider.isEnabled, "none 已并进 isEnabled（消费方只读这一个字段）").toBe(false);
    expect((await provider.identify(ctxWith({}))).passed).toBe(true);
    expect(provider.isOwnCredential("authorization", `Basic ${b64("alice:pw1")}`)).toBe(false);
  });

  // ── 4. jwtSecret（标量值） ─────────────────────────────────────────────────
  it("热改 jwtSecret：identify 与 isOwnCredential 一起跟着换密钥", async () => {
    store.set("authEnabled", true);
    store.set("authType", "jwt");
    store.set("authLogging", false);
    store.set("jwtSecret", "secret-one");
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    const via = (token: string): IdentityContext => ctxWith({ authorization: `Bearer ${token}` });
    const signedOne = signJwt({ sub: "alice" }, "secret-one");

    expect((await provider.identify(via(signedOne))).passed).toBe(true);
    expect(provider.isOwnCredential("authorization", `Bearer ${signedOne}`)).toBe(true);

    // 换密钥：旧密钥签的立刻失效，新密钥签的立刻放行
    store.set("jwtSecret", "secret-two");
    const signedTwo = signJwt({ sub: "alice" }, "secret-two");
    expect(
      (await provider.identify(via(signedOne))).passed,
      "换密钥后旧 token 必须失效（判据没换 = 密钥轮换形同虚设）",
    ).toBe(false);
    const ok = await provider.identify(via(signedTwo));
    expect(ok.passed).toBe(true);
    expect(ok.username).toBe("alice");
    expect(provider.isOwnCredential("authorization", `Bearer ${signedOne}`)).toBe(false);
    expect(provider.isOwnCredential("authorization", `Bearer ${signedTwo}`)).toBe(true);
  });

  // ── 5. enableLogging（标量值，对应 `authLogging`） ─────────────────────────
  it("热改 authLogging false→true：审计事件随之出现/消失（判定本身不变）", async () => {
    store.set("authEnabled", true);
    store.set("authType", "basic");
    store.set("authLogging", false);
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    const seen: ProxyAuthEvent[] = [];
    const onAuthEvent = (e: ProxyAuthEvent): void => {
      seen.push(e);
    };

    // 关闭态：判定照跑，审计一条不发
    expect((await provider.identify(ctxWith(basicHeader("alice", "nope"), onAuthEvent))).passed).toBe(
      false,
    );
    expect(seen, "authLogging=false 时不该有审计事件").toHaveLength(0);

    // 开启态：同一条失败判定，审计事件立刻出现
    store.set("authLogging", true);
    expect((await provider.identify(ctxWith(basicHeader("alice", "nope"), onAuthEvent))).passed).toBe(
      false,
    );
    expect(seen, "authLogging 改 true 后审计必须立刻跟上").toHaveLength(1);
    expect(seen[0].passed).toBe(false);
    expect(seen[0].attempted).toBe("alice");

    // 改回关闭：审计再次消失（证明不是单向的）
    store.set("authLogging", false);
    expect((await provider.identify(ctxWith(basicHeader("alice", "nope"), onAuthEvent))).passed).toBe(
      false,
    );
    expect(seen).toHaveLength(1);
  });

  // ── 6. jwtVerify（注入位的函数引用） ───────────────────────────────────────
  it("经注入位替换 jwtVerify 后下一次判定即生效（证明函数引用进了判据键）", async () => {
    store.set("authEnabled", true);
    store.set("authType", "jwt");
    store.set("authLogging", false);
    store.set("jwtSecret", "s3cr3t");
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    const via = (token: string): IdentityContext => ctxWith({ authorization: `Bearer ${token}` });
    const good = signJwt({ sub: "alice" }, "s3cr3t");

    // 第一次判定：内置 defaultJwtVerify 放行（这一轮把六样输入写进记忆表）
    expect((await provider.identify(via(good))).passed).toBe(true);

    // 换注入位：换成恒假校验器。**六样输入里只有 jwtVerify 变了**
    // （accounts/四个标量逐项未变），所以「不生效」只可能是引用没进判据键。
    provider.jwtVerify = async () => false;
    expect(
      (await provider.identify(via(good))).passed,
      "换 jwtVerify 后同一条合法 token 必须变成拒绝（引用必须进判据键）",
    ).toBe(false);

    // 再换回恒真：同样立刻生效（证明不是「注入后一次性作废」）
    provider.jwtVerify = async () => true;
    // 注意：isOwnCredential 是**同步**端口，jwt 分支走内置 HS256，**不调**这个异步校验器
    // （端口形状决定的已知边界，见 file-account.ts 文件头）。故这里只断言 identify 侧。
    expect((await provider.identify(via("not-even-a-jwt"))).passed).toBe(true);
  });

  it("注入位清空 = 回到未注入语义（fail-closed），说明注入位真的参与了快照构造", async () => {
    store.set("authEnabled", true);
    store.set("authType", "jwt");
    store.set("authLogging", false);
    store.set("jwtSecret", "s3cr3t");
    writeUsers([{ username: "alice", password: "pw1" }]);

    const provider = newProvider();
    const via = (token: string): IdentityContext => ctxWith({ authorization: `Bearer ${token}` });
    const good = signJwt({ sub: "alice" }, "s3cr3t");
    expect((await provider.identify(via(good))).passed).toBe(true);

    // 换成恒真，再清空：恒真那一档是判据键命中过的，清空后必须回到「未注入 → 拒绝」
    provider.jwtVerify = async () => true;
    expect((await provider.identify(via("anything"))).passed).toBe(true);
    provider.jwtVerify = undefined;
    expect((await provider.identify(via(good))).passed).toBe(false);
  });
});

describe("identity/factory 记忆表的判据链（源码级）", () => {
  const code = codeOf("core", "identity", "factory.ts");

  /** 六个输入的名字与其本地变量名（判据链两侧同名，逐条比对） */
  const SIX_INPUTS: ReadonlyArray<readonly [string, string]> = [
    ["accounts", "accounts"],
    ["enabled", "enabled"],
    ["type", "type"],
    ["jwtSecret", "jwtSecret"],
    ["enableLogging", "enableLogging"],
    ["jwtVerify", "jwtVerify"],
  ];

  /** 记忆表取用点起、到 `return memo.snapshot;` 止的那一段（判据链本体） */
  function memoRegion(): string {
    const at = code.indexOf("const memo = liveSnapshots.get(config);");
    expect(at, "factory.ts 里的记忆表取用点不见了（结构变了，护栏需显式更新）").toBeGreaterThanOrEqual(0);
    const end = code.indexOf("return memo.snapshot;", at);
    expect(end, "判据命中后必须复用上一份快照").toBeGreaterThan(at);
    return code.slice(at, end + "return memo.snapshot;".length);
  }

  it("防假绿：扫描到的确实是 factory.ts 的 live() 判据链（读到了正文，不是空文本）", () => {
    // 负向源码断言最危险的形态是「锚点已消失 → 恒真」。先证明锚点在今天仍然存在。
    expect(code.length).toBeGreaterThan(2000);
    expect(code).toContain("liveSnapshots");
    expect((code.match(/liveSnapshots\.get\(/g) ?? []).length).toBe(1);
    expect(memoRegion()).toContain("memo.snapshot");
  });

  it("六项判据一条都不能少，且是一条纯 && 链（少比一项 = 一处能悄悄失效的热加载）", () => {
    const region = memoRegion();

    expect(region).toContain("memo !== undefined");
    for (const [field, local] of SIX_INPUTS) {
      expect(region, `判据链缺 memo.${field} === ${local}`).toContain(
        `memo.${field} === ${local}`,
      );
      expect(
        (region.match(new RegExp(`memo\\.${field} === ${local}`, "g")) ?? []).length,
        `memo.${field} 只能比一次`,
      ).toBe(1);
    }
    // 恰好七个 `memo.<字段>`：六项判据 + 命中后复用的 snapshot。
    // 多一项 = 判据里混进了不该判的东西；少一项 = 少比一样输入。
    expect((region.match(/\bmemo\.[A-Za-z]+/g) ?? []).length).toBe(7);
    // 纯 && 链：出现 || 就是「任一项命中即复用」= 判据形同虚设
    expect(region, "判据必须是 && 链，不许出现 ||").not.toContain("||");
  });

  it("六样输入每次判定都现读（判据比的是本次现读的值，不是构造期冻结的）", () => {
    const at = code.indexOf("const live = (): FileAccountIdentity =>");
    expect(at, "live() 闭包不见了（结构变了，护栏需显式更新）").toBeGreaterThanOrEqual(0);
    // 判据之前那一段：六个本地变量的取数处，一个都不许省
    const reads = code.slice(at, code.indexOf("const memo = liveSnapshots.get(config);", at));
    for (const needle of [
      'config.get("authEnabled")',
      'config.get("authType")',
      "loadAuthUsers(",
      'config.get("jwtSecret")',
      'config.get("authLogging")',
      "snap.jwtVerify",
    ]) {
      expect(reads, `live() 必须现读 ${needle}`).toContain(needle);
    }
  });
});

describe("identity/factory 零定时器 / 零 TTL / 零轮询（源码级）", () => {
  /**
   * 判据必须是「输入的身份」而不是「时间过了没有」——时间判据会把正确性耦合到
   * `readJsonCached` 的 1s `maxAgeMs` 上，那正是本仓记过的「第二真相源」同类。
   * 纪律本身**没有护栏**，这里钉成源码级事实。
   *
   * ⚠️ **刻意不带 `g` flag**：`RegExp.prototype.test` 在 `g` 下会推进 `lastIndex`，
   * 复用同一个正则对象做多次 `.test()`（或交给逐行调用的 `offendingLines`）时结果
   * **依赖调用顺序**——那是本仓「假绿」的另一个同型形态：判据看起来在生效，
   * 实际第 N 次调用恒为 false。
   */
  const TIMER_OR_CLOCK =
    /setTimeout|setInterval|setImmediate|queueMicrotask|nextTick|performance\s*\.\s*now|Date\s*\.\s*now/;

  it("防假绿：判据本身能真的命中（负向断言不许是恒真的空断言）", () => {
    // 逐个正向样本：每一条纪律都必须有牙齿，否则下面那条「零命中」证明不了任何东西
    for (const sample of [
      "setTimeout(f, 1)",
      "setInterval(f, 1)",
      "setImmediate(f)",
      "queueMicrotask(f)",
      "process.nextTick(f)",
      "const t = Date.now();",
      "const t = performance.now();",
      'import { setTimeout as sleep } from "node:timers/promises";',
    ]) {
      expect(TIMER_OR_CLOCK.test(sample), `判据漏掉了：${sample}`).toBe(true);
    }
    // 而一行干净的代码不该被误判
    expect(TIMER_OR_CLOCK.test("const accounts = loadAuthUsers(config, observeFileEvent);")).toBe(
      false,
    );
  });

  it("factory.ts 零 setTimeout / setInterval / setImmediate / nextTick / queueMicrotask / Date.now / performance.now", () => {
    const code = codeOf("core", "identity", "factory.ts");

    // 防假绿：先证明扫到的是正文而不是空文本（负向断言在「锚点消失」时会静默恒真）
    expect(code.length).toBeGreaterThan(2000);
    expect(code).toContain("liveSnapshots");

    expect(
      offendingLines(code, TIMER_OR_CLOCK),
      "记忆化方案的判据是「输入身份」不是「时间」：引入定时器/TTL/轮询会把正确性耦合到时间上",
    ).toEqual([]);
  });

  it("记忆表是模块级 WeakMap（构造期不写它，故「构造期零副作用」仍然成立）", () => {
    const code = codeOf("core", "identity", "factory.ts");

    expect(code).toContain("new WeakMap<ConfigAccessor, LiveSnapshot>()");
    // 按 accessor 隔离：两个 accessor 交替判定不互相挤掉（模块级单槽的老坑）
    expect((code.match(/liveSnapshots\.(get|set)\(config\b/g) ?? []).length).toBe(2);
    // 写入点只在 live() 内部（不在工厂构造期）
    const ctorAt = code.indexOf("export function createIdentityFromConfig(");
    const liveAt = code.indexOf("const live = (): FileAccountIdentity =>");
    expect(ctorAt).toBeGreaterThanOrEqual(0);
    expect(liveAt).toBeGreaterThan(ctorAt);
    expect(code.lastIndexOf("liveSnapshots.set(")).toBeGreaterThan(liveAt);
  });
});
