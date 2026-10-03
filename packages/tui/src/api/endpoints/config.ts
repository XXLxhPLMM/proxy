/** @fileoverview 端点表的 `config` 一段 —— 镜像根仓 `src/manager/routes/config.ts`（⚠️ 手抄的弱耦合） */

/** 全量配置，逐键 phase / restartRequired / 打码值 / 来源；⚠️ **只有读**：服务端刻意没有写端点 */
export const CONFIG_ENDPOINTS = [{ method: "GET", path: "/api/config" }] as const;
