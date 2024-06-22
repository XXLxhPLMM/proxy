import { runServer } from "./server/index.js";

runServer(444)

process.on('uncaughtException', (error) => {
    console.error('Node异常出错', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('服务器异常出错 promise');
});
