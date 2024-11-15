
import { createApp } from "./starter/index";
import { createRouter } from "./router/index";
import { SocketConnectServer } from "./router/index";
export function runManager() {

    // 获取 启动端口
    const ManagerPort = process.env.PORT || 3000;

    // 启动应用
    const { server, io } = createApp(createRouter());
    new SocketConnectServer(io)
    server.listen(ManagerPort, () => {
        console.log(`Manager server is running at http://localhost:${ManagerPort}`);
    });
}
