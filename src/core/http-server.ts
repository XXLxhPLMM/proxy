import http from "node:http";
import { get } from "../config/store.js";

export class HttpServer {
  private server: http.Server;

  constructor() {
    this.server = http.createServer();
  }

  get port(): number {
    return get("port");
  }

  get host(): string {
    return get("host");
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        resolve();
      });
    });
  }
}
