import type { ProxyCore, ProxyOptions } from "@/core/types/proxy.js";
import { getFreePort } from "./net.js";
import { testConfig } from "./config.js";

/** 在空闲端口起真代理，显式注入测试 accessor，运行完自动 stop。 */
export async function withProxy<T extends ProxyCore>(
  Cls: new (opts: ProxyOptions) => T,
  opts: Partial<ProxyOptions>,
  fn: (port: number, proxy: T) => Promise<void>,
): Promise<void> {
  const port = await getFreePort();
  const p = new Cls({
    host: "127.0.0.1",
    port,
    ...opts,
    config: opts.config ?? testConfig,
  });
  await p.start();
  try {
    await fn(port, p);
  } finally {
    await p.stop().catch(() => {});
  }
}
