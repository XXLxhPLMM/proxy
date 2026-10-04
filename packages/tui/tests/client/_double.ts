/**
 * 替身控制面 —— 本目录各档共用的那副台子
 *
 * @description
 * 为什么这里必须是**真 `http.Server`**（理由逐条见 `@module` 那份不变量），以及为什么替身**每个用例自己起、
 * 自己关**（不与别的用例共享端口或 token）：
 *
 * - **零模块期副作用**：起服务器的动作全在 `startDouble()` 函数体内。
 *   ⚠️ 若把这个调用提到模块作用域，则**每个 import 本模块的档都会在 import 时开一个端口** ——
 *   于是端口泄漏、且一个不用替身的档也被迫挂一个 listener。
 * - **`close()` 必须对同一个实例调第二次也不挂住**：有一档会在用例体内先 `close()` 一次（「服务已关」那条），
 *   而 `afterEach` 还会再调一次；`server.close()` 传回一个错**也会**回调，故那条 Promise 照样落地。
 * - **每档自己注册 `beforeEach` / `afterEach`**（hooks 是逐文件注册的，没有「装一次全局生效」这回事）：
 *   抄走这两行的那一档，忘了抄 `afterEach` 的那一档，症状是**整个 vitest 进程挂着不退**。
 *
 * 样本载荷（`STATUS_BODY` / `CHANGE_BODY`）**只被序列化、不被改写**（`startDouble` 里走的是
 * `JSON.stringify`），故可由多个档共用同一份。
 */

import http from "node:http";
import { expect } from "vitest";
import { TuiError } from "@/lib/index.js";
import { ManagerClient, type ManagerEndpoint } from "@/services/index.js";
/** 替身记下的一个请求（断言的对象就是这些线上事实） */
export interface Recorded {
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
export interface Reply {
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

export type ReplySpec = Reply | ((rec: Recorded) => Reply | undefined);

export interface Double {
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
export async function startDouble(): Promise<Double> {
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

/** 造一个对着替身的客户端（token 与替身一致 ⇒ 鉴权过） */
export function clientTo(dbl: Double, overrides: Partial<ManagerEndpoint> = {}): ManagerClient {
  return new ManagerClient({
    baseUrl: dbl.baseUrl,
    token: dbl.token,
    timeoutMs: 5000,
    ...overrides,
  });
}

/** 跑一次调用并取回抛出的 `TuiError`（没抛时显式失败） */
export async function caught(run: () => Promise<unknown>): Promise<TuiError> {
  try {
    await run();
  } catch (err) {
    expect(err, "失败必须抛 TuiError").toBeInstanceOf(TuiError);
    return err as TuiError;
  }
  throw new Error("判据：本次调用应当抛 TuiError（实际没抛）");
}

/** 一份最小可解码的 status 样本（各端点成功路径只需要「形状对」） */
export const STATUS_BODY = {
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

export const CHANGE_BODY = { changed: true, message: "已更新" };
