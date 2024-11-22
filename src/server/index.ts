
import { createSocksProxy } from "./socksProxy";
import { createHttpProxy } from "./httpProxy";
import { getLogger } from "@/utils/log";
const SERVER_LOG = getLogger("server");
export function runServer() {
    const PORT = process.env.SERVER_PORT || 444;

    // process.on('uncaughtException',(err)=>{
    //     console.error(err)
    // })
    // createSocksProxy().listen(PORT, () => {
    //     console.log('服务以启动 端口:', PORT);
    // })
    createHttpProxy().listen(PORT, () => {
        SERVER_LOG.warn('服务以启动 端口:', PORT);
    });
}