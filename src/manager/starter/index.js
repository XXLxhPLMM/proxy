import Koa from "koa";
import KoaRouter from "koa-router";

/**
 * 启动管理器  单线程运行 管理器
 * @param { number } port 端口
 * @param { Array<KoaRouter> } routers 路由数组
 * @param { ()=>void } listen 监听函数
 */
export function start(port, routers, listen) {
  // 实例化  应用
  const app = new Koa();
  // 创建路由
  routers && routers.forEach((router) => app.use(router.routes()));
  app.listen(port, listen);
}
// export function start(port) {
//   const numCPUs = os.cpus().length;
//   // 判断是否为 主进程
//   if (!cluster.isWorker) {
//     console.log(`${process.pid} is running`);
//     // 衍生工作进程。
//     for (let i = 0; i < numCPUs; i++) {
//       cluster.fork();
//     }
//     cluster.on("exit", (worker, code, signal) => {
//       console.log(`worker ${worker.process.pid} died`);
//     });
//   } else {
//     const app = new koa();
//     app.use(koaBody());
//     const router = new koaRouter();

//     app.use(router.routes());
//     const server = http.createServer(app.callback());
//     const io = new Server(server);

//     // Socket.IO事件监听
//     io.on("connection", (socket) => {
//       console.log("一个用户已连接");

//       socket.on("disconnect", () => {
//         console.log("用户已断开连接");
//       });

//       // 监听客户端发来的'chat message'事件
//       socket.on("chat message", (msg) => {
//         io.emit("chat message", msg);
//       });

//       // 你还可以监听和处理更多的事件...
//     });
//     server.on("connect", (req, socket, head) => {
//       console.log(`客户端 ${req.socket.address()}已连接`);
//     });
//     server.on("connection", async (socket) => {
//       console.log("服务器端已连接");
//     });
//     server.listen(port, () => {
//       console.log("服务器已经启动在端口 3000");
//     });
//   }
//   return app;
// }
