/**
 * @fileoverview 本机台账（`~/.swain-proxy/`）的唯一出口
 * @module store/index
 * @description `src/store/` 这一层管「清单与激活状态存在哪儿、长什么样、怎么改、怎么变成
 * 一组能发请求的连接」。⚠️ **key 是明文存的**，防线是目录 `0700` + 文件 `0600` + 位置约定 +
 * `redactManager` 是它离开本层的唯一出口。
 */

export {
  ENV_MAX_MEMBERS,
  createEnv,
  envByName,
  readEnvs,
  removeEnv,
  setEnvMembers,
  writeEnvs,
  type EnvInput,
  type EnvRecord,
} from "./envs.js";
export {
  REDACTED_KEY,
  TIMEOUT_BOUNDS,
  addManager,
  managerById,
  managerByRef,
  nextId,
  readManagers,
  redactManager,
  removeManager,
  slugify,
  updateManager,
  writeManagers,
  type ManagerInput,
  type ManagerPatch,
  type ManagerRecord,
  type ManagerView,
} from "./managers.js";
export { activeEnvName, activateEnv, deactivateEnv, deactivateIfActive } from "./session.js";
export { resolveTargets, type Target, type TargetScope } from "./targets.js";
export {
  CONFIG_DIR_NAME,
  ENVS_FILE,
  MANAGERS_FILE,
  configDir,
  envsPath,
  managersPath,
} from "../utils/json-file.js";
