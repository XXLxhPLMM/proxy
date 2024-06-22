import { runServer } from "./client/index.js";

runServer(443)

process.on('uncaughtException', (error) => {
    console.error('Node异常出错');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('服务器异常出错 promise');
});
