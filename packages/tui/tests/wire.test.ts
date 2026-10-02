/**
 * `@/client/wire` — 响应形状的逐字段判据与错误体的宽松读法
 *
 * @description
 * ## 本档盯的事故
 *
 * 1. **形状漏收窄**。服务端加字段、改字段类型、换形态，本包都在线上收窄 —— 漏掉的那一个会以
 *    「界面上某个格子莫名其妙空白」的形态出现，而栈里一个有用的帧都没有。故每个端点都喂一份
 *    **从服务端源码抄来的等价样本**（注释里点名抄自哪个 `reply()` 调用），少一个字段必须抛
 *    `shape` 且 message 点名那条路径。
 * 2. **`usage` 与 `usageOne` 是两个不同形状**。服务端 `routes/usage.ts` 里 `:username` 那条把
 *    数组换成单条对象；当成同一个形状会让「查一个人的用量」渲染成一个长度为 1 的表 ——
 *    看起来能跑，而显示的是错的形态。
 * 3. **失败码闭合集漂移**。`WIRE_CODES` 是手抄的一份（与服务端 `OpsErrorCode` 五档 +
 *    `respond.ts` 的传输层四档互为镜像）。多抄一档 = 本包宣称认识一个它不认识的分类；少抄一档
 *    = 服务端答的那句话被降级成 `internal`，操作者拿到的信息严格变少。
 * 4. **错误体不能走严格解码器**。对面升级后加了新 code 时，严格解码器会把一句服务端认真写的
 *    中性事实陈述换成本包的「形状不对」四个字。故错误体是宽松的：认得出就原样透传 `message`，
 *    认不出 code 就降级成 `internal` 而**保留 `requestId`**（唯一还能接上服务端日志的线索）。
 *
 * ## 判据为什么这么定
 *
 * - **样本写全再逐个删字段**，而不是各写一份「残缺样本」：残缺样本与完整样本会各自漂，漂了之后
 *    「少字段抛错」那条会在漂掉的那个字段上继续绿。
 * - `usage` 那三段限定（`lagMs` / `sideEffect` / `note`）逐个删一遍。它们**是必答项**：
 *    少一段就把「账本此刻记着多少」显示成「这个账号现在还能用多少」。
 * - **编译期与运行期双向锁 `WIRE_CODES` 与 `WireCode` 联合**：只锁运行期的话，联合里加了一个
 *    字面量而 Set 没跟上，`tsc` 一声不响（联合是类型，不是运行时事实）。
 *
 * ## 防假绿的位置（与三条**变异实测**）
 *
 * - 双向断言写成 `Exclude<A, B>` **两个方向**都为空集；只写一个方向时，另一边多一档照样绿。
 *   变异实测 ①：表里多加一档 `bogus-tenth-code` ⇒ `tsc` 红（`Type 'true' is not assignable to
 *   type 'never'`）；变异实测 ②：表里少一档 `method-not-allowed` ⇒ 同样红。两个方向都验过。
 * - 「九个码逐个透传」那条遍历 `WIRE_CODES` 本身：Set 缩到空集时它空转，故与
 *   `size === 9` 绑在同一条用例里。
 * - 少字段用例断言 message **点名那条路径**：只断言 `kind === "shape"` 的话，收窄器整体退化成
 *   「一律抛」也照样绿。
 *
 * @module tests/wire
 */

import { describe, expect, it } from "vitest";
import { SHAPES, TuiError, WIRE_CODES, readErrorBody, type WireCode } from "@/client/index.js";

/** 任意 JSON 样本：样本是「从线上抄来的字节」，类型不该参与判断 */
type Sample = Record<string, unknown>;

/** 请求标签（收窄器的第三个参数） */
const REQ = "GET /api/probe";

/* ── 真实响应样本（逐份抄自服务端源码，抄自哪一行写在注释里）──────────────── */

/**
 * `GET /api/status`（`src/manager/routes/status.ts:statusRoute` + `@/ops/report.ts:reportConfig`）
 * @description `process` 是 `processFacts` 展开后加 `uptimeMs`；`proxy` 取的是注入的现读口，
 * 这里刻意用 cluster master 那一档（`protocol` / `host` / `port` 全 `null` + `running:false`），
 * 因为它是唯一一组四个可空字段同时为 null 的形态。
 */
const STATUS_SAMPLE: Sample = {
  process: {
    pid: 4242,
    startedAt: 1_700_000_000_000,
    uptimeMs: 12_345,
    node: "v22.13.0",
    platform: "linux",
    cwd: "/srv/proxy",
  },
  proxy: {
    mode: "master",
    protocol: null,
    host: null,
    port: null,
    running: false,
    startedAt: null,
    uptimeMs: null,
  },
  runningMeans:
    "数据面是否正在接受连接。本进程就是代理进程，故 running=true 即端口已在监听；" +
    "cluster master 模式下端口由 worker 进程持有，本进程 running 恒为 false。",
  data: {
    configDir: "/srv/proxy",
    envFiles: ["/srv/proxy/.env.production"],
    accounts: { driver: "json", path: "/srv/proxy/cfg/users.json" },
    acl: { driver: "json", path: "/srv/proxy/cfg/acl.json" },
    usage: { driver: "sqlite", dir: "/srv/proxy/cfg/usage" },
    auth: { enabled: true, type: "uid" },
    quotaResetHour: 0,
    defaultQuotaWindow: "month",
    flushIntervalMs: 30_000,
  },
};

/**
 * `GET /api/config`（`src/manager/routes/config.ts:configRoute`）
 * @description 第一个键来自缺省（**没有 `fileOrigin` 这个键** —— 那正是 `optional` 而不是
 * `nullable` 的原因）；第二个键是打码过的密钥且指出了来源文件。
 */
const CONFIG_SAMPLE: Sample = {
  configDir: "/srv/proxy",
  envFiles: ["/srv/proxy/.env.production"],
  keys: [
    {
      key: "port",
      env: "PORT",
      phase: "startup",
      restartRequired: true,
      secret: false,
      value: 3000,
      fromEnv: true,
      fromArgv: false,
    },
    {
      key: "managerToken",
      env: "MANAGER_TOKEN",
      phase: "startup",
      restartRequired: true,
      secret: true,
      value: "***",
      fileOrigin: "/srv/proxy/.env.production",
      fromEnv: false,
      fromArgv: true,
    },
  ],
  summary: { total: 2, startup: 2, runtime: 0, secrets: ["managerToken"] },
};

/** 一条账号（`src/manager/routes/users.ts:accountView`） */
const ACCOUNT_SAMPLE = {
  username: "alice",
  password: { set: true },
  disabled: false,
  quota: { bytes: 1_073_741_824, window: "month" },
  expiresAt: 1_800_000_000_000,
  expiresAtIso: "2027-01-15T08:00:00.000Z",
  acl: { target: { whitelist: ["ok.test"], blacklist: [] } },
};

/**
 * `GET /api/users`（`usersRoutes` 的 `GET /api/users`）
 * @description 第二条账号刻意**没有** `quota` / `expiresAt` / `acl` 三个键，且
 * `expiresAtIso` 显式是 `null` —— 「键不存在」与「值为 null」两种事实必须各走各的判据。
 */
const USERS_SAMPLE: Sample = {
  accounts: [
    ACCOUNT_SAMPLE,
    {
      username: "bob",
      password: { set: false },
      disabled: true,
      expiresAtIso: null,
    },
  ],
};

/** `GET /api/users/:username`（`reply(200, { account })`） */
const USER_SAMPLE: Sample = { account: ACCOUNT_SAMPLE };

/** `GET /api/acl`（`reply(200, { acl: readAcl(...) })`；`readAcl` 把三组两个方向都补齐） */
const ACL_SAMPLE: Sample = {
  acl: {
    clientIp: { whitelist: ["10.0.0.0/8"], blacklist: [] },
    target: { whitelist: [], blacklist: ["blocked.test"] },
    upstream: { whitelist: ["*.cdn.io"], blacklist: [] },
  },
};

/** `GET /api/usage` 的旁路三段（`routes/usage.ts` 里逐字给出的那几句） */
const LEDGER_NOTICE =
  "这是账本此刻记着的数；运行中的代理判定读它自己的进程内镜像，最多落后 lagMs 毫秒。" +
  "本端点不能清账——从第二个进程删账本里的行对运行中的代理无效（它的镜像按 max 合并）。";
const SIDE_EFFECT = "本次读取会物化账本文件（数据源的目标缺失即物化纪律）";
const USAGE_ROW = { user: "alice", windowKey: "2026-10", total: 12_345 };

/** `GET /api/usage`（`usageRows(reading)`：数组，按用户名升序） */
const USAGE_SAMPLE: Sample = {
  usage: [USAGE_ROW, { user: "bob", windowKey: "2026-10", total: 0 }],
  errors: [],
  lagMs: 60_000,
  sideEffect: SIDE_EFFECT,
  note: LEDGER_NOTICE,
};

/** `GET /api/usage/:username`（⚠️ `usage` 是**一个对象**，不是数组） */
const USAGE_ONE_SAMPLE: Sample = {
  usage: USAGE_ROW,
  errors: [],
  lagMs: 60_000,
  sideEffect: SIDE_EFFECT,
  note: LEDGER_NOTICE,
};

/** 账号写（`routes/users.ts:changeView`：带 `notice`，**没有** `effective`） */
const ACCOUNT_CHANGE_SAMPLE: Sample = {
  changed: true,
  message: "已新建账号 alice",
  notice: null,
};

/** 名单写（`routes/acl.ts:changeView`：带 `effective`，**没有** `notice`） */
const ACL_CHANGE_SAMPLE: Sample = {
  changed: false,
  message: "target.whitelist 里已经有 ok.test，没动",
  effective: null,
};

/* ── 工具 ────────────────────────────────────────────────────────────────── */

/** 收窄并断言通过（样本与服务端源码抄来的那份逐字相同才算过） */
function decodeOk<T>(shape: (v: unknown, p: string, r: string) => T, sample: Sample): T {
  return shape(sample, "body", REQ);
}

/** 收窄并断言抛 `shape`，返回错误以便断言 message 点名了那条路径 */
function decodeFails(
  shape: (v: unknown, p: string, r: string) => unknown,
  sample: Sample,
): TuiError {
  try {
    shape(sample, "body", REQ);
  } catch (err) {
    expect(err, "形状不对必须抛 TuiError").toBeInstanceOf(TuiError);
    const tui = err as TuiError;
    expect(tui.kind, "形状不对必须是 shape 那一档（不是 wire / transport）").toBe("shape");
    expect(tui.code).toBe("bad-shape");
    return tui;
  }
  throw new Error("判据：本次收窄应当抛 TuiError（实际没抛）");
}

/* ── 失败码闭合集 ────────────────────────────────────────────────────────── */

/** 与服务端两处互为镜像的那九档（ops 五档 + 传输层四档） */
const WIRE_CODE_TABLE = [
  "not-found",
  "already-exists",
  "invalid",
  "read-only-driver",
  "source-unreadable",
  "internal",
  "unauthorized",
  "method-not-allowed",
  "bad-request",
] as const;

/**
 * 「表与联合**双向**相等」的类型断言
 * @description 两个 `Exclude` 都为空集才成立；任一侧多一档，另一侧那一支就不是 `never`，
 * 于是 `const` 的类型不成立 → `tsc` 红。
 */
type UnionMatchesTable<Table extends readonly string[], Union extends string> = [
  Exclude<Table[number], Union>,
] extends [never]
  ? [Exclude<Union, Table[number]>] extends [never]
    ? true
    : never
  : never;

/** 编译期牙齿（被下面那条用例引用，否则 eslint 会把判据判死 —— 判据被判死等于没有判据） */
const WIRE_CODES_MATCH_TYPE: UnionMatchesTable<typeof WIRE_CODE_TABLE, WireCode> = true;

describe("失败码闭合集：`WIRE_CODES` 与 `WireCode` 双向锁死", () => {
  it("恰好 9 档（ops 五档 + 传输层四档）", () => {
    expect(WIRE_CODES.size).toBe(9);
  });

  it("运行期集合与本档抄的那张表逐个相等（不多不少不少重复）", () => {
    expect([...WIRE_CODES].sort()).toEqual([...WIRE_CODE_TABLE].sort());
  });

  it("编译期：`WireCode` 联合与那张表**双向**相等（改了一边没改另一边，`tsc` 红）", () => {
    // `WIRE_CODES_MATCH_TYPE` 的类型就是那条双向断言；它为 `never` 时这一行编译不过
    expect(WIRE_CODES_MATCH_TYPE).toBe(true);
    // 防假绿：集合为空时上面两条仍在跑，这里要求它真的能逐档透传
    expect(WIRE_CODES.has("not-found")).toBe(true);
    expect(WIRE_CODES.has("brand-new-code")).toBe(false);
  });

  it("九个码逐个被 `readErrorBody` **原样**透传（表与行为不许脱节）", () => {
    for (const code of WIRE_CODES) {
      const read = readErrorBody({ error: { code, message: "中性事实陈述", requestId: "r-1" } });
      expect(read?.code, `${code} 被降级了`).toBe(code);
    }
  });
});

describe("readErrorBody：错误体的宽松读法", () => {
  it("表内 code：code / message / requestId 三个字段逐字透传", () => {
    const read = readErrorBody({
      error: { code: "not-found", message: "账号表里没有 bob", requestId: "r-9" },
    });
    expect(read).toEqual({
      code: "not-found",
      message: "账号表里没有 bob",
      requestId: "r-9",
    });
  });

  it("**表外 code 降级成 `internal`，而 `message` 与 `requestId` 都保留**", () => {
    // 降级的是「分类」不是「信息」：那句中性事实陈述是服务端为它的语义写的，原样丢掉等于
    // 让操作者拿到的信息严格变少；而 requestId 是唯一还能接上服务端日志的线索
    const read = readErrorBody({
      error: { code: "brand-new-code", message: "quotaBytes 只能是非负整数", requestId: "r-7" },
    });
    expect(read).toEqual({
      code: "internal",
      message: "quotaBytes 只能是非负整数",
      requestId: "r-7",
    });
  });

  it("`code` 整个缺失时同样降级成 `internal`（缺省不许当成某个已知分类）", () => {
    expect(readErrorBody({ error: { message: "某句话", requestId: "r-2" } })).toEqual({
      code: "internal",
      message: "某句话",
      requestId: "r-2",
    });
  });

  it("`requestId` 缺失 ⇒ `null`（而不是 `undefined`：界面读的是一个有值的东西）", () => {
    expect(readErrorBody({ error: { code: "invalid", message: "x" } })?.requestId).toBeNull();
    expect(readErrorBody({ error: { code: "invalid", message: "x" } })?.code).toBe("invalid");
  });

  it("`message` 不是字符串 ⇒ 整个 body 读不出来（返回 `null`，交给调用方降级）", () => {
    // message 是人读的那一句，缺了它剩下的 code 与 requestId 没有呈现价值：
    // 只回一个分类而不说发生了什么，比说「响应体不是它自己的错误格式」更让人困惑
    for (const message of [undefined, null, 42, {}, [], ["x"]]) {
      expect(readErrorBody({ error: { code: "invalid", message } })).toBeNull();
    }
  });

  it("顶层没有 `error` ⇒ `null`", () => {
    for (const body of [{}, { errors: [] }, { error: undefined }, { error: null }]) {
      expect(readErrorBody(body)).toBeNull();
    }
  });

  it("`error` 不是对象 ⇒ `null`（数组与标量都不算）", () => {
    for (const error of ["boom", 42, true, [], [{ code: "invalid", message: "x" }]]) {
      expect(readErrorBody({ error })).toBeNull();
    }
  });

  it("整个 body 不是对象 ⇒ `null`", () => {
    for (const body of [null, undefined, "boom", 42, [1, 2], true]) {
      expect(readErrorBody(body)).toBeNull();
    }
  });
});

describe("各端点的响应形状：真实样本必须解得过", () => {
  it("`status`：cluster master 那一档（四个可空字段同时为 null）", () => {
    const body = decodeOk(SHAPES.status, STATUS_SAMPLE);
    expect(body.proxy.mode).toBe("master");
    expect(body.proxy.running).toBe(false);
    expect(body.proxy.port).toBeNull();
    expect(body.process.pid).toBe(4242);
    // ⚠️ 只有 `dir` 没有 `path`：给文件名就要造一个数据源（服务端 `ops/report.ts` 的取舍）
    expect(body.data.usage).toEqual({ driver: "sqlite", dir: "/srv/proxy/cfg/usage" });
  });

  it("`config`：缺省键**没有** `fileOrigin` 这个键（`optional` 的由来）", () => {
    const body = decodeOk(SHAPES.config, CONFIG_SAMPLE);
    expect(body.keys[0].fileOrigin).toBeUndefined();
    expect(body.keys[1].fileOrigin).toBe("/srv/proxy/.env.production");
    // 打码值逐字保留 —— 本包不重打码（重打码就是清单漂移的起点）
    expect(body.keys[1].value).toBe("***");
    expect(body.summary.secrets).toEqual(["managerToken"]);
  });

  it("`users`：一条全字段、一条只有必答项（可选键整个不在）", () => {
    const body = decodeOk(SHAPES.users, USERS_SAMPLE);
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts[0].password).toEqual({ set: true });
    expect(body.accounts[0].quota?.bytes).toBe(1_073_741_824);
    // `expiresAtIso` 显式 null ≠ 键不存在：两条都要走得通
    expect(body.accounts[0].expiresAtIso).toBe("2027-01-15T08:00:00.000Z");
    expect(body.accounts[1].expiresAtIso).toBeNull();
    expect(body.accounts[1].quota).toBeUndefined();
    expect(body.accounts[1].acl).toBeUndefined();
  });

  it("`user`：单条包在 `{ account }` 里（`client.user()` 取的是这一层）", () => {
    const body = decodeOk(SHAPES.user, USER_SAMPLE);
    expect(body.account.username).toBe("alice");
  });

  it("`acl`：三组两个方向（`clientIp` 在 HTTP 面上是这个拼法）", () => {
    const body = decodeOk(SHAPES.acl, ACL_SAMPLE);
    expect(body.acl.clientIp.whitelist).toEqual(["10.0.0.0/8"]);
    expect(body.acl.target.blacklist).toEqual(["blocked.test"]);
  });

  it("`change`：账号写带 `notice`、名单写带 `effective`（两个可选键分属两端）", () => {
    const account = decodeOk(SHAPES.change, ACCOUNT_CHANGE_SAMPLE);
    expect(account.changed).toBe(true);
    expect(account.message).toBe("已新建账号 alice");
    expect(account.notice).toBeNull();
    expect(account.effective).toBeUndefined();
    const acl = decodeOk(SHAPES.change, ACL_CHANGE_SAMPLE);
    expect(acl.changed).toBe(false);
    expect(acl.effective).toBeNull();
    expect(acl.notice).toBeUndefined();
  });

  it("`usage` / `usageOne`：真实样本各自解得过", () => {
    expect(decodeOk(SHAPES.usage, USAGE_SAMPLE).usage).toHaveLength(2);
    expect(decodeOk(SHAPES.usageOne, USAGE_ONE_SAMPLE).usage).toEqual(USAGE_ROW);
  });
});

describe("少一个字段 ⇒ `shape`，且 message 点名那条路径", () => {
  it("`status`：缺 `data.accounts`（嵌套两层的路径必须拼得出来）", () => {
    const broken = structuredClone(STATUS_SAMPLE) as { data: Record<string, unknown> };
    delete broken.data.accounts;
    expect(decodeFails(SHAPES.status, broken).message).toContain("data.accounts");
  });

  it("`status`：缺 `runningMeans`（缺了它，cluster 部署会被读成「代理没起来」）", () => {
    const broken = structuredClone(STATUS_SAMPLE);
    delete broken.runningMeans;
    expect(decodeFails(SHAPES.status, broken).message).toContain("runningMeans");
  });

  it("`config`：缺顶层 `summary`", () => {
    const broken = structuredClone(CONFIG_SAMPLE);
    delete broken.summary;
    expect(decodeFails(SHAPES.config, broken).message).toContain("summary");
  });

  it("`config`：`value` 是 `opaque`（对面配置 schema 决定它的类型，本包不猜）", () => {
    const sample = structuredClone(CONFIG_SAMPLE) as { keys: Array<Record<string, unknown>> };
    sample.keys[0].value = { 任意: ["形态", 1, null] };
    expect(decodeOk(SHAPES.config, sample).keys[0].value).toEqual({ 任意: ["形态", 1, null] });
  });

  it("`users`：缺 `accounts[0].expiresAtIso`（数组下标要进路径）", () => {
    const broken = structuredClone(USERS_SAMPLE) as {
      accounts: Array<Record<string, unknown>>;
    };
    delete broken.accounts[0].expiresAtIso;
    expect(decodeFails(SHAPES.users, broken).message).toContain("accounts[0].expiresAtIso");
  });

  it("`users`：可选键**存在但类型错**也要抛（「可选」不是「不判」）", () => {
    const broken = structuredClone(USERS_SAMPLE) as { accounts: Array<Record<string, unknown>> };
    broken.accounts[0].quota = "big";
    expect(decodeFails(SHAPES.users, broken).message).toContain("accounts[0].quota");
  });

  it("`acl`：缺 `acl.upstream`（组少一个就是「读回来的名单判不了上游」）", () => {
    const broken = structuredClone(ACL_SAMPLE) as { acl: Record<string, unknown> };
    delete broken.acl.upstream;
    expect(decodeFails(SHAPES.acl, broken).message).toContain("acl.upstream");
  });

  it("`change`：缺 `changed`（调用方判断「这次到底改没改」只有这一个字段）", () => {
    const broken = structuredClone(ACL_CHANGE_SAMPLE);
    delete broken.changed;
    expect(decodeFails(SHAPES.change, broken).message).toContain("changed");
  });

  it("`usage`：三段限定逐个都是必答项（`lagMs` / `sideEffect` / `note`）", () => {
    for (const field of ["lagMs", "sideEffect", "note"]) {
      const broken = structuredClone(USAGE_SAMPLE);
      delete broken[field];
      expect(decodeFails(SHAPES.usage, broken).message, `缺 ${field} 必须被点名`).toContain(field);
    }
  });
});

describe("`usage` 与 `usageOne` 是两个形状，不是一个", () => {
  it("给 `usage` 数组、过 `usageOne` 对象（服务端 `routes/usage.ts` 的真实差异）", () => {
    expect(() => decodeOk(SHAPES.usage, USAGE_SAMPLE)).not.toThrow();
    expect(() => decodeOk(SHAPES.usageOne, USAGE_ONE_SAMPLE)).not.toThrow();
  });

  it("**反着喂都抛**（当成同一个形状的后果是「查一个人的用量」渲染成长度 1 的表）", () => {
    // 防假绿：只断言「正着喂能过」的话，两个形状被合并成一个也照样绿
    expect(decodeFails(SHAPES.usage, USAGE_ONE_SAMPLE).message).toContain("usage");
    const other = decodeFails(SHAPES.usageOne, USAGE_SAMPLE);
    expect(other.message).toContain("usage");
    // 且必须点在 `usage` 这一段上，而不是笼统的「整个 body 不对」
    expect(other.message).toContain("对象");
  });

  it("单条记录里的三个字段一个都不能少（`usageFor` 抛的是 404，不是少字段）", () => {
    for (const field of ["user", "windowKey", "total"]) {
      const broken = structuredClone(USAGE_ONE_SAMPLE) as { usage: Record<string, unknown> };
      delete broken.usage[field];
      expect(decodeFails(SHAPES.usageOne, broken).message, `缺 usage.${field}`).toContain(
        `usage.${field}`,
      );
    }
  });
});
