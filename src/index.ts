/**
 * 库入口 - 纯导出，无副作用
 * 作为库被 import 时，仅暴露 ProxyServer/runServer 与配置读写 API，
 * 不读 env、不做配置校验、不启动服务。
 * 副作用（loader 初始化）与进程启动（require.main 分支）均已搬至 src/cli.ts，
 * CLI 构建（dist/app.js）以 cli.ts 为入口，启动语义不变。
 *
 * 注意：经由 "./server/index.js" 的传递 import 仍会加载 config/loader
 * （src/server/index.ts 首行 side-import，约束所限本文件未动），
 * 因此 import 本库仍会触发一次 initConfig；真正的零副作用需要
 * 后续把 server/index.ts 的 loader 导入也摘掉（另见报告）。
 */

export { ProxyServer, runServer } from "./server/index.js";
export { get, getAll, set } from "./config/store.js";
