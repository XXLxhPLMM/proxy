/**
 * @fileoverview 控制面装配 —— 同一进程里起（不开就什么都不做）那个 HTTP 面
 * @module manager/control-plane
 * @description
 * 这是控制面唯一的**编排点**：`@/ops` 的数据源 + `@/manager/http` 的传输 + 路由表 + 一个
 * 真实 `listen`，产出��个可关的句柄。它与数据面**同进程**——组合根（`src/cli.ts`）在
 * `runServer` 之前调 {@link startControlPlane}，于是「配置说开这个面，它就开着」是一条
 * 装配期事实，而不是运行期某次 spawn 的结果。
 *
 * ## 为什么**不开就什么都不做**（而不是像 `proxy-manager` 那样非零码退出）
 * @description
 * 那个退出码形状的前提是「操作者敲了一个专门的命令，而它什么也没做」。合并之后没有那个
 * 命令了：`MANAGER_ENABLED` 缺省 `false`，而缺省**就是**「不开这个面」。为一个缺省分支
 * 打印一段话并退出非零，会让 `MANAGER_ENABLED` 未设的部署**整个起不来**——那是把一个
 * 可选功能变成了启动闸门。
 *
 * 空 token 的 fail-closed 纪律**一点没松**，只是换了执行点：`assertManagerConfig` 在
 * `loadConfig` 里就中止（`MANAGER_ENABLED=true` + 空 token），那是**启动期**判据，
 * 比运行期拒每一个请求更早也更便宜。见 `src/config/schema/validate.ts`。
 *
 * ## 数据面**先**、控制面**后**
 * @description
 * 顺序是硬要求：先开控制面再起数据面，会在「数据面压根起不来」（端口被占 / 证书缺失 /
 * 账号表非法）时先占住排障要用的那个管理端口，而操作者此刻最需要的正是「把服务跑起来，
 * 别挡我的路」。
 *
 * ## 停机由**数据面的停机流程**触发，不是本模块自己收信号
 * @description
 * 本模块返回的句柄只被组合根用在两处：`runServer` 抛错时关掉它（不留下一个还在监听、
 * 却已经没有数据面的控制面），以及停机时先关它再让数据面排空。信号本身归 `ProcessPolicy`
 * （`src/server/process.ts`），本模块**零 `process.*`**、零信号处理。
 *
 * @module
 */

import type { Server } from "node:http";
import type { ConfigContext } from "@/config/index.js";
import { MAX_BODY_BYTES, createManagerServer } from "./http/index.js";
import { managerRoutes, type DataPlaneStatus, type ProcessFacts } from "./routes/index.js";
import { opsSourcesFromContext, type OpsSources } from "@/ops/index.js";
import type { LoggerImpl } from "@/utils/logger/index.js";

/** 装配所需的依赖（**全部注入**：本模块不读 `process.*`、不读配置） */
export interface StartControlPlaneOptions {
  /**
   * 本进程加载好的配置上下文
   * @description
   * 刻意**复用服务进程的那一份**而不是再 `loadConfig` 一次：同进程里存在两份配置快照时，
   * 「控制面看到的配置」与「代理跑着的配置」之间就有了漂移空间，而那正是本仓最贵的一种事故。
   */
  readonly context: ConfigContext;
  readonly logger: LoggerImpl;
  /** 本进程事实（pid / node / platform / cwd），由组合根从宿主取 */
  readonly processFacts: ProcessFacts;
  /** 数据面活状态的现读口（组合根持有 `ProxyCore` 并适配成本层的最小形状） */
  readonly dataPlane: () => DataPlaneStatus;
  /** 请求体上限（字节）；缺省 {@link MAX_BODY_BYTES} */
  readonly maxBodyBytes?: number;
}

/** 一个已经在监听的控制面 */
export interface ControlPlane {
  /** 真实监听的 HTTP server（组合根停机时经 `close()` 关它） */
  readonly server: Server;
  /** 数据面传来的地址（host:port），供日志与启动横幅使用 */
  readonly address: string;
  /** 已在监听的地址（`http://host:port`） */
  readonly url: string;
  /** 关掉这个面：先断已建立的连接再 `close()`（后者不主动断，会挂住） */
  close(): Promise<void>;
}

/**
 * 按配置起控制面
 * @description
 * `MANAGER_ENABLED=false`（缺省）⇒ 返回 `null` 且**零副作用**：不起 listener、不读数据源、
 * 不打任何日志。那就是「没有这个面」，不是一个「关着的面」。
 *
 * `MANAGER_ENABLED=true` ⇒ 起 listener；端口被占等启动失败**抛错**，由组合根映射成退出码。
 * 静默退出的形状（起了个面但日志说成功、端口实际没监听）比抛错坏得多。
 *
 * @param options - 见 {@link StartControlPlaneOptions}
 * @returns 已在监听的控制面；未启用时 `null`
 * @throws {Error} `listen` 失败（含 `EADDRINUSE`）
 */
export async function startControlPlane(
  options: StartControlPlaneOptions,
): Promise<ControlPlane | null> {
  const { context, logger, processFacts, dataPlane } = options;
  const config = context.accessor;

  if (!config.get("managerEnabled")) {
    return null;
  }
  // ⚠️ token 为空在这里**不可能**发生（`assertManagerConfig` 在 loadConfig 阶段就中止了）。
  // 那道判据属于启动期；这里再判一次是为了不让「日后有人删掉那道闸门」变成一个静默开着的
  // 万能管理员端口。`authorize` 对空 token 恒 401，故最坏结果是控制面完全不可用，而不是被攻破。
  const token = config.get("managerToken");
  if (token === "") {
    throw new Error(
      "控制面拒绝启动：MANAGER_ENABLED=true 而 MANAGER_TOKEN 为空（配置校验本该在启动期中止；" +
        "这条是兜底，说明那道闸门被移除了）",
    );
  }

  const host = config.get("managerHost");
  const port = config.get("managerPort");
  const sources: OpsSources = opsSourcesFromContext(context);

  const server = createManagerServer({
    token,
    routes: managerRoutes({ sources, processFacts, dataPlane }),
    logger: logger.child("manager"),
    maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
  });

  const bound = await listen(server, port, host);

  const address = `${bound.host}:${bound.port}`;
  logger.notice("info", `[manager] 控制面已监听 http://${address}`);
  return {
    server,
    address,
    url: `http://${address}`,
    close: () => closeServer(server),
  };
}

/**
 * `server.listen` 的 Promise 形态，**解析值是真正绑上的端口**
 * @description
 * 返回 `address()` 的结果而不是入参 `port`，是因为 `port: 0` 的语义是「由系统分配」
 * （`managerPort` 的字段契约里明确它是合法值）——报出 `0` 就是谎报，而「我监听在哪」必须
 * 如实。`error` 事件必须变成 rejection，否则它变成未处理 'error' 事件。
 */
function listen(
  server: Server,
  port: number,
  host: string,
): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(decorateListenError(err, port, host));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      const bound = server.address();
      resolve(
        bound === null || typeof bound === "string"
          ? { host, port }
          : { host: bound.address, port: bound.port },
      );
    });
  });
}

/**
 * 给 `listen` 失败换一条**含修法**的文案
 * @description
 * 端口被占是最常见的失败，而裸的 `EADDRINUSE` 不告诉操作者去查哪、怎么改。理由与
 * `src/cli.ts` 的数据面 EADDRINUSE 分支同源：给修法，而不是给一个错误码。
 */
function decorateListenError(err: Error, port: number, host: string): Error {
  if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
    return err;
  }
  return new Error(
    `控制面端口 ${port} 已被占用 (EADDRINUSE)` +
      `（监听地址 ${host}）；解决: netstat -ano | findstr :${port} -> taskkill //PID <pid> //F` +
      `；或换一个端口: MANAGER_PORT=${port + 1}`,
  );
}

/** 关掉控制面：`closeAllConnections()` 不可省，否则 keep-alive 连接会让 `close()` 挂住 */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}
