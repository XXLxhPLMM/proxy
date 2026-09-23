import { set } from "@/config/store.js";
import type { ProxyCore, ProxyOptions } from "@/core/types/proxy.js";
import { getFreePort } from "./net.js";

/** 在空闲端口起真代理，先 set host/port 再 new，运行完自动 stop */
export async function withProxy<T extends ProxyCore>(
  Cls: new (opts: ProxyOptions) => T,
  opts: ProxyOptions,
  fn: (port: number, proxy: T) => Promise<void>,
): Promise<void> {
  const port = await getFreePort();
  set("port", port);
  const p = new Cls({ host: "127.0.0.1", port, ...opts });
  await p.start();
  try {
    await fn(port, p);
  } finally {
    await p.stop().catch(() => {});
  }
}
