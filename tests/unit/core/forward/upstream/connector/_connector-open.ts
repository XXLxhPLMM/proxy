/**
 * 三个 `open()` 档共用的入参与收尾面
 *
 * @description
 * 只放**两个以上档真用到**的东西：`DEST` / `UPSTREAM_USER` / `makeClient` / `OPEN_ENDS`
 * 三个档都用（`UPSTREAM_BASIC`、`DEST_PORT_*`、各假上游桩、`openCtx` 各只服务一档，留在那一档里）。
 * ⚠️ 本模块刻意住在 `tests/unit/` 里面而不是 `tests/helpers/`：后者不在零外网扫描的
 * `SCAN_DIRS` 里，前导搬进去等于让那道护栏对这部分代码彻底失效且一声不吭。
 */
import { afterEach } from "vitest";
import net from "node:net";
import { PassThrough, type Duplex } from "node:stream";

/** 上游账号：`open()` 族三档共用的凭证字面量（Base64 值在用到它的档里就地算） */
export const UPSTREAM_USER = "up-user";

/** 目标三元组（域名型，避开本机解析差异） */
export const DEST = { host: "target.example", port: 8443 };

/** 每个用例登记自己起的 server / client，`afterEach` 统一收尾（禁止残留长跑进程） */
export interface Tally {
  server?: net.Server;
  client?: Duplex;
  sock?: Duplex;
}

export const OPEN_ENDS: Tally[] = [];

afterEach(async () => {
  while (OPEN_ENDS.length) {
    const t = OPEN_ENDS.pop() as Tally;

    for (const s of [t.sock, t.client]) {
      if (s && !s.destroyed) {
        s.destroy();
      }
    }

    if (t.server) {
      await new Promise<void>((resolve) => t.server?.close(() => resolve()));
    }
  }
});

/** 建一个哑 client（PassThrough）并登记收尾；同时收集它收到的字节（应恒为空） */
export function makeClient(): { client: Duplex; seen: Buffer[] } {
  const client = new PassThrough() as unknown as Duplex;
  const seen: Buffer[] = [];

  client.on("data", (c: Buffer) => seen.push(c));
  client.on("error", () => {});
  OPEN_ENDS.push({ client });

  return { client, seen };
}
