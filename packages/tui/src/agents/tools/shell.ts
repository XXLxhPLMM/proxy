/**
 * @fileoverview shell 工具：在 shell 里跑一条命令，把 stdout / stderr / 退出码交回给模型
 * @module agents/tools/shell
 * @description ⚠️ **这条工具会执行任意命令**，没有开关、没有白名单、没有确认——模型说要跑就跑。
 *   这就是它存在的意义（模型自己动手看世界），但它意味着**注册它就等于把 shell 交出去**，
 *   谁调 {@link registerShellTool} 谁负责这个决定。
 */

import { exec } from "node:child_process";
import { defineTool, registerTool } from "./index.js";

/** 单条输出（stdout / stderr 各自）的字符上限：超了截断并标注，省得一条 `cat 大文件` 把整轮的 payload 撑爆 */
const MAX_OUTPUT = 32_000;

/** 单条命令的默认时长（毫秒）；注册时没另给 `timeoutMs` 的话就是它 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 登记这条工具时的选择 */
export interface ShellOptions {
  /**
   * 单次命令跑多久（毫秒）：模型没给 `timeoutMs` 时用它，**模型要更长没有**（会被夹到这个数）。
   * 省略 = 120s。
   * @description 为什么默认与上限是同一个数：注册的人（不是模型）决定这条工具最多能占多久，
   *   而「更短」是模型每次调用都能要的。两个旋钮要等真有第二个使用场景再拆。
   */
  readonly timeoutMs?: number;
}

/** 超了就砍尾巴并说清楚砍了多少——静默截断会被模型当成「这就是全部」 */
function clip(text: string): string {
  return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n…（已截断，原共 ${text.length} 字符）`;
}

/** 模型看到的一条命令跑了什么 */
export interface ShellResult {
  /** 退出码；被信号打死没有退出码（那时是 reject，不是这里） */
  readonly exitCode: number;
  /** 标准输出（截断过） */
  readonly stdout: string;
  /** 标准错误（截断过） */
  readonly stderr: string;
}

/**
 * 把 shell 工具登记进注册表。
 * @param settings 登记时的选择（见 {@link ShellOptions}）
 * @returns 退订函数（`registerTool` 原样交回）。
 * @description ⚠️ **退出码非 0 不算失败**：`ls /nope` 报「没有那个目录」是模型要拿的信息，
 *   照常 resolve 让它自己判断。真正 reject 的只有三种：命令是空串、超时、被中断。
 */
export function registerShellTool(settings: ShellOptions = {}): () => void {
  const cap = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`shell 工具的 timeoutMs 必须是 ≥1 的整数，收到 ${cap}`);
  return registerTool(
    "shell",
    defineTool((tool, z) =>
      tool({
        description: "在 shell 里跑一条命令，拿回 stdout、stderr 与退出码",
        inputSchema: z.object({
          command: z.string().min(1).describe("要跑的命令（整串，交给 shell 解释，管道与通配都认）"),
          cwd: z.string().optional().describe("工作目录，省略就是进程当前目录"),
          timeoutMs: z.number().int().positive().optional().describe(`超时上限（毫秒），最大 ${cap}`),
        }),
        execute: ({ command, cwd, timeoutMs }, options) => {
          const timeout = Math.min(timeoutMs ?? cap, cap);
          return new Promise<ShellResult>((resolve, reject) => {
            exec(
              command,
              // ⚠️ `signal` 是循环的 `cancel` 传到工具里的那条路；`maxBuffer` 要留够 8 倍于
              //   `MAX_OUTPUT`，否则输出大一点就把进程打死，而不是走到 `clip` 被截断。
              //   `options?.` 是容错：SDK 一定会传，直接调 `execute` 的未必，传不来就当没有信号。
              { cwd, timeout, maxBuffer: MAX_OUTPUT * 8, encoding: "utf8", signal: options?.abortSignal },
              (error, stdout, stderr) => {
                // 中断**原样抛**：包装成普通 Error 会让循环那边认不出「这是取消」，当成失败记状态
                if (error?.name === "AbortError") {
                  reject(error);
                  return;
                }
                if (error?.killed === true) {
                  reject(new Error(`命令超时（${timeout}ms）：${command}`));
                  return;
                }
                // 跑起来了、只是退出码非 0 ⇒ 是结果不是故障
                if (error === null || typeof error.code === "number") {
                  resolve({ exitCode: error?.code ?? 0, stdout: clip(stdout), stderr: clip(stderr) });
                  return;
                }
                // 连 shell 都没起来（cwd 不存在、没有可执行文件……）
                reject(error);
              },
            );
          });
        },
      }),
    ),
  );
}