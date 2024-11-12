import koaRouter from "koa-router";

/**
 * 注册 路由
 * @param {koaRouter} router
 */
export function createRouter(router) {
  router.get("/query", async (ctx, next) => {
    console.log(ctx.request.query);
    ctx.body = "query";
  });

  router.post(
    "/form",
    multer({ storage: multer.diskStorage({ destination: "./temp" }) }).fields([
      { name: "avatar", maxCount: 1 },
      { name: "gallery", maxCount: 10 },
    ]),
    async (ctx, next) => {
      console.log(ctx.request.file, ctx.request.files);
      console.log(ctx.request.body);
      ctx.body = "form";
    }
  );
  router.all("/json", async (ctx, next) => {
    console.log(ctx.request.body);
    ctx.body = "json";
  });
}
