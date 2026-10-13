/**
 * @fileoverview stdio 那一档的 stderr 那一圈：抢着接住子进程说的话、留着，失败时缀到错上
 * @module agents/mcp/stderr
 * @description
 * ⚠️ `@ai-sdk/mcp` **没有把子进程的 stderr 交出来的口**（{@link childStderr} 够的是一个未公开的实现细节），
 *   所以这里一边抢着接、一边攒尾巴给失败消息用。
 * ⚠️ **接不上就如实说接不上**（`attached === false`），调用方据此把那一台关掉——留一条没人读的 `pipe` 比
 *   `inherit` 更糟（`npx` 的装包日志足以撑爆缓冲区，整台服务器就此僵住）。
 * ⚠️ **只读不关这条管道**：关它会让子进程下一次写 stderr 直接 EPIPE；它的去留由「关子进程」决定。
 */

import type { Context } from "cordis";

/** 失败那条 `warn` 里带回的 stderr 行数上限；再多就是噪声，不是线索 */
export const STDERR_TAIL_LINES = 20;

/** 单行 stderr 的保留上限：一个不换行的服务器不该把我们（和日志）的内存吃光 */
export const STDERR_MAX_LINE = 4096;

/** 探子进程有没有出来的间隔（毫秒）；够密，才能抢在「秒退」的前面（见 {@link watchForStderr}） */
export const STDERR_POLL_MS = 1;

/** 子进程的 stderr 收集口：接上一条流，之后随时能问「接上了没」「最后说了什么」 */
export interface StderrTail {
  /** 挂上读它的监听（读，不关——关会让子进程下一次写直接 EPIPE） */
  attach(stream: NodeJS.ReadableStream): void;
  /** 接上了没有；`false` 表示 {@link childStderr} 够不到，调用方据此把这台服务器关掉 */
  readonly attached: boolean;
  /** 攒下的尾巴（空串 = 它还没说过话） */
  tail(): string;
}

/** 子进程的 stderr：一边逐行记日志，一边留尾巴给失败时用 */
export function stderrTail(ctx: Context, server: string): StderrTail {
  const lines: string[] = [];
  let pending = "";
  const take = (line: string): void => {
    const text = line.trimEnd();
    if (text === "") return;
    lines.push(text);
    if (lines.length > STDERR_TAIL_LINES) lines.shift();
    // ⚠️ 记 `debug` 而不是 `warn`：这条通道上最常见的流量是 `npx` 的装包进度，按 warn 记会在启动时刷屏
    //   （而 `debug` 缺省不导出，平时一点不吵）。真要出事时看的是失败那条 `warn` 里带的尾巴。
    ctx.logger.debug("[mcp:%s] %s", server, text);
  };
  let attached = false;
  return {
    attach: (stream) => {
      attached = true;
      // ⚠️ 挂了 `data` 监听就等于**持续读这条管道**，这正是我们要的：管道必须有人读，否则写满之后子进程会
      //   卡死。想停只能靠 `close` 掐掉子进程。
      stream.on("data", (chunk: Buffer | string) => {
        pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        // ⚠️ 按行切后才谈得上「留最后 20 行」；半行拼不成一句能看的话。迟迟不换行也要收口，否则 pending 一路长。
        for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
          take(pending.slice(0, at));
          pending = pending.slice(at + 1);
        }
        if (pending.length > STDERR_MAX_LINE) {
          take(pending.slice(-STDERR_MAX_LINE));
          pending = "";
        }
      });
      stream.on("error", (error: Error) => ctx.logger.debug("[mcp:%s] stderr 流报错：%s", server, error.message));
    },
    get attached() {
      return attached;
    },
    tail: () => lines.join("\n"),
  };
}

/**
 * 子进程一被 spawn 出来就立刻把 stderr 接上；交回「停下来」。
 * @description ⚠️ 用 `setInterval` 探而不是等 `createMCPClient` 返回：没有「子进程 spawn 了」这个事件可以挂
 *   ——`StdioMCPTransport` 把它吞在自己的 `start()` 里了。探到就停，所以正常只跑一两个 tick；最坏探到时限
 *   为止，每个 tick 只是一次属性读。
 */
export function watchForStderr(transport: unknown, stderr: StderrTail): () => void {
  const timer = setInterval(() => {
    if (stderr.attached) {
      clearInterval(timer);
      return;
    }
    const stream = childStderr(transport);
    if (stream === undefined) return;
    stderr.attach(stream);
    clearInterval(timer);
  }, STDERR_POLL_MS);
  return () => clearInterval(timer);
}

/**
 * 从 transport 上够出子进程的 stderr 流；够不到给 `undefined`。
 * @description ⚠️ **这是一个未公开的实现细节**（`.d.ts` 里既没有 `process` 这个字段、也没有官方取法），所以：
 *   它**必须**在 `transport.start()` 之后才有东西可够 ⇒ 由 {@link watchForStderr} 反复探；它**够不到时不能装作
 *   没事**——调用方据此把这台关掉；`@ai-sdk/mcp` 一旦改名或挪走这个字段，表现是「少了那些 stderr 日志 +
 *   一台服务器被关掉并给出那句话」，**不是静默的坏行为**。升级依赖时要重跑探针。
 */
export function childStderr(transport: unknown): NodeJS.ReadableStream | undefined {
  const child = (transport as { process?: { stderr?: NodeJS.ReadableStream | null } } | undefined)?.process;
  return child?.stderr ?? undefined;
}

/** 「这台起不来」的错：统一形状，让 `manager.ts` 那边 `failed` 的每一条都读得懂 */
export function failStartup(server: string, reason: string, tail: string): Error {
  return withStderr(server, new Error(reason), tail);
}

/**
 * 把 stderr 尾巴缀到错上（远程那两档没有子进程 ⇒ 传空串，这时就是纯前缀）。
 * @description ⚠️ **只在尾巴非空时**才改 message：本来错就说得清（`ENOENT` 之类）时再缀一段子进程的啰嗦输出
 *   只会让人多读一遍。原来的 message 留在最前面，不丢。
 */
export function withStderr(server: string, error: unknown, tail: string): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  const message = base.message;
  if (tail === "") return new Error(`MCP 服务器「${server}」：${message}`, { cause: base });
  return new Error(`MCP 服务器「${server}」：${message}\n—— 它的 stderr（末 ${STDERR_TAIL_LINES} 行）：\n${tail}`, {
    cause: base,
  });
}