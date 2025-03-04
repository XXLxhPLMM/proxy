import koa from 'koa';
import { getLogger } from '@/utils/log';
import { runClient } from "@/client/index";
import Router from 'koa-router';
const PROT = process.env.INTERMEDIARY_PORT || 3000;
const INTERMEDIARY_LOG = getLogger('intermediary');
export function runIntermediary() {
    const app = new koa();
    const router = new Router();
    INTERMEDIARY_LOG.warn("Starting proxy...");
    runClient()
    app.use(async (ctx, next) => {
        router.get('/(.*)', async (ctx, next) => {  

        })
        INTERMEDIARY_LOG.info(`代理请求 ${ctx.method} ${ctx.url} - ms`);
    });
    // app.
    app.listen(PROT,()=>{
        INTERMEDIARY_LOG.info(`Intermediary server is running on port ${PROT}`);
    });
}