import koa from 'koa';
import { getLogger } from '@/utils/log';
import { runClient } from "@/client/index";
import { ConfigMap } from '@/config/load';
import Router from 'koa-router';
const INTERMEDIARY_LOG = getLogger('intermediary');
const PORT = () => ConfigMap.intermediary_port
export function runIntermediary() {
    const app = new koa();
    const router = new Router();
    INTERMEDIARY_LOG.warn("Starting proxy...");
    // 启动代理客户端
    const client = runClient()
    app.use(async (ctx, next) => {
        ctx.body = "Hello, world!";
        INTERMEDIARY_LOG.debug(`代理请求`);
        next();
    });
    app.on("close", () => {
        client.close()
    })
    app.listen(PORT(), () => {
        INTERMEDIARY_LOG.info(`Intermediary server is running on port ${PORT()}`);
    });
    return {
        app,
        client
    }
}