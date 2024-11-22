import "./config/load";
import { runManager } from "./manager/index";
import { runServer } from "./server/index";
import { runClient } from "./client/index";
import { getLogger } from "@/utils/log";
const APP_LOG = getLogger('APP_LOG');
// 加载配置

((runables: { [key: string]: () => void }) => {
    APP_LOG.warn("Starting proxy...");
    runables[process.env.APP_MODE!]();
})({
    manager: runManager,
    server: runServer,
    client: runClient
})