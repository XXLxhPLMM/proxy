/**
 * 本目录七档共用的那份 fixture：临时目录、注入的 logger、起在端口 0 的真 server 与一次 HTTP 往返
 *
 * @description
 * 收件门槛是「**两个以上档真用到**」，不是「看起来通用」。逐个核过之后只导出 15 个符号：
 * `logText` 与 `INTERNAL_SECRET_PATH` 只被 `errors.test.ts` 用（留在那档）、
 * `serveCors` 与它那批额外 server 的回收只被 `cors.test.ts` 用（留在那档）、
 * `DATA_LAYER_FORMS` / `classFromSource` / `syntaxHintExamples` 只被 `acl-entry.test.ts` 用（留在那档），
 * 而 `source-guards.test.ts` **一行都不引本模块** —— 它只读源码文本，起端口对它是纯开销。
 * ⚠️ `sources` 与 `server` 一个只当 `routesFor` 的缺省参数、一个只被 `afterEach` 用，故**不导出**。
 *
 * ⚠️ **住在这个目录，不搬进 `tests/helpers/`**：本模块 import `@/manager/http/index.js` 与
 * `@/manager/routes/index.js`，而 `tests/helpers/` 的门槛是「unit / integration / library 三族共用
 * 的零业务依赖工具面」——让一个公共 helper 去依赖某个被测层的 barrel，那条分层就失守了。
 *
 * ⚠️ 临时目录 + 真 server 挂在 `beforeEach` / `afterEach` 上：这一对钩子随本模块被导入而对
 * **导入它的每一档**生效，而 `_*.ts` 不带 `.test.ts`，vitest 不会把它收成一份空跑的空档。
 *
 * ⚠️ `UPSTREAM_URL` 的 `.invalid` 必须逐字保留：它在零外网扫描器的 `RESERVED_TLDS` 内（不判公网），
 * 换成真 host 就等于给那道护栏开一个洞，而 `/api/config` 的 userinfo 打码断言依赖它。
 *
 * @module tests/unit/manager/http
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { resolveOpsSources, type OpsSources } from "@/ops/index.js";
import {
  createManagerServer,
  MAX_BODY_BYTES,
  NO_CORS,
  type CorsPolicy,
  type Route,
} from "@/manager/http/index.js";
import { managerRoutes, type DataPlaneStatus } from "@/manager/routes/index.js";
import { createLogger, type LoggerImpl } from "@/utils/logger/index.js";

/**
 * 四枚「绝不出现在响应或落盘日志里」的明文探针
 * @description
 * 导出是因为 `endpoints.test.ts` 的打码那档要**逐个核对**它们不在 `/api/config` 的响应里，
 * 而断言若自己另抄一份探针，它验的就是另一个值 —— 恒绿。
 */
export const TOKEN = "mgr-http-canary-4f1c9a";
export const JWT_SECRET = "jwt-plaintext-canary-6b21";
export const PASSPHRASE = "passphrase-canary-9d33";
export const UPSTREAM_PASSWORD = "upstream-plaintext-canary-1e77";

/** 每条用例的临时目录：`beforeEach` 换一个新的 `mkdtemp`，`afterEach` 删掉它 */
export let dir = "";
/** 落盘日志目录（零泄露那组断言的是**日志文件里真实写了什么**，故这层 logger 必须真的落盘） */
let logDir = "";
/** 这份 fixture 默认的数据源接线（只作 {@link routesFor} 的缺省参数，故不导出） */
let sources: OpsSources;
export let logger: LoggerImpl;
let server: http.Server;
/** 默认那个真 server 的端口：起在 0 上 ⇒ 每条用例的端口都不同，故必须经它读 */
export let port = 0;

/**
 * 假数据面活状态（本目录盯的是 HTTP 契约，不是数据面本身）
 * @description
 * 每次 `GET /api/status` 现读，故改 `dataPlane.value` 后紧跟着的那次请求就会看到新值。
 * ⚠️ 它必须住在共用模块里而由 `status.test.ts` 改：生产者是 `routesFor()`（几档共用），
 * 消费者是那一档 —— 这是「共用 fixture 的可变旋钮」，不是一层没人说得清的间接层。
 */
export const dataPlane = {
  value: {
    mode: "running",
    protocol: "http",
    host: "0.0.0.0",
    port: 3000,
    running: true,
    startedAt: 1_700_000_000_000,
    uptimeMs: 1234,
  } as DataPlaneStatus,
};

/**
 * 借组合根的装配拿路由表（各档不测装配本身；装配另有 `../control-plane.test.ts`）
 * @description
 * 缺省参数是这份 fixture 的数据源接线，于是「用默认那份」的两档不必把 `sources` 引进自己的文件头；
 * 显式传参的三处（只读驱动 / 空密钥 / 真读过某个 env 文件）不受影响。
 */
export function routesFor(s: OpsSources = sources): Route[] {
  return managerRoutes({ sources: s, processFacts: processFacts(), dataPlane: () => dataPlane.value });
}

export function writeUsers(body: unknown): void {
  fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cfg", "users.json"), JSON.stringify(body, null, 2));
}

/** 与 {@link writeUsers} 成对：名单条目那档要手改进 `acl.json` 再经 HTTP 删掉 */
export function writeAcl(body: unknown): void {
  fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cfg", "acl.json"), JSON.stringify(body, null, 2));
}

export function usersFile(): string {
  return path.join(dir, "cfg", "users.json");
}

export const EMPTY_ACL_DOC = {
  clientIp: { whitelist: [], blacklist: [] },
  target: { whitelist: [], blacklist: [] },
  upstream: { whitelist: [], blacklist: [] },
};

/**
 * 起一个真服务器（端口 0 → 随机端口），返回它
 * @description
 * 收尾归调用方（跨源那一档在 `cors.test.ts` 里另起并各自回收）—— 默认那个面由 `afterEach` 关。
 */
export async function serve(
  routes: readonly Route[],
  cors: CorsPolicy = NO_CORS,
): Promise<{ port: number; server: http.Server }> {
  const s = createManagerServer({
    token: TOKEN,
    routes,
    logger,
    maxBodyBytes: MAX_BODY_BYTES,
    cors,
  });
  await new Promise<void>((resolve) => {
    s.listen(0, "127.0.0.1", () => resolve());
  });
  return { port: (s.address() as { port: number }).port, server: s };
}

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly raw: string;
  readonly json: Record<string, unknown> | null;
}

/**
 * 打一次真 HTTP 并把响应整个收回来
 * @description
 * 各档断言的形状是**线上字节与真响应头**（状态码 / 头 / 原始体），所以这层刻意不做任何归一：
 * `Content-Length` 与实际字节的一致性、`writeHead` 之后再 `setHeader` 不生效、
 * 销毁连接的时机 —— 这三样只有真 socket 上才看得见，mock 掉 `node:http` 的档全部测不到。
 */
export function call(
  target: number,
  options: {
    method?: string;
    path?: string;
    token?: string | null;
    body?: unknown;
    rawBody?: string;
    /** 额外请求头（跨源组用 `Origin` / `Access-Control-Request-Method` / `Access-Control-Request-Headers`） */
    headers?: Record<string, string>;
  } = {},
): Promise<Reply> {
  const method = options.method ?? "GET";
  const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.token !== null) {
      headers.Authorization = `Bearer ${options.token ?? TOKEN}`;
    }
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    Object.assign(headers, options.headers);
    const req = http.request(
      { host: "127.0.0.1", port: target, method, path: options.path ?? "/api/status", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> | null = null;
          try {
            json = raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

function processFacts() {
  return {
    pid: 999,
    startedAt: Date.now(),
    node: process.version,
    platform: process.platform,
    cwd: dir,
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-http-"));
  logDir = path.join(dir, "logs");
  writeUsers([]);
  writeAcl(EMPTY_ACL_DOC);
  logger = createLogger({ file: logDir, level: "silent", fileLevel: "debug" });
  sources = await resolveOpsSources(
    {
      NODE_ENV: "development",
      MANAGER_ENABLED: "true",
      MANAGER_TOKEN: TOKEN,
      JWT_SECRET,
      TLS_PASSPHRASE: PASSPHRASE,
      UPSTREAM_PASSWORD,
      UPSTREAM_URL: "http://user1:pw1@upstream.invalid:8080",
      QUOTA_USAGE_DIR: path.join(dir, "cfg", "usage"),
    },
    dir,
  );
  const started = await serve(routesFor());
  port = started.port;
  server = started.server;
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不应遮蔽用例结论
  }
});
