/**
 * @fileoverview 管理命令层出口（barrel）与 `runAdminCli` 编排
 * @module admin/index
 * @description
 * `proxy-cli` 的**唯一**执行面：解析 argv → 解析配置 → 折出三份数据源 → 派发 → 映射退出码。
 * 进程那一侧的全部事（快照宿主来源、`process.exit`、shebang）在 `src/cli-admin.ts`，与 `src/cli.ts`
 * 逐字对称——**两个组合根，一个进程一个**。
 *
 * ## 为什么不复用 `src/cli.ts` 的 argv 通路
 *
 * 服务的 argv 是配置键（`--port 8080`），本工具的 argv 是子命令（`user add alice`）。把它们塞进
 * 同一条通路要么得在未知键闸门之前剥掉子命令（于是本工具自己的参数拼错零信号），要么得把子命令词
 * 塞进 `NON_CONFIG_ENV_KEYS`（那是**配置键**的容忍名单）。理由的完整论证见 `./args.ts` 文件头。
 *
 * ## 依赖方向
 *
 * 本层是**装配层**：向下只用 `@/config`（折接线）、`@/datasource`（解析驱动）与 `@/utils`。
 * 它**不认识** `@/core` / `@/runtime` / `@/server` —— 那条禁令对它的判据与对 `src/datasource` 的
 * 判据不同但结论相同：管理工具**不启动代理**，所以它没有理由持有任何代理侧的东西。
 *
 * @module
 */

import { runAclCommand } from "./acl.js";
import { AdminUsageError, parseAdminArgs } from "./args.js";
import { runConfigCommand } from "./config.js";
import { resolveAdminSources } from "./context.js";
import { printHelp } from "./help.js";
import { runUsageCommand } from "./usage.js";
import { runUserCommand, inertNoticeFor } from "./users.js";
import { AdminError, EXIT_FAILED, EXIT_OK, EXIT_USAGE, type AdminIo } from "./out.js";

/** `runAdminCli` 的全部显式入参（**不读 `process.*`**——那是组合根的活） */
export interface RunAdminCliOptions {
  /** `process.argv.slice(2)` */
  readonly argv: readonly string[];
  /** 宿主环境**快照** */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 配置目录锚点（进程 cwd） */
  readonly cwd: string;
  /** 写入面 */
  readonly io: AdminIo;
}

/**
 * 跑完一条管理命令，返回**进程退出码**
 * @description
 * **不抛错、不退出进程**：错误一律映射成退出码 + 一行 `warn`。理由是它要能在单测里被直接调用
 * 并断言退出码与输出；进程退出留给组合根（`src/cli-admin.ts`）。
 *
 * @param options - 见 `RunAdminCliOptions`
 * @returns 0 / 1 / 2
 * @example await runAdminCli({ argv: ["user", "list"], env: {}, cwd: "/srv", io });
 */
export async function runAdminCli(options: RunAdminCliOptions): Promise<number> {
  const { io } = options;
  try {
    const command = parseAdminArgs(options.argv);
    if (command.kind === "help") {
      printHelp(io, command.topic);
      return EXIT_OK;
    }

    // 快照已在第一次 await 之前由组合根取好（与 `src/cli.ts` 同纪律）
    const sources = await resolveAdminSources(options.env, options.cwd);

    switch (command.kind) {
      case "user":
        runUserCommand(io, sources, command);
        // 改完当场提醒「你刚写的字段在这个模式下不生效」——CLI 改完就退出，那条启动期告警要等
        // 下次重启，而运维很可能不重启。
        {
          const notice = inertNoticeFor(sources);
          if (notice !== undefined && command.op !== "list" && command.op !== "show") {
            io.warn(notice);
          }
        }
        return EXIT_OK;
      case "acl":
        runAclCommand(io, sources, command);
        return EXIT_OK;
      case "usage":
        await runUsageCommand(io, sources, command);
        return EXIT_OK;
      case "config":
        runConfigCommand(io, sources, command);
        return EXIT_OK;
    }
  } catch (error) {
    if (error instanceof AdminUsageError) {
      io.warn(`用法错: ${error.message}`);
      io.warn("跑 proxy-cli --help 看用法");
      return EXIT_USAGE;
    }
    if (error instanceof AdminError) {
      io.warn(`失败: ${error.message}`);
      return EXIT_FAILED;
    }
    // 其余（配置校验失败、驱动未注册、IO 异常）**原样打出来**：那些文案里点名了键名与已注册项，
    // 套一层「失败: 」只会让人再往下找一遍。文案本身已经足够自解释。
    io.warn(error instanceof Error ? error.message : String(error));
    return EXIT_FAILED;
  }
}

export { AdminError, EXIT_FAILED, EXIT_OK, EXIT_USAGE, type AdminIo } from "./out.js";
export { AdminUsageError, parseAdminArgs, type AdminCommand } from "./args.js";
