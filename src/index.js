import { runServer } from "./server/index";

runServer()

process.on('uncaughtException', (error) => {
    console.error('Node异常出错', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('服务器异常出错 promise');
});
