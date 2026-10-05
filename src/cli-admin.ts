/**
 * 管理 CLI 组合根 —— 唯一的宿主环境采集与进程退出边界。
 *
 * import 本模块不会加载配置、不读 argv、不写任何输出；仅 `require.main === module` 时快照一份
 * process 环境/argv/cwd，交给 `runAdminCli()`，再按它返回的退出码退出。与 `src/cli.ts` 逐字对称
 * ——**两个组合根，一个进程一个**，而不是让一个进程在「起服务」与「改数据」之间做运行时切换
 * （那样 `loadConfig` 的未知键闸门就得为子命令词开一个口子，见 `@/admin/args.ts`）。
 *
 * **本进程绝不启动代理**：`runAdminCli` 只解析配置与数据源，不装配任何 `ProxyServer` /
 * `ProxyRuntime`。故它不需要进程守卫、不需要信号处理。
 *
 * @module admin-cli
 */

import { runAdminCli, type AdminIo } from "@/admin/index.js";

/** 三个写入面：正文 / 诊断 / 「改完了」提示
 * @description
 * ⚠️ **`changed` 走 stderr 而非 stdout** 是刻意的：成功提示是给人看的，而人通常在管道或重定向里
 * 跑脚本，那行提示会污染下游。分开之后 `proxy-cli user list > list.txt` 得到的文件是干净的。
 */
function consoleIo(): AdminIo {
  return {
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    warn: (line) => {
      process.stderr.write(`${line}\n`);
    },
    changed: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

if (require.main === module) {
  // 第一次 await 之前快照所有宿主来源，避免异步加载期间被宿主代码改写（与 `src/cli.ts` 同纪律）
  const env = { ...process.env };
  const argv = process.argv.slice(2);
  const cwd = process.cwd();

  void runAdminCli({ argv, env, cwd, io: consoleIo() })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // `runAdminCli` 已经把命令层的错误映射成退出码了；能到这里的是它自己没兜住的东西
      // （例如某个数据源在构造期就炸了）。原样打出来，不套「失败: 」——那条文案已经自解释。
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
