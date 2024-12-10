
import { createSocksProxy } from "./socksProxy";
import { createHttpProxy } from "./httpProxy";
import { getLogger } from "@/utils/log";
const SERVER_LOG = getLogger("server");
import { authHandler } from "./auth";
export function runServer() {
    const PORT = process.env.SERVER_PORT || process.env.PORT || 444;

    // process.on('uncaughtException',(err)=>{
    //     console.error(err)
    // })
    // createSocksProxy().listen(PORT, () => {
    //     console.log('服务以启动 端口:', PORT);
    // })
    createHttpProxy(authHandler).listen(PORT, () => {
        SERVER_LOG.warn('服务已启动 端口:', PORT);
    });
}