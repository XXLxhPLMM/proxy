/**
 * manager CLI 组合根 —— 控制面进程的**唯一**宿主环境采集与退出边界。
 *
 * @description
 * 与 `src/cli.ts`（代理 CLI）**逐字对称**：快照宿主来源 → 加载配置 → 建 logger 并转交加载告警
 * → 起本进程要起的东西。两个组合根，**一个进程一个**——而不是让一个进程在「起服务」与
 * 「管服务」之间做运行时切换（那样 `loadConfig` 的未知键闸门就得为子命令词开一个口子）。
 *
 * **本进程绝不自己实现代理的启动/停止**：`createSupervisor` 才是那个持有
 * `child_process` 的模块（见 `@/manager/supervisor.js` 的文件头）。本文件只
 * `supervisor.start()` / `supervisor.stop()`，其余全部委托。
 *
 * ## 本组合根做的五件事
 * 1. **第一次 await 之前**快照 `env` / `argv` / `cwd`（与 `src/cli.ts` 同纪律：避免异步加载
 *    期间被宿主代码改写）。
 * 2. `loadConfig` 拿全量配置（**不** `skipFileValidation`）。⚠️ 与 `@/ops/sources.ts` 的
 *    `skipFileValidation: true` **不是同一件事**：那边跳过的是「操作三份数据」这一次
 *    `loadConfig`（管理工具必须能操作此刻是坏的数据）；本文件是**服务进程**，它的配置校验
 *    失败就意味着「这个进程不该起来」。两个决策各自的判据在各自的文件头里。
 * 3. `managerEnabled=false` ⇒ **明确打印「manager 未启用」并以非零码退出**。静默退出 0
 *    是本仓最恨的形状：操作者敲了 `proxy-manager`、看到光标回到 shell，而他以为有个
 *    控制面在跑。
 * 4. **先**拉子进程、**再**开控制面端口（反过来会在「子进程压根起不来」时先占住排障要用的
 *    那个端口）。
 * 5. **自己的**信号处理：Ctrl+C / SIGTERM ⇒ 停 HTTP（`closeAllConnections`，否则 keep-alive
 *    连接会让 `close()` 挂住）→ 停子进程（`supervisor.stop()` 走排空）→ 落盘 → 返回退出码。
 *
 * ## argv 只影响**本进程自己的监听面**，子进程看不到
 * @description
 * 子进程由 supervisor 以 `spawn(process.execPath, [appJsPath])` 拉起，`argv` **恒为空**；
 * 它读的是**宿主 env**（`supervisor.ts` 硬约束 ②：env 原样透传）。而
 * `@/ops/sources.ts:resolveOpsSources` 也刻意收 `argv: []`（那不是配置键通路）。
 * 于是 `proxy-manager --manager-port=4020` 只改**本进程监听哪个端口**；而
 * `--auth-users-file=…` 这类改**数据源**的 argv 会**只改到本进程的数据面**、子进程看不到，
 * 且两个配置层（组合根的 context 与 ops 的 context）会漂开。
 * 结论：**argv 只许用来调本进程自己的监听面**（`MANAGER_*` 四键）；要换数据源请改 env /
 * env 文件后重启 —— 那正是「manager 改的是 A、跑起来的是 B」这条事故的解药。
 *
 * @module manager-cli
 */

import { defaultEnvFileNames, loadConfig, type ConfigContext } from "@/config/index.js";
import { createManagerServer, MAX_BODY_BYTES } from "@/manager/http/index.js";
import { managerRoutes, type ManagerProcessFacts } from "@/manager/routes/index.js";
import { createSupervisor, resolveAppJsPath, type Supervisor } from "@/manager/supervisor.js";
import { resolveOpsSources, type OpsSources } from "@/ops/index.js";
import { createLogger, type LoggerImpl } from "@/utils/logger/index.js";
import type { Server } from "node:http";

/** 退出码：`0` 正常退出 / `1` 起不来（含「未启用」）。与 `proxy-cli` 的 0/1/2 同档的第一档。 */
const EXIT_OK = 0;
const EXIT_FAILED = 1;

/** 「manager 未启用」的固定文案 —— 逐字含**修法**，否则操作者得自己猜该设哪个键 */
const DISABLED_MESSAGE =
  "manager 未启用：MANAGER_ENABLED=false（缺省即「没有这个面」，不是「有个关着的面」）。" +
  "要开这个控制面请设 MANAGER_ENABLED=true 且 MANAGER_TOKEN=<随机串>（例：openssl rand -hex 32）。";

/** 两条写入面（**由组合根注入**，本文件之外没有 `process.stdout`） */
export interface ManagerIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** `runManager` 的全部显式入参（**不读 `process.*`** —— 那是本文件 `require.main` 那一段的活） */
export interface RunManagerOptions {
  /** 宿主环境**快照**（第一次 await 之前取） */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `process.argv.slice(2)`。这些参数**是配置键**（`--manager-port=…`），与 `proxy-cli` 的子命令不同。 */
  readonly argv: readonly string[];
  /** 配置目录锚点（进程 cwd） */
  readonly cwd: string;
  /** 被监管的入口（`dist/app.js`）；组合根解析，测试可显式给 */
  readonly appJsPath: string;
  readonly io: ManagerIo;
  /** 请求体上限（字节）；缺省 {@link MAX_BODY_BYTES} */
  readonly maxBodyBytes: number;
  /** 本进程事实的来源（**注入**而不是读 `process.pid` 等：组合根是宿主采集的唯一边界，
   *  但「组合根内部」也应当能被单测替换掉进程身份） */
  readonly facts: ManagerProcessFacts;
}

/**
 * 跑完整个控制面（起 supervisor + HTTP，停机后返回）
 * @description
 * **不 `process.exit`**：返回退出码，由组合根决定怎么退出（与 `runAdminCli` 同纪律）。
 * 它会**一直挂着**直到收到信号 —— 这是一个常驻服务，不是跑完就退的工具。
 *
 * @param options - 见 {@link RunManagerOptions}
 * @returns 进程退出码
 * @example await runManager({ env, argv: [], cwd: "/srv", appJsPath: "/srv/dist/app.js", io,
 *   maxBodyBytes: MAX_BODY_BYTES, facts })   // 挂到收到 SIGINT
 */
export async function runManager(options: RunManagerOptions): Promise<number> {
  const { env, argv, cwd, appJsPath, io } = options;

  const context: ConfigContext = await loadConfig({
    env,
    envFiles: defaultEnvFileNames(env.NODE_ENV),
    argv,
    cwd,
  });
  const logger: LoggerImpl = createLogger({ config: context.accessor });
  for (const warning of context.warnings) {
    logger.warn(warning);
  }

  if (!context.accessor.get("managerEnabled")) {
    // 非零码：这不是「成功地什么也没做」，这是「你要的东西没开」——见文件头第 ③ 条
    io.err(DISABLED_MESSAGE);
    return EXIT_FAILED;
  }
  const token = context.accessor.get("managerToken");
  const host = context.accessor.get("managerHost");
  const port = context.accessor.get("managerPort");

  const sources: OpsSources = await resolveOpsSources(env, cwd);
  const supervisor: Supervisor = createSupervisor({
    appJsPath,
    cwd,
    // ⚠️ **原样透传**（`supervisor.ts` 的硬约束 ②）：子进程走 `loadConfig` 读的就是这份
    // 宿主 env；过滤或增删任何一个键都会让「manager 看到的配置」与「proxy 看到的配置」漂移。
    env,
    logger: logger.child("supervisor"),
  });

  const server = createManagerServer({
    token,
    routes: managerRoutes({ sources, supervisor, managerFacts: options.facts }),
    logger: logger.child("http"),
    maxBodyBytes: options.maxBodyBytes,
  });

  // ① 先拉子进程，再开控制面端口：反过来会在「子进程压根起不来」时先占住排障要用的那个端口
  try {
    await supervisor.start();
  } catch (err) {
    io.err(`manager 启动失败：子进程拉不起来：${message(err)}`);
    return EXIT_FAILED;
  }

  // ② 监听。EADDRINUSE 要像 `src/cli.ts` 那样给出**可执行的**修法，而不是一个错误码
  try {
    await listen(server, port, host);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
      io.err(`manager 启动失败：控制面端口 ${port} 已被占用 (EADDRINUSE)`);
      io.err(`解决: netstat -ano | findstr :${port} -> taskkill //PID <pid> //F`);
      io.err(`换端口: proxy-manager --manager-port=${port + 1}`);
    } else {
      io.err(`manager 启动失败: ${message(err)}`);
    }
    await supervisor.stop();
    return EXIT_FAILED;
  }

  logger.notice(
    "info",
    `[manager] 控制面已监听 http://${host}:${port}（代理子进程 pid=${supervisor.status().pid ?? "null"}；` +
      "子进程还活着不等于服务已就绪，本面没有任何健康检查信号）",
  );
  io.out(
    `manager listening on http://${host}:${port}  (proxy child pid=${supervisor.status().pid ?? "null"})`,
  );

  // ③ 自己的信号处理。`process.once` 而非 `process.on`：**第二次同信号不会重复触发**，
  //    而停机期间人往往会因为「怎么还没退」再按一次 Ctrl+C。停机本身是幂等的
  //    （`supervisor.stop()` 复用同一个在飞 Promise），但重复触发会让两个停机流程
  //    争抢 `server.close` —— 那里的重复调用不是幂等的。
  const stopped = new Promise<void>((resolve) => {
    const shutdown = (signal: NodeJS.Signals): void => {
      logger.notice("info", `[manager] 收到 ${signal}，开始停机`);
      void stopEverything(server, supervisor, logger, signal, io).then(resolve);
    };
    process.once("SIGINT", () => {
      shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      shutdown("SIGTERM");
    });
  });
  await stopped;
  return EXIT_OK;
}

/** `server.listen` 的 Promise 形态（`error` 事件要变成 rejection，否则它变成未处理 'error'） */
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

/** 停 HTTP（先）+ 停子进程（后）+ flush 落盘 */
async function stopEverything(
  server: Server,
  supervisor: Supervisor,
  logger: LoggerImpl,
  signal: NodeJS.Signals,
  io: ManagerIo,
): Promise<void> {
  // ① HTTP：`closeAllConnections()` 不可省 —— Node 的 `close()` 只停止接受新连接，
  //    已建立的 keep-alive 连接要自己断，否则这里会一直挂着（人看到的现象是「Ctrl+C 之后
  //    进程还在」）。
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
  logger.notice("info", "[manager] 控制面已停止接受请求");

  // ② 子进程：`stop()` 走排空（win32 上共享控制台，Ctrl+C 已经广播过去了，
  //    这里等的是**人刚启动的排空**跑完，见 supervisor.ts 文件头）
  try {
    await supervisor.stop();
    logger.notice("info", "[manager] 子进程已停");
  } catch (err) {
    // ⚠️ **停机失败不吞**：静默退出 0 = 「命令成功、结果没变、零信号」
    logger.error(`[manager] 子进程停机失败: ${message(err)}`);
    io.err(`子进程停机失败: ${message(err)}`);
  }
  logger.notice("info", `[manager] 停机完成（${signal}）`);
  await logger.flush?.();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (require.main === module) {
  // 第一次 await 之前快照所有宿主来源（与 `src/cli.ts` 同纪律）
  const env = { ...process.env };
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  // 组合根**先**解析被监管的入口：`resolveAppJsPath` 试不到就抛错并列出试过的路径。
  // 放在 loadConfig 之前，是为了让「没构建」这条最常见的错**先**于任何配置问题报出来。
  const appJsPath = resolveAppJsPath();
  const startedAt = Date.now();

  void runManager({
    env,
    argv,
    cwd,
    appJsPath,
    maxBodyBytes: MAX_BODY_BYTES,
    facts: {
      pid: process.pid,
      startedAt,
      uptimeMs: 0,
      node: process.version,
      platform: process.platform,
      appJsPath,
      cwd,
    },
    io: {
      out: (line) => {
        process.stdout.write(`${line}\n`);
      },
      err: (line) => {
        process.stderr.write(`${line}\n`);
      },
    },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // `runManager` 自己已把可归因的失败映射成退出码；能到这里的是它没兜住的东西
      // （配置校验失败 / resolveAppJsPath 抛错 / 监听失败）。原样写 stderr，不套前缀。
      process.stderr.write(`${message(err)}\n`);
      process.exitCode = EXIT_FAILED;
    });
}
