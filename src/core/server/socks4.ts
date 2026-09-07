import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { SocksForwarder } from "@/core/forward/socks.js";
import { SOCKS4_REPLY_FAILURE } from "@/utils/constants.js";

export class Socks4Proxy extends BaseProxy
{
  protected server: net.Server | null = null;

  constructor(o: ProxyOptions = {})
  {
    super("socks4", o);
  }

  protected async doStart(): Promise<void>
  {
    const s = net.createServer((sock) =>
    {
      this.onConn(sock as unknown as Duplex);
    });

    await new Promise<void>((r, j) =>
    {
      s.once("error", j);
      s.listen(this.options.port, this.options.host, () =>
      {
        s.off("error", j);
        r();
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
      authority: "socks4",
    });

    if (!ok)
    {
      socket.write(SOCKS4_REPLY_FAILURE);
      socket.destroy();
      return;
    }

    new SocksForwarder((e) =>
    {
      this.emit("pipe", e as never);
    }).handle(socket, 4);
  }
}
