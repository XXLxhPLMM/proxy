/**
 * @fileoverview `GET /api/config` —— **只读**的全量配置，逐键标注相位 / 打码值 / 来源
 * @module manager/routes/config
 * @description
 * 「改这个键要不要重启」与「它现在是什么值」是同一个问题的一半。另一半是「它从哪来的」——
 * 运维改完 `.env` 发现没生效时，需要知道那个键**此刻**是被 env 文件、宿主 env、CLI 还是
 * 缺省决定的。本端点把这三样一次给全，避免「改了 → 没生效 → 猜」的循环。
 *
 * ## 本端点是**只读**的，且刻意**没有**对应的写端点
 *
 * 它是 `GET`。改配置要走**改 env 文件 / 宿主环境**那条路然后 `POST /api/restart` ——
 * 配置的真相源在文件与宿主环境里，让 HTTP 直接写 store 会造出**第三份**配置状态
 * （store 热改 / 文件 / env），而重启后只有前两者留下。这正是本仓反复拒绝的形状。
 * 「不提供」在这里是**有意的设计决定**，不是「还没做」。
 *
 * ## 打码判据**只有一份**
 *
 * `reportConfigKeys`（`@/ops`）里的 `CONFIG_SECRET_KEYS` 与
 * `src/server/log/config-log.ts` 的启动快照脱敏是同一条判据（`jwtSecret` /
 * `tlsPassphrase` / `upstreamPassword` / `managerToken`，外加 `upstreamUrl` 的 userinfo）。
 * 传输层**不再**自己判一次——两份清单漂了的后果是「日志里打码了、HTTP 里明文」或反过来。
 *
 * 本模块**零 console、零 process**。
 *
 * @module
 */

import { reportConfigKeys, type OpsSources } from "@/ops/index.js";
import { reply, type Route } from "../http/index.js";

/** 装配这个端点所需的依赖 */
export interface ConfigRouteDeps {
  readonly sources: OpsSources;
}

/**
 * 构造 `GET /api/config` 的路由
 * @description
 * 响应体：
 * ```
 * {
 *   configDir, envFiles,
 *   keys: [{ key, env, phase, restartRequired, secret, value, fileOrigin, fromEnv, fromArgv }, …],
 *   summary: { total, startup, runtime, secrets }
 * }
 * ```
 * `phase` 与 `restartRequired` 一起给（后者由前者派生）：前者是字段元数据的原样搬运，
 * 后者是**传输层对它的解读**（startup = 改完必须重启进程）。两个都给的代价是多一个字段，
 * 换来的是调用方不必自己写 `phase === "startup"`。
 *
 * @param deps - 见 {@link ConfigRouteDeps}
 * @returns 路由
 */
export function configRoute(deps: ConfigRouteDeps): Route {
  const { sources } = deps;
  return {
    method: "GET",
    path: "/api/config",
    handler: () => {
      const snapshot = reportConfigKeys(sources);
      const keys = snapshot.keys.map((k) => ({
        key: k.key,
        env: k.env,
        phase: k.phase,
        // startup 相位 = 该键在启动期被捕获一次，运行中改它**没有任何效果**
        restartRequired: k.phase === "startup",
        secret: k.secret,
        value: k.value,
        fileOrigin: k.fileOrigin,
        fromEnv: k.fromEnv,
        fromArgv: k.fromArgv,
      }));
      return reply(200, {
        configDir: snapshot.configDir,
        envFiles: snapshot.envFiles,
        keys,
        summary: {
          total: keys.length,
          startup: keys.filter((k) => k.restartRequired).length,
          runtime: keys.filter((k) => !k.restartRequired).length,
          // 点名「哪几个键是打码的」：调用方不必猜哪几项的 `***` 意味着「配了但不给你看」
          secrets: keys.filter((k) => k.secret).map((k) => k.key),
        },
      });
    },
  };
}
