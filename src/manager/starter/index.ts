import Koa from "koa";
import KoaRouter from "koa-router";
import { Server } from "socket.io";
import http from "http";
/**
 * 启动管理器  单线程运行 管理器
 * @param router 路由数组
 * @param  middlewares
 * @returns 应用实例
 */
export function createApp(router?:KoaRouter, middlewares?:Koa.Middleware[]) {
  // 实例化  应用
  const app = new Koa();
  // zzz中间件
  middlewares && middlewares.forEach((middleware) => app.use(middleware));
  // 创建路由
  router && app.use(router.routes());
  const server = http.createServer(app.callback());
  const io = new Server(server);
  return { app, server, io };
}

