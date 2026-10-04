/**
 * `@/services/manager-client` — 对着**真 `http.Server`** 的端到端契约单测
 *
 * @description
 * ## 为什么必须起真服务器（mock `fetch` 测不到的东西）
 *
 * 契约里有三样东西**只在真 socket 上才存在**：
 * 1. **`Authorization` 头的实际形态**。mock 掉 `fetch` 时「服务端收到的头」是测试自己编的
 *    对象，于是「`Bearer` + 一个空格」写成 `bearer` 或漏掉空格也照样绿 —— 而服务端
 *    `http/auth.ts` 的判据恰好卡在这里。
 * 2. **状态码真的那样**（401 / 404 / 500 分开），以及**响应体真的能被解码**。
 * 3. **请求行上的百分号编码**：`%2F` 在 `req.url` 里仍然是 `%2F`，而 `#` 会被片段截断、`..`
 *    会被 URL 解析器消解 —— 这三样都是 mock 层看不见的。
 *
 * 替身是**本档自己写的最小控制面**（`http.createServer` + 按 `Authorization` 与路径回 canned
 * JSON）。⚠️ **刻意不 import `@b-hole/proxy`**：TUI 包连的是**别的机器上那个进程**，而那个进程
 * 可能跑的是旧版本；跨包 import 共享契约会把「网络两端版本可以不同」这件事抹掉。契约互锁由根仓
 * 那个从两侧源码现取 `(method, path)` 再比集合的护栏负责。
 *
 * ## 本档盯的事故
 *
 * 1. **失败必须分成三档**（`wire` / `transport` / `shape`）。混成一类就等于界面只能说「出错了」：
 *    把「服务没起来」显示成「token 不对」会把人带去改一份完全正确的凭据；把「对面版本对不上」
 *    显示成「内部错误」会让人去翻服务端日志里一行根本不存在的东西。
 * 2. **`transport` 档的 `status` 恒为 `null`**，不许拿 `0` 冒充 —— 没收到响应就没有状态码。
 * 3. **超时与连不上分开**（`timeout` / `unreachable`）：前者多半是对面在忙（重试有意义），
 *    后者多半是地址/网络错了（重试没意义）。
 * 4. **错误体不是错误形状时**只能给状态码一个中性说法，**不许编**一句「服务异常」。
 * 5. **`DELETE` 也带 body**：服务端 `routes/input.ts:aclMutationInput` 明确收请求体，而很多 HTTP
 *    客户端会在 `DELETE` 上丢 body —— 改用查询串就得在客户端多写一条分支，而那正是「删了 A 实际
 *    删了 B」那条事故最容易长出来的地方。
 * 6. **`changed: false` 不是错误**：名单写是幂等的，「加一条它已经有了的」是 200 + 一个字节都没动。
 *    抛了会让界面说「操作失败」，而用户已经达到目的了。
 * 7. **`:username` 真的进了路径**（含 `/` 的用户名必须以 `%2F` 上线）。
 *
 * ## 判据为什么这么定
 *
 * - **成功路径必须真的过鉴权**：替身默认要求 `Authorization` **逐字**等于 `Bearer <token>`，
 *   不匹配即回 401（复刻 `respond.ts:sendUnauthorized` 的响应体）。于是「客户端确实把凭据送到了」
 *   是成功路径的**前提**，而不是一条另写的断言。
 * - **形状不对的两条注入分开写**（200 + `{"foo":1}` / 200 + 非 JSON 文本）：前者是「对面版本比本包
 *   新/旧」，后者是「对面根本不是控制面」，两者的处置动作不同。
 * - **`assertNonEmptyPatch` 在本地先判**：断言它抛错，**并**断言替身**一个请求都没收到**
 *   （那一次网络往返是白花的）。
 *
 * ## 防假绿的位置
 *
 * - 替身对**未登记的路径**回 404 而不是静默 200：路径拼错时断言会红在「拿不到 body」上，
 *   而不是在某个恰好也通过的地方蒙混过去。
 * - 凭据断言写「**逐字** `Bearer <token>`」并附一条负向样本（错的大小写 / 少一个空格都必须失败），
 *   否则「带了个 Authorization 头」就足以让成功路径变绿。
 * - `seen` 数组断言的是**长度与内容**（方法 / 路径 / 体），不是「至少有一个请求」——
 *   最后一个请求的断言必须在 `seen.length` 已知的前提下才有意义。
 *
 * ## **变异实测**（根 `AGENTS.md`「写护栏时」硬要求：任何负向断言都要验「被防住的行为回来时会红」）
 *
 * 1. **凭据判据**：把替身的 `Authorization` 判据设成不可能对上的值后，`status()` 立刻变 401 且
 *    用例转红 —— 证明成功路径**真的**是靠凭据送达才绿的，不是「反正有个 200」。
 * 2. **`:username` 编码**：把用户名换成未编码的形态（替身回 404 兜底）时，`%2F` 那条会红在
 *    「拿不到 body」上 —— 证明 `%2F` 断言锚的是线上请求行而不是自己编的字符串。
 * 3. **`DELETE` 带 body**：断言的是 `seen[0].body` 的**长度与三键**，`body` 一空就红 ——
 *    而「只断言方法与路径」的话，改成查询串那条通路一样绿。
 * 4. **`changed: false`**：断言 `resolve` 出来的那份 body（含 `message` 与 `effective`），
 *    而不是断言「没抛」—— 抛了会红、改成 reject 一档也会红。
 * 5. **`status` 恒为 `null`**：三档 `transport` 用例都断言 `toBeNull()`；写成 `toBe(0)` 会红，
 *    因为实现给的就是 `null`（这条护栏挡的是 `?? 0` 那种「拿 0 冒充状态码」的改法）。
 *
 * @module tests/client
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_REQUEST, TuiError, isRetryable } from "@/lib/index.js";
import { normalizeBaseUrl } from "@/lib/http.js";
import { ManagerClient, assertNonEmptyPatch, type ManagerEndpoint } from "@/services/index.js";

/* ── 替身 ────────────────────────────────────────────────────────────────── */

/** 替身记下的一个请求（断言的对象就是这些线上事实） */
interface Recorded {
  readonly method: string;
  /** 原始请求行：`%2F` 未解码、查询串原样 */
  readonly url: string;
  readonly path: string;
  readonly query: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

/** 一次回应的规格 */
interface Reply {
  readonly status?: number;
  /** 按 JSON 回（复刻服务端 `respond.ts:writeJson` 的三个头） */
  readonly json?: unknown;
  /** 直接回这段原文 —— 用于「响应体不是 JSON」 */
  readonly raw?: string;
  readonly rawContentType?: string;
  /** 收到请求后延迟这么久再回（超时用例） */
  readonly delayMs?: number;
  /** 收到请求后直接 destroy 掉 socket（连接中断用例） */
  readonly destroy?: boolean;
}

type ReplySpec = Reply | ((rec: Recorded) => Reply | undefined);

interface Double {
  readonly port: number;
  readonly baseUrl: string;
  readonly token: string;
  readonly seen: readonly Recorded[];
  /** 按 `"<METHOD> <path>"` 登记回应（未登记的路径回 404） */
  route(key: string, spec: ReplySpec): void;
  /** 换掉凭据判据；`null` 表示不再检查 */
  expectAuthorization(value: string | null): void;
  /** 401 的 requestId（复刻 `sendUnauthorized` 的响应体，供鉴权用例断言） */
  setUnauthorizedRequestId(id: string): void;
  close(): Promise<void>;
}

/** 替身默认回的那个「不是控制面」的 404（真服务端也会用这个形状） */
const NOT_FOUND_BODY = {
  error: { code: "not-found", message: "没有这个端点", requestId: "r-fallback" },
};

/** 起一个真服务器（端口 0 → 随机端口），只监听 127.0.0.1 */
async function startDouble(): Promise<Double> {
  const token = `tui-double-${Math.random().toString(36).slice(2, 10)}`;
  const routes = new Map<string, ReplySpec>();
  const seen: Recorded[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let expectedAuthorization: string | null = `Bearer ${token}`;
  let unauthorizedRequestId = "r-1";
  /** 未登记的路径回什么（恒定：404 兜底，让「路径拼错」红在「拿不到 body」上） */
  const fallback: ReplySpec = { status: 404, json: NOT_FOUND_BODY };

  function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(payload.byteLength),
      "Cache-Control": "no-store",
    });
    res.end(payload);
  }

  function send(res: http.ServerResponse, reply: Reply): void {
    if (reply.destroy === true) {
      res.socket?.destroy();
      return;
    }
    const emit = (): void => {
      if (reply.raw !== undefined) {
        if (res.writableEnded || res.destroyed) return;
        const payload = Buffer.from(reply.raw, "utf8");
        res.writeHead(reply.status ?? 200, {
          "Content-Type": reply.rawContentType ?? "text/plain; charset=utf-8",
          "Content-Length": String(payload.byteLength),
        });
        res.end(payload);
        return;
      }
      writeJson(res, reply.status ?? 200, reply.json ?? {});
    };
    if (reply.delayMs !== undefined && reply.delayMs > 0) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        emit();
      }, reply.delayMs);
      timers.add(timer);
      return;
    }
    emit();
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "/";
      const at = url.indexOf("?");
      const rec: Recorded = {
        method: req.method ?? "",
        url,
        path: at < 0 ? url : url.slice(0, at),
        query: at < 0 ? "" : url.slice(at + 1),
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(rec);

      // ⚠️ 鉴权**先于**路由（与 `http/server.ts` 同一顺序）：未鉴权的调用者拿不到 404/405 的区分
      if (expectedAuthorization !== null && rec.authorization !== expectedAuthorization) {
        writeJson(res, 401, {
          error: {
            code: "unauthorized",
            message: "缺少或错误的 Bearer 凭据",
            requestId: unauthorizedRequestId,
          },
        });
        return;
      }

      const spec = routes.get(`${rec.method} ${rec.path}`) ?? fallback;
      send(res, typeof spec === "function" ? (spec(rec) ?? NOT_FOUND_REPLY) : spec);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    seen,
    route(key, spec) {
      routes.set(key, spec);
    },
    expectAuthorization(value) {
      expectedAuthorization = value;
    },
    setUnauthorizedRequestId(id) {
      unauthorizedRequestId = id;
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

const NOT_FOUND_REPLY: Reply = { status: 404, json: NOT_FOUND_BODY };

/** 替身生命周期：每个用例自己起、自己关（不与别的用例共享端口或 token） */
let double: Double;

beforeEach(async () => {
  double = await startDouble();
});

afterEach(async () => {
  await double.close();
});

/** 造一个对着替身的客户端（token 与替身一致 ⇒ 鉴权过） */
function clientTo(dbl: Double, overrides: Partial<ManagerEndpoint> = {}): ManagerClient {
  return new ManagerClient({
    baseUrl: dbl.baseUrl,
    token: dbl.token,
    timeoutMs: 5000,
    ...overrides,
  });
}

/** 跑一次调用并取回抛出的 `TuiError`（没抛时显式失败） */
async function caught(run: () => Promise<unknown>): Promise<TuiError> {
  try {
    await run();
  } catch (err) {
    expect(err, "失败必须抛 TuiError").toBeInstanceOf(TuiError);
    return err as TuiError;
  }
  throw new Error("判据：本次调用应当抛 TuiError（实际没抛）");
}

/** 一份最小可解码的 status 样本（各端点成功路径只需要「形状对」） */
const STATUS_BODY = {
  process: {
    pid: 1,
    startedAt: 0,
    uptimeMs: 0,
    node: "v22.13.0",
    platform: "linux",
    cwd: "/srv/proxy",
  },
  proxy: {
    mode: "running",
    protocol: "http",
    host: "127.0.0.1",
    port: 3000,
    running: true,
    startedAt: 1,
    uptimeMs: 1,
  },
  runningMeans: "running=true 即端口已在监听。",
  data: {
    configDir: "/srv/proxy",
    envFiles: [],
    accounts: { driver: "json", path: "/srv/proxy/cfg/users.json" },
    acl: { driver: "json", path: "/srv/proxy/cfg/acl.json" },
    usage: { driver: "sqlite", dir: "/srv/proxy/cfg/usage" },
    auth: { enabled: true, type: "uid" },
    quotaResetHour: 0,
    defaultQuotaWindow: "month",
    flushIntervalMs: 30_000,
  },
};

const CHANGE_BODY = { changed: true, message: "已更新" };

describe("成功路径：五个读面 + 单条读面 + 写面", () => {
  it("`GET /api/status`", async () => {
    double.route("GET /api/status", { json: STATUS_BODY });
    const body = await clientTo(double).status();
    expect(body.proxy.mode).toBe("running");
    expect(body.data.usage.dir).toBe("/srv/proxy/cfg/usage");
    expect(double.seen).toHaveLength(1);
    expect(double.seen[0].method).toBe("GET");
    expect(double.seen[0].path).toBe("/api/status");
  });

  it("`GET /api/config`", async () => {
    double.route("GET /api/config", {
      json: {
        configDir: "/srv/proxy",
        envFiles: [],
        keys: [],
        summary: { total: 0, startup: 0, runtime: 0, secrets: [] },
      },
    });
    const body = await clientTo(double).config();
    expect(body.configDir).toBe("/srv/proxy");
    expect(double.seen[0].path).toBe("/api/config");
  });

  it("`GET /api/users`", async () => {
    double.route("GET /api/users", {
      json: {
        accounts: [
          { username: "alice", password: { set: true }, disabled: false, expiresAtIso: null },
        ],
      },
    });
    const body = await clientTo(double).users();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].password).toEqual({ set: true });
  });

  it("`GET /api/users/:username`：解码后交出**账号本身**（不是 `{account}` 那层包装）", async () => {
    double.route("GET /api/users/alice", {
      json: {
        account: {
          username: "alice",
          password: { set: true },
          disabled: false,
          expiresAtIso: null,
        },
      },
    });
    const account = await clientTo(double).user("alice");
    expect(account.username).toBe("alice");
    expect(account.expiresAtIso).toBeNull();
    expect(double.seen[0].path).toBe("/api/users/alice");
  });

  it("`GET /api/acl`", async () => {
    double.route("GET /api/acl", {
      json: {
        acl: {
          clientIp: { whitelist: [], blacklist: [] },
          target: { whitelist: ["ok.test"], blacklist: [] },
          upstream: { whitelist: [], blacklist: [] },
        },
      },
    });
    const body = await clientTo(double).acl();
    expect(body.acl.target.whitelist).toEqual(["ok.test"]);
  });

  it("`GET /api/usage` 与 `GET /api/usage/:username`（两个形状不同，各走各的解码器）", async () => {
    const row = { user: "alice", windowKey: "2026-10", total: 12_345 };
    const tail = { errors: [], lagMs: 60_000, sideEffect: "物化", note: "不能清账" };
    double.route("GET /api/usage", { json: { usage: [row], ...tail } });
    double.route("GET /api/usage/alice", { json: { usage: row, ...tail } });
    const client = clientTo(double);
    expect((await client.usage()).usage).toHaveLength(1);
    expect((await client.usageFor("alice")).usage).toEqual(row);
  });

  it("`POST /api/users`（201）与 `PUT` / `DELETE /api/users/:username`", async () => {
    double.route("POST /api/users", {
      status: 201,
      json: { changed: true, message: "已新建账号 bob" },
    });
    double.route("PUT /api/users/bob", { json: CHANGE_BODY });
    double.route("DELETE /api/users/bob", { json: CHANGE_BODY });
    const client = clientTo(double);
    expect((await client.createAccount({ username: "bob", password: "pw1" })).message).toBe(
      "已新建账号 bob",
    );
    expect((await client.updateAccount("bob", { disabled: true })).changed).toBe(true);
    expect((await client.deleteAccount("bob")).changed).toBe(true);
    expect(double.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/users",
      "PUT /api/users/bob",
      "DELETE /api/users/bob",
    ]);
    // 带 body 的那两次必须带 `Content-Type: application/json`（服务端对非 JSON 体一律 400）；
    // ⚠️ 判据逐条点名而不是 `every`：无 body 的 DELETE 没有这个头，`every` 会误伤
    expect(double.seen[0].contentType).toBe("application/json");
    expect(double.seen[1].contentType).toBe("application/json");
    expect(double.seen[2].body).toBe("");
  });

  it("`GET` 请求**不带** body 也不带 `Content-Type`（带了会被读成空 patch 之类的怪事）", async () => {
    double.route("GET /api/status", { json: STATUS_BODY });
    await clientTo(double).status();
    expect(double.seen[0].body).toBe("");
    expect(double.seen[0].contentType).toBeUndefined();
  });
});

describe("凭据：`Authorization` 逐字是 `Bearer <token>`", () => {
  it("成功路径上服务端收到的那一头逐字对得上", async () => {
    double.route("GET /api/status", { json: STATUS_BODY });
    // 替身默认就要求逐字相等 —— 不匹配它会回 401，于是「成功」本身已经是凭据送达的证据
    const body = await clientTo(double).status();
    expect(body.proxy.running).toBe(true);
    expect(double.seen[0].authorization).toBe(`Bearer ${double.token}`);
  });

  it("**只有**这一种形态能过（大小写 / 少一个空格 / Basic / 无头都必须被拒）", async () => {
    // 替身的判据与真实服务端 `http/auth.ts` 同口径：逐字 `Bearer ` + 不含空白的 token。
    // 这里只锁「客户端发出去的那一头**逐字**是这个形态」——替身只接受它，所以本用例变绿
    // 的唯一路径就是客户端真的发了它。
    double.route("GET /api/status", { json: STATUS_BODY });
    await clientTo(double).status();
    expect(double.seen[0].authorization).toBe(`Bearer ${double.token}`);
    expect(double.seen[0].authorization).not.toBe(`bearer ${double.token}`);
    expect(double.seen[0].authorization).not.toBe(`Bearer${double.token}`);
    expect(double.seen[0].authorization).not.toBe(`Basic ${double.token}`);
    // token 原文后面不许再跟任何东西（多一个字符就是另一个 token）
    expect(double.seen[0].authorization).not.toBe(`Bearer ${double.token} `);
  });

  it("负向样本：替身只接受 `Bearer <token>` 时，其余形态全部 401", async () => {
    // 这一档的价值在于**判据本身也有牙齿**：替身（复刻服务端 `http/auth.ts`）逐字判据若哪天
    // 放宽成「只看有没有 Authorization 头」，下面这六条会一起红。逐个形态单独发，不合并成
    // 「至少有一条被拒」—— 那在判据只拒掉一种形态时也绿。
    double.route("GET /api/status", { json: STATUS_BODY });
    const wrongShapes = [
      `bearer ${double.token}`,
      `Bearer${double.token}`,
      `Bearer  ${double.token}`,
      `Basic ${double.token}`,
      double.token,
      `Bearer ${double.token}x`,
    ];
    for (const shape of wrongShapes) {
      const reply = await fetch(`${double.baseUrl}/api/status`, {
        headers: { Authorization: shape },
      });
      expect(reply.status, `${shape} 不该被接受`).toBe(401);
      await reply.text();
    }
    // 完全没有这个头也一样（那正是 401 的原始形态）
    const bare = await fetch(`${double.baseUrl}/api/status`);
    expect(bare.status).toBe(401);
    await bare.text();
    // 防假绿：上面每一条都必须真的**收到了请求**（否则「401」也可能来自未登记路由的兜底）
    expect(double.seen).toHaveLength(wrongShapes.length + 1);
  });

  it("客户端**确实**发了这个头（替身把判据设成一个不可能对上的值 ⇒ 请求仍会到，只是被拒）", async () => {
    double.route("GET /api/status", { json: STATUS_BODY });
    double.expectAuthorization("Bearer 完全另一个 token");
    const err = await caught(() => clientTo(double).status());
    expect(err.kind).toBe("wire");
    expect(err.code).toBe("unauthorized");
    // 请求到达了（只是被拒）—— 这一条才区分得开「没发头」与「头不对」
    expect(double.seen).toHaveLength(1);
    expect(double.seen[0].authorization).toBe(`Bearer ${double.token}`);
  });
});

describe("鉴权错：`wire` 档，四个字段都要带", () => {
  it("401 + `unauthorized` ⇒ kind/code/status/requestId 逐个对上", async () => {
    double.setUnauthorizedRequestId("r-1");
    double.expectAuthorization("Bearer 完全另一个 token");
    const err = await caught(() => clientTo(double).status());
    expect(err.kind).toBe("wire");
    expect(err.code).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(err.requestId).toBe("r-1");
    // `request` 是「哪个请求失败」：界面上同时可能有多个 manager 在飞
    expect(err.request).toBe("GET /api/status");
    // wire 档不是重试有意义的那一类
    expect(isRetryable(err)).toBe(false);
  });

  it("服务端回的原样文案不许被改写（传输面不改写对面的话）", async () => {
    double.expectAuthorization("Bearer 完全另一个 token");
    const err = await caught(() => clientTo(double).status());
    expect(err.message).toBe("缺少或错误的 Bearer 凭据");
  });

  it("服务端的其它 4xx 分类逐字透传（409 / 501 / 404 / 405）", async () => {
    const cases: Array<[number, string, string]> = [
      [409, "already-exists", "已经有这个账号了"],
      [501, "read-only-driver", "这份名单驱动没有写面"],
      [404, "not-found", "账号表里没有 bob"],
      [405, "method-not-allowed", "这个端点不接受该方法"],
    ];
    for (const [status, code, message] of cases) {
      double.route("GET /api/status", {
        status,
        json: { error: { code, message, requestId: "r-x" } },
      });
      const err = await caught(() => clientTo(double).status());
      expect(err.kind, `${code} 必须是 wire 档`).toBe("wire");
      expect(err.code, `${code} 必须逐字透传`).toBe(code);
      expect(err.status).toBe(status);
      expect(err.message).toBe(message);
      expect(err.requestId).toBe("r-x");
    }
  });

  it("表外的 code 降级成 `internal` 而 `requestId` 保留（还能接上服务端日志）", async () => {
    double.route("GET /api/status", {
      status: 500,
      json: { error: { code: "brand-new-code", message: "某句中性事实陈述", requestId: "r-77" } },
    });
    const err = await caught(() => clientTo(double).status());
    expect(err.code).toBe("internal");
    expect(err.status).toBe(500);
    expect(err.message).toBe("某句中性事实陈述");
    expect(err.requestId).toBe("r-77");
  });
});

describe("传输层失败：`status` 恒为 `null`（没收到响应就没有状态码）", () => {
  it("**超时** ⇒ `transport` / `timeout`", async () => {
    double.route("GET /api/status", { json: STATUS_BODY, delayMs: 400 });
    const err = await caught(() => clientTo(double, { timeoutMs: 50 }).status());
    expect(err.kind).toBe("transport");
    expect(err.code).toBe("timeout");
    // ⚠️ 这是本档最容易被写成 `0` 的那一处：拿 0 冒充状态码，界面就会显示「HTTP 0 失败」
    expect(err.status).toBeNull();
    expect(err.request).toBe("GET /api/status");
    // 超时多半是对面在忙 ⇒ 重试有意义
    expect(isRetryable(err)).toBe(true);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("**连不上**（服务已关）⇒ `transport` / `unreachable`", async () => {
    const baseUrl = double.baseUrl;
    await double.close();
    // 防假绿：端口必须真的关了，故先确认连它必然失败，再断言客户端给出的分类
    const err = await caught(() =>
      new ManagerClient({ baseUrl, token: "t", timeoutMs: 5000 }).status(),
    );
    expect(err.kind).toBe("transport");
    expect(err.code).toBe("unreachable");
    expect(err.status).toBeNull();
    // ⚠️ **重试判定必须按 `code` 而不是 `kind`**：只看 `kind` 会把「服务没起 / 地址敲错 /
    // 网络断了」也算成可重试，于是界面对着一个明显不对的地址提示「重试」，教人反复按一个
    // 不可能成功的按钮。`client.ts:transportFailure` 的函数头说的正是这件事（「重试没意义」）。
    // 唯一值得重试的是 `timeout`（对面在忙）。
    expect(isRetryable(err)).toBe(false);
    // 错误文案不许带上凭据：用一条不会与文案里任何词撞上的 canary
    const canaryToken = "tui-token-canary-4f1c9a";
    const withCanary = await caught(() =>
      new ManagerClient({ baseUrl, token: canaryToken, timeoutMs: 5000 }).status(),
    );
    expect(withCanary.message).not.toContain(canaryToken);
    expect(withCanary.message).toContain("连不上");
  });

  it("**连接被掐**（服务端中途 destroy）⇒ `transport`，且不是超时", async () => {
    double.route("GET /api/status", { destroy: true });
    const err = await caught(() => clientTo(double, { timeoutMs: 5000 }).status());
    expect(err.kind).toBe("transport");
    expect(err.code).toBe("unreachable");
    expect(err.status).toBeNull();
  });
});

describe("形状不对：`shape` 档（多半是对面版本与本包不一致）", () => {
  it('200 + `{"foo":1}` ⇒ `shape`，且文案点名缺的那个字段', async () => {
    double.route("GET /api/status", { json: { foo: 1 } });
    const err = await caught(() => clientTo(double).status());
    expect(err.kind).toBe("shape");
    expect(err.code).toBe("bad-shape");
    expect(err.message).toContain("process");
    // 「答了但不像本包声明的形状」没有 HTTP 状态码可言
    expect(err.status).toBeNull();
    expect(err.request).toBe("GET /api/status");
  });

  it("200 + **非 JSON 文本** ⇒ 同样 `shape`（对面根本不是控制面时也走这一档）", async () => {
    double.route("GET /api/status", { raw: "<!doctype html><title>nginx</title>" });
    const err = await caught(() => clientTo(double).status());
    expect(err.kind).toBe("shape");
    expect(err.message).toContain("GET /api/status");
  });

  it("200 + **空响应体** ⇒ `shape`（空不是「合法的空配置」）", async () => {
    double.route("GET /api/status", { raw: "" });
    const err = await caught(() => clientTo(double).status());
    expect(err.kind).toBe("shape");
  });

  it("`shape` 的文案**不转述**对面的 body（那串字节可能是凭据也可能是名单）", async () => {
    const canary = "s3cr3t-token-value-in-a-wrong-body";
    double.route("GET /api/status", { raw: canary });
    const err = await caught(() => clientTo(double).status());
    expect(err.message).not.toContain(canary);
    // 防假绿：文案变成空串也会绿 —— 故同时要求它真的说了点东西
    expect(err.message.length).toBeGreaterThan(0);
  });
});

describe("错误体不是错误形状：只给状态码一个中性说法", () => {
  it("500 + `{}` ⇒ `internal`，且**不编**具体原因", async () => {
    double.route("GET /api/status", { status: 500, json: {} });
    const err = await caught(() => clientTo(double).status());
    expect(err.kind).toBe("wire");
    expect(err.code).toBe("internal");
    expect(err.status).toBe(500);
    expect(err.requestId).toBeNull();
    expect(err.message).toContain("响应体不是它自己的错误格式");
    // 那句话里不许出现「异常 / 崩溃 / 超时 / 数据库」这类**编出来**的原因
    for (const invented of ["异常", "崩溃", "数据库", "超时", "OOM"]) {
      expect(err.message, `不许编「${invented}」`).not.toContain(invented);
    }
  });

  it("500 + 非 JSON ⇒ 同样只说「响应体不是它自己的错误格式」", async () => {
    double.route("GET /api/status", { status: 502, raw: "<html>Bad Gateway</html>" });
    const err = await caught(() => clientTo(double).status());
    expect(err.code).toBe("internal");
    expect(err.status).toBe(502);
    expect(err.message).toContain("响应体不是它自己的错误格式");
  });

  it("连错误体都**不是** JSON 时 `status` 仍是真的状态码（状态码来自响应行，不来自 body）", async () => {
    double.route("GET /api/status", { status: 503, raw: "upstream connect error" });
    const err = await caught(() => clientTo(double).status());
    expect(err.status).toBe(503);
    expect(err.code).toBe("internal");
  });

  it("状态码兜底只对**传输层自造**的四档做映射，5xx 一律 `internal`", async () => {
    for (const [status, code] of [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [404, "not-found"],
      [405, "method-not-allowed"],
      [400, "bad-request"],
      [500, "internal"],
      [501, "internal"],
      [502, "internal"],
      [503, "internal"],
    ] as Array<[number, string]>) {
      double.route("GET /api/status", { status, json: {} });
      const err = await caught(() => clientTo(double).status());
      expect(err.code, `${status} 的兜底分类不对`).toBe(code);
    }
  });
});

describe("写面：请求体、方法与幂等 no-op", () => {
  it("**`DELETE /api/acl` 确实带 body**，且是 `group` / `list` / `entry` 三键", async () => {
    // 服务端 `routes/input.ts:aclMutationInput` 收请求体（并与查询串不一致时报错）。
    // 很多 HTTP 客户端会在 DELETE 上丢 body —— 改用查询串就得在客户端多写一条分支，
    // 而那正是「删了 A 实际删了 B」那条事故最容易长出来的地方。
    double.route("DELETE /api/acl", { json: CHANGE_BODY });
    await clientTo(double).removeAclEntry({
      group: "target",
      list: "whitelist",
      entry: "ok.test",
    });
    const sent = double.seen[0];
    expect(sent.method).toBe("DELETE");
    expect(sent.path).toBe("/api/acl");
    expect(sent.body.length, "DELETE 丢了 body").toBeGreaterThan(0);
    expect(sent.contentType).toBe("application/json");
    expect(Object.keys(JSON.parse(sent.body) as object).sort()).toEqual(["entry", "group", "list"]);
    expect(JSON.parse(sent.body)).toEqual({
      group: "target",
      list: "whitelist",
      entry: "ok.test",
    });
    // 查询串那条通路**一次都不许带**（带了就得在客户端与判据之间同步两份形态）
    expect(sent.query).toBe("");
  });

  it("`POST /api/acl` 同样带这三个键（两个方法共用一份入参）", async () => {
    double.route("POST /api/acl", { json: CHANGE_BODY });
    await clientTo(double).addAclEntry({
      group: "clientip",
      list: "blacklist",
      entry: "10.0.0.0/8",
    });
    expect(JSON.parse(double.seen[0].body)).toEqual({
      group: "clientip",
      list: "blacklist",
      entry: "10.0.0.0/8",
    });
  });

  it("**`changed: false` 不是错误**：`addAclEntry` 正常 resolve，`message` 逐字保留", async () => {
    double.route("POST /api/acl", {
      json: {
        changed: false,
        message: "target.whitelist 里已经有 ok.test，没动",
        effective: null,
      },
    });
    const change = await clientTo(double).addAclEntry({
      group: "target",
      list: "whitelist",
      entry: "ok.test",
    });
    expect(change.changed).toBe(false);
    // 「一个字节都没动」这件事必须原样传上去：界面上要能说「没动」而不是说「已改」
    expect(change.message).toBe("target.whitelist 里已经有 ok.test，没动");
    expect(change.effective).toBeNull();
  });

  it("`removeAclEntry` 的 no-op 同样 resolve（移一条本来就没有的也是 200）", async () => {
    double.route("DELETE /api/acl", {
      json: {
        changed: false,
        message: "target.whitelist 里没有 never.test，没动",
        effective: null,
      },
    });
    const change = await clientTo(double).removeAclEntry({
      group: "target",
      list: "whitelist",
      entry: "never.test",
    });
    expect(change.changed).toBe(false);
    expect(change.message).toContain("没动");
  });

  it("空 patch 在**本地**先判：抛 `wire`/`invalid`，且一个请求都没发出去", async () => {
    const err = await caught(() => clientTo(double).updateAccount("alice", {}));
    expect(err.kind).toBe("wire");
    expect(err.code).toBe("invalid");
    expect(err.request).toBe("(未发出)");
    // 那一次注定被拒的往返是白花的：替身一个请求都没收到
    expect(double.seen).toHaveLength(0);
  });

  it("`assertNonEmptyPatch` 是可直接调的纯判据（界面上「保存」按钮可以在本地先禁用）", () => {
    expect(() => assertNonEmptyPatch({})).toThrow();
    expect(() => assertNonEmptyPatch({ disabled: false })).not.toThrow();
  });
});

describe("`:username` 真的进了路径", () => {
  it("含 `/` 的用户名以 `%2F` 上线，服务端看到的是**一个**路径段", async () => {
    // 本档最有价值的一条：mock 掉 fetch 时「服务端收到的 url」是测试自己编的，
    // 于是 `%2F` 变成裸 `/`（多切一段 → 请求打到另一个端点）也照样绿。
    double.route("GET /api/users/a%2Fb", {
      json: {
        account: {
          username: "a/b",
          password: { set: true },
          disabled: false,
          expiresAtIso: null,
        },
      },
    });
    const account = await clientTo(double).user("a/b");
    expect(account.username).toBe("a/b");
    expect(double.seen[0].url).toBe("/api/users/a%2Fb");
    expect(double.seen[0].path).toBe("/api/users/a%2Fb");
    // 裸 `/` 会把路径切成三段 ⇒ 请求落到另一个端点上
    expect(double.seen[0].path.split("/")).toHaveLength(4);
  });

  it("含 `?` / `#` 的用户名不会改写请求行（否则服务端**根本收不到**那段名字）", async () => {
    const cases: Array<[string, string]> = [
      ["a?b", "/api/users/a%3Fb"],
      ["a#b", "/api/users/a%23b"],
    ];
    for (const [name, expected] of cases) {
      double.route(`GET ${expected}`, {
        json: {
          account: { username: name, password: { set: true }, disabled: false, expiresAtIso: null },
        },
      });
      const before = double.seen.length;
      const account = await clientTo(double).user(name);
      expect(account.username).toBe(name);
      // 取**本次**那一条：判据锚在「刚刚发出去的那个请求」上，而不是整段历史的第 0 条
      const sent = double.seen[before];
      expect(sent.url, `${name} 改写了请求行`).toBe(expected);
      expect(sent.query, `${name} 起了一段查询串`).toBe("");
    }
  });

  it("`usageFor` 走同一套编码（读面与写面的穿越边界一样宽）", async () => {
    double.route("GET /api/usage/a%2Fb", {
      json: {
        usage: { user: "a/b", windowKey: "2026-10", total: 1 },
        errors: [],
        lagMs: 0,
        sideEffect: "物化",
        note: "不能清账",
      },
    });
    const body = await clientTo(double).usageFor("a/b");
    expect(body.usage.user).toBe("a/b");
    expect(double.seen[0].url).toBe("/api/usage/a%2Fb");
  });
});

describe("normalizeBaseUrl：把用户敲的地址收窄成可用的基址", () => {
  it("去尾斜杠（否则 `/api/status` 拼出 `//api/status`，服务端逐段比对 ⇒ 404）", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:3010/")).toBe("http://127.0.0.1:3010");
  });

  it("**只保留 origin**：尾路径被丢掉（那不是控制面的基址的一部分）", () => {
    expect(normalizeBaseUrl("http://h:3010/api")).toBe("http://h:3010");
    expect(normalizeBaseUrl("https://h/api/status/")).toBe("https://h");
  });

  it("首尾空白被吃掉（复制粘贴带进来的那个看不见的字符）", () => {
    expect(normalizeBaseUrl("  http://127.0.0.1:3010  ")).toBe("http://127.0.0.1:3010");
  });

  it("拒绝空串", () => {
    for (const raw of ["", "   "]) {
      expect(() => normalizeBaseUrl(raw), `${JSON.stringify(raw)} 必须被拒`).toThrow(TuiError);
    }
  });

  it("拒绝不是 URL 的文本", () => {
    for (const raw of ["not a url", "127.0.0.1:3010", "://h", "h:3010"]) {
      expect(() => normalizeBaseUrl(raw), `${JSON.stringify(raw)} 必须被拒`).toThrow(TuiError);
    }
  });

  it("拒绝非 http/https（`file:` / `ws:` 抛的是一句与地址无关的错）", () => {
    for (const raw of ["ftp://h", "ws://h:3010", "file:///etc/passwd"]) {
      const err = (() => {
        try {
          normalizeBaseUrl(raw);
          return null;
        } catch (e) {
          return e as TuiError;
        }
      })();
      expect(err, `${raw} 必须被拒`).toBeInstanceOf(TuiError);
      expect(err?.status).toBeNull(); // 本地判出来的失败没有 HTTP 状态码
    }
  });

  it("拒绝带 userinfo 的地址，且**错误文案里不含那段凭据**", async () => {
    // `fetch` 对带凭据的 URL 直接抛 TypeError，而那句话把密码印在栈里 ——
    // 故要在本地拦下，且拦下时的文案不许把那串 user:pass 重打一遍。
    // 用户名刻意不叫 `user`：错误文案里那句话本身含「user:pass」四个字，
    // 用 `user` 当凭据会让「文案不含凭据」这条判据与「文案确实说了这件事」那条互相打架。
    const err = await caught(async () => normalizeBaseUrl("http://alice:s3cr3t-pass@h:3010"));
    expect(err.message).not.toContain("alice");
    expect(err.message).not.toContain("s3cr3t-pass");
    expect(err.message).not.toContain("alice:s3cr3t-pass");
    expect(err.message).not.toContain("h:3010");
    // 防假绿：文案变成空串也绿 —— 故要求它真的说了「不许带 user:pass」这件事
    expect(err.message).toContain("user:pass");
  });

  it("`http:///x`（协议头后多一个斜杠）⇒ **拒掉**，不静默去连一台叫 `x` 的机器", () => {
    // ⚠️ 这条判据**必须在 `new URL` 之前按原始文本做**：WHATWG 解析把三个斜杠消解成
    // 「一个斜杠 + 主机分隔符」，`new URL("http:///x").hostname === "x"`（实测）。判
    // `url.hostname === ""` 那一支对 http/https 不可达（`http://:3010` / `http://@` /
    // `http://#f` 都在 `new URL()` 那里就抛了）。
    // 不拦的后果不是「连不上」，而是**连上一台无关的机器**：用户敲 `http:///api/status` 想连
    // 本机，实际会去连一台叫 `api` 的公网主机。
    for (const bad of ["http:///x", "http:///api/status", "https:///x", "HTTP:///x"]) {
      let caughtErr: TuiError | null = null;
      try {
        normalizeBaseUrl(bad);
      } catch (e) {
        caughtErr = e as TuiError;
      }
      expect(caughtErr, `${bad} 应当被拒`).toBeInstanceOf(TuiError);
      expect(caughtErr?.message).toContain("主机名");
    }
  });

  it("地址形状不合法 ⇒ `wire` / `invalid` / `LOCAL_REQUEST`（**不是** transport 档）", () => {
    // 「敲错地址」不是「网络层失败」：把它算成 transport 会让界面提示「检查网络与地址」，
    // 而操作者敲错的正是地址文本本身。`error.ts` 的 `TuiError.local` 刻意挂在 `wire` 档 +
    // `invalid` 码上——服务端对同样的坏输入回的**就是** `invalid`（`routes/input.ts`），
    // 同一种失败在两端同一个 code，界面只需要认一个。
    // ⚠️ `request` 恒为 `LOCAL_REQUEST` 且 `status` 恒为 `null`：界面上要把「地址敲错了、
    // 请求没出门」与「出了门被 401」显示成两件事，而后者一定有 status 与一个真实路径。
    for (const bad of ["", "   ", "not a url", "ftp://h:3010", "ws://h:3010", "file:///x"]) {
      const err = (() => {
        try {
          normalizeBaseUrl(bad);
          return null;
        } catch (e) {
          return e as TuiError;
        }
      })();
      expect(err, `${JSON.stringify(bad)} 应当抛 TuiError`).toBeInstanceOf(TuiError);
      expect(err?.kind).toBe("wire");
      expect(err?.code).toBe("invalid");
      expect(err?.status).toBeNull();
      expect(err?.request).toBe(LOCAL_REQUEST);
      // 本地输入错**不该**被提示重试
      expect(isRetryable(err as TuiError)).toBe(false);
    }
  });
});

describe("客户端自身带的那点元信息", () => {
  it("`info` 回连接参数；`knownEndpoints` 回端点表（界面显示「覆盖了哪些面」用）", () => {
    const client = clientTo(double);
    expect(client.info.baseUrl).toBe(double.baseUrl);
    expect(client.knownEndpoints).toHaveLength(12);
    expect(client.knownEndpoints.some((e) => e.path === "/api/usage/:username")).toBe(true);
  });
});
