import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { SocksForwarder } from "@/core/forward/socks.js";
import { SOCKS5_AUTH_REJECT } from "@/utils/constants.js";

export class Socks5Proxy extends BaseProxy
{
  protected server: net.Server | null = null;

  constructor(options: ProxyOptions = {})
  {
    super("socks5", options);
  }

  protected async doStart(): Promise<void>
  {
    const s = net.createServer((sock) =>
    {
      this.onConn(sock as unknown as Duplex);
    });

    await new Promise<void>((res, rej) =>
    {
      s.once("error", rej);
      s.listen(this.options.port, this.options.host, () =>
      {
        s.off("error", rej);
        res();
      });
    });

    s.on("error", (e) =>
    {
      this.setState("error");
      this.log.error(`server error:`, e);
    });

    this.server = s;
  }

  protected async doStop(): Promise<void>
  {
    if (!this.server)
    {
      return;
    }

    await new Promise<void>((r) =>
    {
      this.server!.close(() =>
      {
        r();
      });
    });

    this.server = null;
  }

  isRunning(): boolean
  {
    return !!this.server?.listening;
  }

  private async onConn(socket: Duplex): Promise<void>
  {
    socket.on("error", () =>
    {
      socket.destroy();
    });

    const ok = await this.authorize({
      protocol: this.protocol,
      req: { headers: {} },
      socket,
      authority: "socks5",
    });

    if (!ok)
    {
      socket.write(SOCKS5_AUTH_REJECT);
      socket.destroy();
      return;
    }

    new SocksForwarder((e) =>
    {
      this.emit("pipe", e as never);
    }).handle(socket, 5);
  }
}
