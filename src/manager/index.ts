import { loadConfig } from "./config/load";
import { createApp } from "./starter/index";
import { createRouter } from "./router/index";
// 加载配置
loadConfig();
// 获取 启动端口
const ManagerPort = process.env.PORT || 3000;

// 启动应用
const {server} = createApp(createRouter());

server.listen(ManagerPort, () => {

    console.log(`Manager server is running at http://localhost:${ManagerPort}`);
});

