// 加载配置
import "./config/load";
import { runManager } from "./manager/index";
import { runServer } from "./server/index";
import { runClient } from "./client/index";
import { getLogger } from "@/utils/log";
const APP_LOG = getLogger('APP_LOG');

/**
 * 根据环境变量启动对应的运行模式
 * manager模式：启动manager
 * server模式：启动server
 * client模式：启动client
 */
function run(runables: { [key: string]: () => void }) {
    APP_LOG.warn("Starting proxy...");
    runables[process.env.APP_MODE!]();
}
if (process.env.DIRECT_STARTING as any == 'true') {
    run({
        manager: runManager,
        server: runServer,
        client: runClient
    })
}
export { run };

process.on('uncaughtException', (e) => {
    APP_LOG.error('进程出错')
    APP_LOG.debug(e)
})
