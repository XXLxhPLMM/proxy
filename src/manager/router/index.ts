import koaRouter from "koa-router";
import { Server } from "socket.io";
/**
 * 注册 路由
 * @returns 
 */
export function createRouter() {
  const router = new koaRouter();
  return router;
}

/**
 * 连接器
 */
export class SocketConnectServer{
  #io: Server | null = null;
  constructor(io: Server) {
    this.#io = io;
    io.on("connection", (socket) => {
      
      console.log("a user connected");
    });
  }
  
}