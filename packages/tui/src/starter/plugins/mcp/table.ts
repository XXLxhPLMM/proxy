/**
 * @fileoverview MCP 服务器表：那张表、围着它的五个动作、以及**串行化**它们的那条队列
 * @module starter/plugins/mcp/table
 * @description
 * 本目录**唯一持有 MCP 状态**的地方。`@/agents/mcp/` 只管「一台」的机制（连上 + 登记 + 收），
 * 不认得自己属于谁；两边共享状态就会出两份真值。
 *
 * ⚠️ **这里的一切都在一条 promise 队列上串行跑**（见 {@link McpTable.serial}）。
 *   每个动作都要 `await` 一台服务器的起落——子进程启动 + `initialize` 往返，可能几十秒。
 *   不串行的话，两个并发 `restart` 会各开一个会话，后写的 session 覆盖前一个
 *   ⇒ **前一个的连接与它登记的工具全都泄漏**，而泄漏的形状是「工具还在但调不通」。
 *
 * ⚠️ **「起」不抛，「关」也不抛**：外部服务器没接上是**降级**（记 `warn` + 落进 `failed`），
 *   与 `dbPlugin` 那道闸门不同类——闸门挡的是「状态坏了」，这里坏掉的只是一份外部能力。
 *   会让**启动**失败的只有「配置本身坏了」，而那在 `config/agents/parse.ts` 就抛了，压根到不了这里。
 *
 * ⚠️ **关掉与移除是两件事**：`stop()` 只收会话、留下那一行（`restart` 要的就是这个）；
 *   移除要另外 `unregister` / `reload`。混在一起就分不清「暂时断了」和「不要了」。
 */

import type { Context } from "cordis";
import { isValidServerName, openMcpSession, type McpSession } from "@/agents/mcp/index.js";
import type { McpServerConfig } from "@/config/agents/defaults.js";
import { planReload } from "./reload.js";
import type { McpServerState, McpServerStatus, McpService } from "./index.js";

/** 表里一行。⚠️ `config` **可写**：`reload()` 换配置时是就地改它，不换对象（理由见 `reload.ts`） */
export interface McpTableEntry {
  /** 怎么起它 */
  config: McpServerConfig;
  /** 这台的配置是哪来的（运行期那台由 `register` 塞进来，配置表里没有它） */
  readonly source: "config" | "runtime";
  /** 现在什么状态 */
  state: McpServerState;
  /** 活着的会话；`starting` / `failed` 时为 `undefined` */
  session?: McpSession;
  /** 为什么没接上（`failed` 才有，消息里带子进程 stderr 尾巴） */
  error?: Error;
}

/** 那张表，以及围绕它的五个动作。本身即服务面 `McpService` */
export class McpTable implements McpService {
  private readonly entries = new Map<string, McpTableEntry>();
  /** 串行队列的队尾，见 {@link serial} */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: Context) {}

  // ---------------------------------------------------------------- 查

  list(): readonly McpServerStatus[] {
    // ⚠️ 按名字排而不是按插入序：配置顺序本来就没承诺过（`JSON.parse` 给的键序、运行期注册的
    //   先后都不可靠），给一个**每次都一样的**顺序比给一个看似有意图的顺序诚实。
    return [...this.entries]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => this.toStatus(name, entry));
  }

  get(name: string): McpServerStatus | undefined {
    const entry = this.entries.get(name);
    return entry === undefined ? undefined : this.toStatus(name, entry);
  }

  // ---------------------------------------------------------------- 增删改

  async register(name: string, config: McpServerConfig): Promise<() => void> {
    // ⚠️ 名字的尺子与配置**同一把**（`agents/mcp/naming.ts`）：两者最后都变成同一批工具键。
    //   判在排队**之前**，有两个理由：名字不合法是调用方的错，不该占住整条队列等它；
    //   且**方法声明返回 `Promise` 就得拒绝而不是同步抛**——同步抛会被只写 `.catch()` 的调用方漏掉。
    if (!isValidServerName(name)) {
      throw new Error(
        `MCP 服务器名 ${JSON.stringify(name)} 不合法` +
          "（须字母或数字开头，其余为字母数字 / _ / . / -，且不许含 __ —— 它是工具名 mcp__<服务器名>__<工具> 的分界）",
      );
    }
    return this.serial(async () => {
      const existing = this.entries.get(name);
      if (existing !== undefined) {
        // ⚠️ **当场抛，不覆盖**：配置里那台是用户写的，默默被顶掉比报个错难查得多。要顶就先 `unregister`。
        throw new Error(
          `MCP 服务器「${name}」已经在了（来源：${existing.source === "config" ? "配置文件" : "运行期注册"}）` +
            "；要顶掉它就先 unregister —— 默默覆盖配置里那台比报个错难查得多",
        );
      }
      const entry: McpTableEntry = { config, source: "runtime", state: "starting" };
      this.entries.set(name, entry);
      await this.start(name, entry);
      // ⚠️ 认名字不认人（照 `ctx.tools` 的先例）：同名已被别人重新注册过时，这把退订函数什么也不做。
      return () => {
        if (this.entries.get(name) === entry) void this.serial(() => this.remove(name));
      };
    });
  }

  unregister(name: string): Promise<void> {
    return this.serial(() => this.remove(name));
  }

  restart(name: string): Promise<boolean> {
    return this.serial(async () => {
      const entry = this.entries.get(name);
      if (entry === undefined) return false;
      await this.reopen(name, entry);
      return true;
    });
  }

  reload(): Promise<void> {
    return this.serial(async () => {
      this.ctx.emit("mcp.reload.start");
      const plan = planReload([...this.entries], this.ctx.cfg.get("agents").mcpServers);
      for (const name of plan.shadowed) {
        this.ctx.logger.warn(
          "MCP 服务器「%s」既在配置里、又被运行期注册占了名，重载保留了运行期那份（配置里那份没生效）",
          name,
        );
      }
      for (const name of plan.drop) {
        await this.remove(name);
        this.ctx.logger.info("MCP 服务器「%s」已不在配置里，重载时关掉了", name);
      }
      for (const target of plan.reopen) {
        const entry = target.existing ?? { config: target.config, source: "config" as const, state: "starting" as const };
        this.entries.set(target.name, entry);
        // ⚠️ `reopen` 先关后起：对 `existing` 是换配置再重启，对新行是刚建好就起。
        await this.reopen(target.name, entry);
      }
      this.ctx.emit("mcp.reload.finish");
      this.report();
    });
  }

  // ---------------------------------------------------------------- 装载期 / 卸载期

  /** 装载期：把配置表整批起一遍。⚠️ 也走队列——别的插件完全可能在启动期间 `register` 一台 */
  loadConfigured(): Promise<void> {
    return this.serial(async () => {
      for (const [name, config] of Object.entries(this.ctx.cfg.get("agents").mcpServers)) {
        const entry: McpTableEntry = { config, source: "config", state: "starting" };
        this.entries.set(name, entry);
        await this.start(name, entry);
      }
      this.report();
    });
  }

  /**
   * 卸载期：全部收掉。
   * ⚠️ **刻意不排队、不 await**：已经没有下一次操作了，排队只会拖住退出。每台的
   *   「退订工具 → 关连接」由 `McpSession.close()` 自己按顺序做；关不掉的不抛——
   *   退出路径上再叠一个错只会盖掉真正的错。
   */
  dispose(): void {
    for (const entry of this.entries.values()) {
      const session = entry.session;
      entry.session = undefined;
      void session?.close().catch(() => undefined);
    }
    this.entries.clear();
  }

  /** 一条汇总（⚠️ 逐台记日志等于启动刷屏：起没起是常态信息） */
  report(): void {
    const rows = this.list();
    if (rows.length === 0) {
      this.ctx.logger.info("MCP：没配任何服务器（agents.mcpServers 是空的）");
      return;
    }
    const connected = rows.filter((row) => row.state === "connected");
    this.ctx.logger.info(
      "MCP：%d 台里接上 %d 台，给出 %d 条工具（%s）；%d 台没接上",
      rows.length,
      connected.length,
      connected.reduce((sum, row) => sum + row.tools.length, 0),
      connected.map((row) => `${row.name} → ${row.serverInfo}`).join("，"),
      rows.filter((row) => row.state === "failed").length,
    );
  }

  // ---------------------------------------------------------------- 内部

  /** 起一台（不抛：起不来就记 `failed` + 一条 `warn`，见文件头） */
  private async start(name: string, entry: McpTableEntry): Promise<void> {
    entry.state = "starting";
    entry.error = undefined;
    try {
      entry.session = await openMcpSession(this.ctx, name, entry.config);
      entry.state = "connected";
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      entry.session = undefined;
      entry.state = "failed";
      entry.error = failure;
      // ⚠️ 记 `warn` 而不是 `error`：一台外部服务器没接上是**降级**，不是本应用出错。
      this.ctx.logger.warn("MCP 服务器「%s」没接上，其余照常：%s", name, failure.message);
    }
  }

  /**
   * 关掉再起一台——「重启」的最小单位，`restart` 与 `reload` 共用它。
   * ⚠️ **关完必须起新的，不能在旧会话上增量改**：服务器宣告多少条工具**随时间变**，
   *   而会话登记的那些工具是一次性挂上去的 ⇒ 「重启」必然是**全量换一批**。
   */
  private async reopen(name: string, entry: McpTableEntry): Promise<void> {
    const session = entry.session;
    entry.session = undefined;
    entry.error = undefined;
    entry.state = "starting";
    if (session !== undefined) await session.close();
    await this.start(name, entry);
  }

  /** 移除一行（先关会话，再从表里删）；没有这一行就什么也不做（幂等） */
  private async remove(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined) return;
    const session = entry.session;
    entry.session = undefined;
    this.entries.delete(name);
    if (session !== undefined) await session.close();
  }

  /** 表里的一行 → 对外的状态。⚠️ 走 `session` 取，断了的那半边自然退回空串 / 空数组 */
  private toStatus(name: string, entry: McpTableEntry): McpServerStatus {
    const session = entry.session;
    return {
      name,
      source: entry.source,
      state: entry.state,
      serverInfo: session?.serverInfo ?? "",
      tools: session?.toolNames ?? [],
      skipped: session?.skipped ?? [],
      ...(entry.error === undefined ? {} : { error: entry.error.message }),
    };
  }

  /**
   * 排队跑一件事。⚠️ **队尾吞掉成败**：前一个动作失败不该堵死后面（否则一次 `register` 撞名
   *   就把整个 MCP 圈子死锁在那儿），但**它自己的成败照原样交回调用方**。
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}