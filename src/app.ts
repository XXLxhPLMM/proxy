import { loadConfig } from "./config/load";
import { runManager } from "./manager/index";
import { runServer } from "./server/index";
import { runClient } from "./client/index";

// 加载配置
loadConfig();
((runables: { [key: string]: () => void }) => {
    console.log("Starting proxy...");
    runables[process.env.APP_MODE!]();
})({
    manager: runManager,
    server: runServer,
    client: runClient
})