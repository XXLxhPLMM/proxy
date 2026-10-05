/**
 * @fileoverview 测试用的**真**控制面打桩 —— `node:http` 起一个监听，逐字记录它收到的请求
 * @module tests/api/stub
 * @description
 * ⚠️ **刻意不 mock axios**：`src/utils/request.ts` 里最要紧的几段（`Authorization` 头、
 * `Content-Type` 的出现时机、4xx 错误体翻译、非对象响应体的判定）全都在 axios 这一层的
 * 后面，mock 掉 axios 就等于把这些恰恰要验的东西一起 mock 掉了。打真 socket 才验得到。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  readonly method: string;
  /** 原始 `req.url`（含 query），未经解码 */
  readonly url: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** 请求体原文；无体请求是空串 */
  readonly rawBody: string;
  /** `rawBody` 的 JSON 解析结果；无体请求是 `undefined` */
  readonly body: unknown;
}

export interface StubReply {
  readonly status: number;
  /** 直接作为响应体写出；`undefined` 表示空体 */
  readonly body?: unknown;
  readonly contentType?: string;
}

export type StubHandler = (req: RecordedRequest) => StubReply | Promise<StubReply>;

export interface ControlPlaneStub {
  readonly baseUrl: string;
  readonly requests: readonly RecordedRequest[];
  last(): RecordedRequest;
  close(): Promise<void>;
}

export async function startStub(handler: StubHandler): Promise<ControlPlaneStub> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);
    const url = req.url ?? "/";
    const recorded: RecordedRequest = {
      method: req.method ?? "",
      url,
      path: url.split("?")[0] ?? url,
      headers: { ...req.headers },
      rawBody,
      body: rawBody === "" ? undefined : safeParse(rawBody),
    };
    requests.push(recorded);

    const reply = await handler(recorded);
    res.statusCode = reply.status;
    if (reply.body === undefined) {
      res.end();
      return;
    }
    res.setHeader("Content-Type", reply.contentType ?? "application/json; charset=utf-8");
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    last(): RecordedRequest {
      const req = requests[requests.length - 1];
      if (req === undefined) {
        throw new Error("打桩一个请求都没收到");
      }
      return req;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined && err !== null) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
