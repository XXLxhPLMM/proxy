// 加载配置
import { runManager } from "./manager/index";
import { runServer } from "./server/index";
import { runClient } from "./client/index";
import { runIntermediary } from "./intermediary";
import { getLogger } from "@/utils/log";
import { ConfigMap } from "./config/load";
const APP_LOG = getLogger('APP_LOG');

/**
 * 根据环境变量启动对应的运行模式
 * manager模式：启动manager
 * server模式：启动server
 * client模式：启动client
 */
function run() {
    return ((runables: { [key: string]: () => void }) => {
        APP_LOG.info("Starting proxy... version: ", process.env.APP_VERSION);
        if (ConfigMap.use_ip_filter && process.env.APP_MODE === "server"){
            APP_LOG.warn("IP filter is enabled -- 已开启ip过滤")
        }
        return runables[process.env.APP_MODE!]();
    })({
        manager: runManager,
        server: runServer,
        client: runClient,
        intermediary: runIntermediary
    })
}
if (process.env.DIRECT_STARTING as any == 'true') {
    run()
}
export { run, runManager, runServer, runClient, runIntermediary };

process.on('uncaughtException', (e) => {
    APP_LOG.error('进程出错')
    APP_LOG.debug(e)
})
