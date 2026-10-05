/**
 * `core/identity/factory.ts` 快照记忆化：**热改**判据（行为面）
 *
 * @description
 * 同一张记忆表的另一半：五个标量输入（`authEnabled` / `authType` / `jwtSecret` /
 * `authLogging`）与注入位 `jwtVerify` 逐项热改时，下一次判定即生效。每一条判据都有**专属**
 * 用例（失败原因明确，不是靠某条无关用例顺带变红）。
 *
 * ⚠️ **不许为省任何一条成本（哪怕是实测的 0.2–1.6 µs）把凭证判据收窄成「库层按头名门禁猜」**
 * ——那会把「记忆化」变成「用一个静默的凭据泄漏通道换两次对象构造」。判据链、零定时器与
 * 失效侧/热改侧的分工归 `AGENTS.md`；命中侧在 `snapshot-source-guards.test.ts`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { createIdentityFromConfig } from "@/core/identity.js";
import { ConfigStore, configAccessorFromStore, type ConfigAccessor } from "@/config/index.js";
import type { CoreContext } from "@/core/context.js";
import type { AuthAccount, IdentityContext, IdentityOptions, IdentityProvider } from "@/core/types/identity.js";
import type { ProxyAuthEvent } from "@/core/types/proxy.js";
import { testContextFor } from "../../../helpers/config.js";
import { b64, basicHeader, ctxWith } from "./_identity-snapshot-memo.js";

/** 签发 HS256 JWT（与内置校验器 `defaultJwtVerify` 共用 node:crypto HMAC） */
function signJwt(payload: unknown, secret: string): string {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

describe("identity/factory 快照记忆化的热改判据", () => {
  let dir: string;
  let usersFile: string;
  let store: ConfigStore;
  let accessor: ConfigAccessor;
  let ctx: CoreContext;
  /**
   * 单调递增的 mtime 写入：绕开文件系统时间戳粒度，让「内容已变」这件事是确定的
   * （手法照抄 `config/auth-users/read.test.ts`，不自己发明）
   */
  let mtime = 0;

  /** 把账号表写进 users.json 并返回该文件路径 */
  function writeUsers(accounts: AuthAccount[]): string {
    mtime += 1000;
    fs.writeFileSync(usersFile, JSON.stringify(accounts));
    fs.utimesSync(usersFile, mtime / 1000, mtime / 1000);
    return usersFile;
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

  // ── enabled（标量值） ───────────────────────────────────────────────────
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

  // ── type（标量值）—— 判据形态完全不同的一档 ─────────────────────────────
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

  // ── jwtSecret（标量值） ─────────────────────────────────────────────────
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

  // ── enableLogging（标量值，对应 `authLogging`） ─────────────────────────
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

  // ── jwtVerify（注入位的函数引用） ───────────────────────────────────────
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