/**
 * normalize 层出口：配置副本的路径/URL 归一化。
 *
 * 全部纯内存，不读 env/argv/文件，不触碰宿主环境。
 */

export { resolveConfigPaths } from "./paths.js";
export { applyUpstreamUrlToConfig, type ExplicitlyProvided } from "./upstream.js";
export {
  prepareRuntimeConfig,
  prepareRuntimeConfigStore,
  type PreparedRuntimeConfig,
} from "./prepare.js";
