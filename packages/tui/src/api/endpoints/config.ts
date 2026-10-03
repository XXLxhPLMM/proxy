/**
 * @fileoverview 控制面端点表的 `config` 一段 —— 镜像根仓 `src/manager/routes/config.ts`
 * @module api/endpoints/config
 * @description
 * ⚠️ 手抄的弱耦合：这一段与那一侧那个文件里的 `(method, path)` **逐条相等**。牙齿在根仓
 * `tests/unit/manager-tui-contract.test.ts`（从**两侧源码文本**现取再比集合，不从任何一侧 import）。
 *
 * ⚠️ **只有读**：服务端刻意没有 `config` 的写端点（startup 相位的键只认「重启进程」这条路，见那一侧
 * `routes/index.ts` 的文件头）。别在本表补一条写端点去。
 *
 * @module
 */

/** `/api/config` 一条（全量配置，逐键 phase / restartRequired / 打码值 / 来源） */
export const CONFIG_ENDPOINTS = [{ method: "GET", path: "/api/config" }] as const;