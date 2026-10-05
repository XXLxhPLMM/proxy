/**
 * CLI 入口 - 唯一的宿主环境采集与进程启动边界。
 *
 * import 本模块不会加载配置；仅 `require.main === module` 时读取一份 process
 * 环境/argv 快照，显式交给异步 `loadConfig()`，再把返回的 ConfigContext 与
 * `cliPreset()`（库默认件 + CLI 进程策略）传给 `runServer()`。库调用方不会经过这里。
 *
 * **本文件只做五件事**：快照宿主来源 → 加载配置 → 建 logger 并转交加载告警 →
 * 按 `MANAGER_ENABLED` 起控制面 → 起数据面。
 * 「CLI 是什么」由 `cliPreset()` 回答（= 库默认件 + 拥有这个进程），进程级细节住在
 * `src/server/process.ts` 的 `ProcessPolicy` 实现里。
 *
 * ## 控制面与数据面**同进程**，且配置说开就一定开着
 *
 * `MANAGER_ENABLED=true` 时本进程额外监听 `MANAGER_HOST:MANAGER_PORT`，与数据面共享同一份
 * 配置上下文（**不**二次 `loadConfig`——两份快照之间的漂移正是「控制面看到的配置」与
 * 「代理跑着的配置」对不上的来源）。`MANAGER_ENABLED=false`（缺省）时本文件什么都不多做：
 * 不起 listener、不打日志、不改退出码。
 *
 * 次序是硬要求：**数据面先、控制面后**。反过来会在「数据面压根起不来」（端口被占 / 证书缺失 /
 * 账号表非法）时先占住排障要用的那个管理端口。代价是控制面起来的那一刻数据面还没开始监听，
 * 那一窗口内 `GET /api/status` 如实报 `running: false`。
 *
 * 停机次序相反：**控制面先关、数据面后排空**。反过来的话排空期间控制面还在接受写请求，
 * 而此刻数据面已经不再服务这些账号了。停机的**触发**归 `ProcessPolicy`，本文件只负责在它
 * 之前把控制面关掉（次序理由见 `main()` 里那段注释）。
 */

import { defaultEnvFileNames, loadConfig, type ConfigContext } from "@/config/index.js";
import { startControlPlane, type ControlPlane } from "@/manager/control-plane.js";
import type { DataPlaneStatus } from "@/manager/routes/index.js";
import { cliPreset, runServer, type DataPlaneOwner } from "@/server/index.js";
import {
  createConsoleLogger,
  createLogger,
  type Logger,
  type LoggerImpl,
} from "@/utils/logger/index.js";
import type { ProxyCore } from "@/core/types/proxy.js";

/**
 * 把 `DataPlaneOwner` 适配成控制面要的最小形状
 * @description
 * 端口与协议的判据来自 `ProxyCore.getStats()`，而它只在**真的监听了**之后才有意义：
 * `startedAt` 为 undefined 时 `running` 是 `false`、`port`/`host` 仍报配置里的值（那正是
 * 「打算监听在哪」）。`mode` 用生命周期态而非自造词汇：多写一份状态词汇表，就是多一份会与
 * `LifecycleState` 漂移的东西。
 */
function dataPlaneStatusOf(owner: DataPlaneOwner): DataPlaneStatus {
  const core: ProxyCore | null = owner.core;
  if (core === null) {
    return {
      mode: "inactive",
      protocol: null,
      host: null,
      port: null,
      running: false,
      startedAt: null,
      uptimeMs: null,
    };
  }
  const stats = core.getStats();
  const startedAt = stats.startedAt ?? null;
  return {
    mode: core.state,
    protocol: stats.protocol,
    host: stats.host,
    port: stats.port,
    running: stats.running,
    startedAt,
    uptimeMs: startedAt === null ? null : Date.now() - startedAt,
  };
}

async function main(onLoaded: (context: ConfigContext, logger: LoggerImpl) => void): Promise<void> {
  // 第一次 await 前快照所有宿主来源，避免异步加载期间被宿主代码改写。
  const env = { ...process.env };
  const argv = process.argv.slice(2);
  const cwd = process.cwd();

  const context = await loadConfig({
    env,
    envFiles: defaultEnvFileNames(env.NODE_ENV),
    argv,
    cwd,
  });
  const logger = createLogger({ config: context.accessor });
  for (const warning of context.warnings) {
    logger.warn(warning);
  }
  onLoaded(context, logger);

  // 判据对象在**起控制面之前**就造好：控制面一旦监听就可能立刻被访问，而它需要现读这份事实。
  const owner: DataPlaneOwner = { core: null };

  // ⚠️ **控制面先于数据面**：见文件头。起不来就抛（映射成退出码 + 一条含修法的消息），
  // 而不是留一个「日志说成功、端口实际没监听」的面。
  const control: ControlPlane | null = await startControlPlane({
    context,
    logger,
    processFacts: {
      pid: process.pid,
      startedAt: Date.now(),
      node: process.version,
      platform: process.platform,
      cwd,
    },
    dataPlane: () => dataPlaneStatusOf(owner),
  });

  try {
    // `assembly: cliPreset()` = 「CLI 就是库预设的一次组装」，预设里唯一的非空位是 `process`。
    await runServer(context, {
      logger,
      noColor: Boolean(env.NO_COLOR),
      assembly: cliPreset(),
      dataPlaneOwner: owner,
    });
  } catch (err) {
    // 数据面起不来时**必须**把控制面也关掉再抛：留一个还在监听、却已经没有数据面的控制面，
    // 就是本仓最恨的「命令成功、结果没变、零信号」——运维会以为服务活着。
    await closeControlPlane(control);
    throw err;
  }

  // ⚠️ **`runServer` 返回**在单进程档意味着「数据面已就绪」，**不是**「服务停了」——故停机
  // 绝不能挂在 await 之后（那会在服务刚起来时就把控制面关了）。
  //
  // 停机次序：控制面先关、数据面后排空。信号本身由 `ProcessPolicy` 装（位置在 `app.start()`
  // 之内，**晚于**这里），Node 按注册先后调用监听器，故本处理器一定先跑 —— 那正是要的次序。
  // 反过来的话排空期间控制面还在接受写请求，而此刻数据面已经不再服务那些账号了。
  if (control !== null) {
    const closeControlFaceFirst = (): void => {
      void closeControlPlane(control);
    };
    process.on("SIGINT", closeControlFaceFirst);
    process.on("SIGTERM", closeControlFaceFirst);
    if (process.platform === "win32") {
      process.on("SIGBREAK", closeControlFaceFirst);
    }
  }
}

/**
 * 关控制面
 * @description
 * 重复调用**安全**而不是靠某个「已关过」旗标：`server.closeAllConnections()` 对已关的 server
 * 是空操作，而 `server.close(cb)` 在 server 未开时会把错误交给回调而不是抛 —— 我们那个回调
 * 不看入参，故第二次调用照样 resolve。二次 Ctrl+C 因此不会变成一个未处理的 'error'。
 */
async function closeControlPlane(control: ControlPlane | null): Promise<void> {
  if (control === null) {
    return;
  }
  try {
    await control.close();
  } catch (err) {
    // 关不掉控制面不该盖掉真正的停机原因（数据面排空失败之类）
    process.stderr.write(
      `控制面关闭失败（不影响退出码）: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

if (require.main === module) {
  let context: ConfigContext | undefined;
  let activeLogger: Logger = createConsoleLogger({ level: "error" });

  void main((loadedContext, logger) => {
    context = loadedContext;
    activeLogger = logger;
  }).catch((err: unknown) => {
    const e = err as NodeJS.ErrnoException & { port?: number };
    if (e?.code === "EADDRINUSE") {
      const port = e.port ?? context?.store.get("port");
      activeLogger.error(`proxy 启动失败: 端口 ${port ?? "unknown"} 已被占用 (EADDRINUSE)`);
      activeLogger.error(
        `解决: netstat -ano | findstr :${port ?? "PORT"} -> taskkill //PID <pid> //F`,
      );
      if (port !== undefined) {
        activeLogger.error(`换端口: pnpm start -- --port ${port + 1}`);
      }
    } else {
      activeLogger.error("proxy 启动失败:", err);
    }
    void Promise.resolve(activeLogger.flush?.()).finally(() => process.exit(1));
  });
}
