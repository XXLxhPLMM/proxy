import koaRouter from "koa-router";
/**
 * 注册 路由
 * @param {koaRouter} router
 * @returns {koaRouter}
 */
export function createRouter() {
  const router = new koaRouter();
  return router;
}
