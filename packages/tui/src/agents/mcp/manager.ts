/**
 * @fileoverview MCP 那一圈的管理者：把「`mcps` 表里那些行」变成「跑着的那些会话」，并把对表串行化
 * @module agents/mcp/manager
 * @description
 * 这个类就是 `ctx.mcp` 的实现（插件在 `starter/plugins/mcp/` 只负责把它装上树），它管的是**一批**：库里那些行
 * ↔ 跑着的这些会话，中间夹着起、关、重开、对表，以及把它们**排队**的那条 promise 队列。「一台」的机制在同目录
 * 的 `connection.ts` / `session.ts`，两边不共享状态。
 *
 * ⚠️ **本类不写库**：`mcps` 表只有 `ctx.services.mcps` 写（`service/` 只管搬数据 + 喊事件，MCP 的规矩一条都
 *   不在那儿），本类只**读**它并据此起停。
 * ⚠️ **本类判断「这一行能不能起」**：服务器名的尺子在 `naming.ts`，形状闸在 `db/read.js` 的
 *   `mcpConfigFromRow` —— **写前过一道**（`create` / `update`，跑不过就不写）、**读时逐台过一道**
 *   （{@link McpManager.desiredOf}，一台坏行只让**那一台**落 `failed`）。⚠️ **不缓存配置**：真值是表里
 *   那一行，运行期只记一个 `rowStamp`（它的 `updatedAt`）用来判「改过没有」——存一份配置对象就是第二份真值。
 * ⚠️ **一切动手的动作都在一条 promise 队列上串行跑**：每个动作都要 `await` 一台服务器的起落，可达几十秒。
 *   不串行的话两个并发 `restart` 会各开一个会话，后写的覆盖前一个 ⇒ **前一个的连接与它登记的工具全都泄漏**，
 *   而泄漏的形状是「工具还在但调不通」。⚠️ 读（`list` / `get`）不排队：它们只拼两样已经在那儿的东西。
 * ⚠️ **「起」不抛，「关」也不抛**：外部服务器没接上是**降级**（记 `warn` + 落 `failed`）。会让启动失败的只有
 *   「本地库本身坏了」，而那在结构同步时就抛了，压根到不了这里。
 * ⚠️ **写完自己也对一次表，不等那条 `mcp.data.changed` 事件**：事件是给别人的通知，而 `ctx.emit` 不隔离
 *   监听器的错；自己这一次才是调用方能 `await` 的那次。监听器随后会再对一次，发现戳已经对上而什么也不做
 *   （幂等）——那一次是为了**绕过 `ctx.mcp` 直接写库**的那条路（UI 表单、日后的导入）。
 * ⚠️ **时间戳由本类填**（`Date.now()`）：`dao/` 与 `service/` 都不读时钟，所以最靠近写入的这一层负责。
 */

import type { Context } from "cordis";
import type { Mcp, McpDraft, McpPatch } from "@/db/dto/index.js";
import { mcpConfigFromRow, mcpDefinedPatch, mcpNewRowFromDraft } from "@/db/read.js";
import { assertValidServerName } from "./naming.js";
import { planMcp, type McpDesired } from "./plan.js";
import { openMcpSession } from "./session.js";
import { toStatus, type McpEntry, type McpServerState, type McpServerStatus } from "./status.js";

/** 改一台的入参：`updatedAt` 由本类填，其余都可缺省（不动那一格） */
export type McpChanges = Omit<McpPatch, "updatedAt">;

/** 插件抛出来的东西未必是 `Error`（`throw "boom"` 合法），统一成 `Error` 再用 */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** MCP 那一圈的管理者；本身即服务面 `ctx.mcp`（契约在 `starter/plugins/mcp/index.ts`） */
export class McpManager {
  private readonly entries = new Map<string, McpEntry>();
  /** 串行队列的队尾，见 {@link McpManager.serial} */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: Context) {}

  // ---------------------------------------------------------------- 查（不排队）

  /**
   * MCP 服务器清单；按 `id` 定序。⚠️ **集合来自 `mcps` 表**（那才是真值），运行期只补状态：被标了
   * `disabled` 的那些**也在清单里**（用户要看得见它们才可能重新启用），只是没有会话。
   */
  list(): readonly McpServerStatus[] {
    return this.ctx.services.mcps
      .list()
      .map((row) => toStatus(row.id, this.entries.get(row.id), row.disabled));
  }

  /** 取一台的近况；库里没这一行给 `undefined` */
  get(name: string): McpServerStatus | undefined {
    const row = this.ctx.services.mcps.get(name);
    return row === undefined ? undefined : toStatus(name, this.entries.get(name), row.disabled);
  }

  // ---------------------------------------------------------------- 写（数据 + 运行期一次做完）

  /**
   * 建一台：写进 `mcps` 表并（没被 `disabled` 的话）起它。
   * @returns 它此刻的近况；⚠️ **返回成功不代表起来了**——起不来是降级，那一行会是 `failed` 并带 `error`。
   * @throws 名字不合法 / **已经有这一台**（当场拒，不覆盖：默默顶掉用户写的那一行最难查）
   * @description ⚠️ 名字在**排队之前**判：它是调用方的错，不该占住整条队列等它；且声明返回 `Promise` 就得
   *   **拒绝**而不是同步抛——同步抛会被只写 `.catch()` 的调用方漏掉。
   */
  create(draft: McpDraft): Promise<McpServerStatus> {
    assertValidServerName(draft.id, "新 MCP 服务器");
    // ⚠️ **落库前先拿候选行过形状闸**：写不进一条「读出来会被拒」的行（`db/read.js` 的两个「与驱动同形」
    //   把缺省的键化成 `NULL` / 列缺省，否则闸会把「没写 url」判成「写了 url」）。⚠️ 服务层不做这件事——
    //   它只管搬数据，MCP 的规矩在这一圈。
    const createdAt = Date.now();
    mcpConfigFromRow(
      { ...mcpNewRowFromDraft({ ...draft, createdAt }), updatedAt: createdAt },
      `新 MCP 服务器 ${draft.id}`,
    );
    return this.serial(async () => {
      if (this.ctx.services.mcps.get(draft.id) !== undefined) {
        throw new Error(
          `MCP 服务器「${draft.id}」已经在 mcps 表里了；要顶掉它就先 delete —— 默默覆盖用户写的那一行最难查`,
        );
      }
      this.ctx.services.mcps.create({ ...draft, createdAt });
      await this.reconcile(draft.id);
      return this.mustStatus(draft.id);
    });
  }

  /**
   * 改一台：落库后立刻按新样子起停；`false` = 表里没这一台（什么也没做，不抛）。
   * @description ⚠️ **形状闸与「换传输要清空另一支的列」在这里**：先读现有行、与这个 patch 合并成改完之后的
   *   整行去过闸，跑不过就不写（只改 `transport` 会留下「stdio 的行却带着 url」，当场被拒）。⚠️ 对表**只会
   *   重开这一台**：戳变了就动它，别的台不动。
   */
  update(name: string, changes: McpChanges): Promise<boolean> {
    return this.serial(async () => {
      const existing = this.ctx.services.mcps.get(name);
      if (existing === undefined) return false;
      const updatedAt = Date.now();
      const defined = mcpDefinedPatch(changes);
      mcpConfigFromRow({ ...existing, ...defined, updatedAt }, `MCP 服务器 ${name}`);
      const ok = this.ctx.services.mcps.update(name, { ...defined, updatedAt });
      if (!ok) return false;
      await this.reconcile(name);
      return true;
    });
  }

  /**
   * 改 `disabled` 这一格并按它起停这一台（`update` 的窄口）。⚠️ `true` = 关掉且本进程不再起它（配置留着，
   *   `list()` 里它变成 `disabled`），**不删那一行**——删是 {@link McpManager.delete}。
   */
  setDisabled(name: string, disabled: boolean): Promise<boolean> {
    return this.update(name, { disabled });
  }

  /** 删一台：落库 + 关掉 + 摘掉它的工具；没这一台给 `false`（对表范围缩到这一个名字） */
  delete(name: string): Promise<boolean> {
    return this.serial(async () => {
      const ok = this.ctx.services.mcps.delete(name);
      if (!ok) return false;
      await this.reconcile(name);
      return true;
    });
  }

  /**
   * 重启一台：关掉旧会话、按**库里现在这一行**重新起（**不改数据**）；起没起来不抛，看 `list()`。
   * @returns `false` = 没有可重启的（表里没这一台，或它被标了 `disabled`——那台在本进程里没有会话）
   * @description ⚠️ **绕开计划**：重启不改数据 ⇒ 戳没变、计划不会判它「动过」⇒ 只能直接动手。
   */
  restart(name: string): Promise<boolean> {
    return this.serial(async () => {
      const row = this.ctx.services.mcps.get(name);
      if (row === undefined || row.disabled) return false;
      await this.applyOne(this.desiredOf(row), this.entries.get(name));
      return true;
    });
  }

  // ---------------------------------------------------------------- 对表

  /**
   * 把一台对齐到库里现在这一行（改过就重开、被 `disabled` 就关掉、新增就起）；没这一台也照走（等于关掉）。
   * @description 这是 `mcp.data.changed` 落下来的地方：**谁写库都算**（本类、`ctx.services.mcps`、将来的
   *   导入），所以「真值是表」这句话才成立。
   */
  sync(name: string): Promise<void> {
    return this.serial(() => this.reconcile(name));
  }

  /** 全量对表，并**重试**上一轮落成 `failed` 的那些；逐条规则见 `plan.ts` 文件头 */
  reload(): Promise<void> {
    return this.serial(async () => {
      this.safely(() => this.ctx.emit("mcp.reload.start"));
      await this.reconcile();
      this.safely(() => this.ctx.emit("mcp.reload.finish"));
      this.report();
    });
  }

  /**
   * 全部收掉。⚠️ **刻意不排队、不 await**：已经没有下一次操作了，排队只会拖住退出。关不掉的不抛——退出路径上
   *   再叠一个错只会盖掉真正的错。
   */
  dispose(): void {
    for (const entry of this.entries.values()) {
      const session = entry.session;
      entry.session = undefined;
      void session?.close().catch(() => undefined);
    }
    this.entries.clear();
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 按库里现在这些行，把运行期对过去。**唯一的动手入口**——起 / 重开 / 关都从这里出去。
   * @param scope - 只对一台（其余一律不碰）。⚠️ 范围必须同时套在「表里这些」与「该跑的那些」两边，否则单台
   *   对表会把范围外的名字全判成该关（`plan.ts` 规则 1）
   */
  private async reconcile(scope?: string): Promise<void> {
    const plan = planMcp(this.entriesInScope(scope), this.desiredFor(scope));
    for (const name of plan.stop) await this.stopOne(name);
    for (const want of plan.reopen) await this.applyOne(want, this.entries.get(want.name));
    for (const want of plan.start) await this.applyOne(want, undefined);
  }

  /** 本次范围内的表里那些行（范围 = 一个名字，或全部） */
  private entriesInScope(scope?: string): readonly (readonly [string, McpEntry])[] {
    if (scope === undefined) return [...this.entries];
    const entry = this.entries.get(scope);
    return entry === undefined ? [] : [[scope, entry] as const];
  }

  /** 本次范围内「按库里那一行该跑」的那些（`disabled` 的与不存在的都不算） */
  private desiredFor(scope?: string): readonly McpDesired[] {
    const rows =
      scope === undefined
        ? this.ctx.services.mcps.listEnabled()
        : [this.ctx.services.mcps.get(scope)].filter((row): row is Mcp => row !== undefined && !row.disabled);
    return rows.map((row) => this.desiredOf(row));
  }

  /**
   * 一行 → 「按这一行该起什么」。
   * @description ⚠️ **形状闸在这一步逐台跑**（`db/read.js` 的 `mcpConfigFromRow` 就在这里被调）：一台配置坏了
   *   的服务器是「这一台起不来」，不是「整批读不出来」——所以异常就地变成 {@link McpDesired} 的 `failure`
   *   分支，它照样出现在 `list()` 里（状态 `failed`，`error` 点名到列），而不是被静默跳过。
   * ⚠️ 行**直接来自表**（`ctx.services.mcps.list` / `listEnabled` / `get`），本类不再为它多读一次。
   */
  private desiredOf(row: Mcp): McpDesired {
    const stamp = row.updatedAt;
    try {
      return { name: row.id, stamp, resolved: mcpConfigFromRow(row, `MCP 服务器 ${row.id}`) };
    } catch (error) {
      return { name: row.id, stamp, failure: asError(error) };
    }
  }

  /**
   * 把一台落到「按这一行该有的样子」；⚠️ **关在前、起在后**，所以它同时是 {@link McpManager.restart} 的实现。
   * @param entry - 它原来那一行（`undefined` = 刚建）；⚠️ **旧会话从这个对象上取**，调用方不用记得先摘 entry
   */
  private async applyOne(want: McpDesired, entry: McpEntry | undefined): Promise<void> {
    const name = want.name;
    const oldSession = entry?.session;
    // ⚠️ **先落新行再动手**：起的过程可达几十秒，那段时间里 `list()` 得看得见「它在 starting」
    const settled: McpEntry = { rowStamp: want.stamp, state: "starting" };
    this.entries.set(name, settled);
    this.safely(() => this.ctx.emit("mcp.server.start", name));
    // ⚠️ **关完才起**：服务器宣告多少条工具随时间变，而旧那批是一次性挂上去的 ⇒ 重开必然是全量换一批
    if (oldSession !== undefined) await oldSession.close();

    if ("failure" in want) {
      settled.state = "failed";
      settled.error = want.failure;
      this.ctx.logger.warn("MCP 服务器「%s」那一行读不出「怎么起它」，其余照常：%s", name, want.failure.message);
      this.safely(() => this.ctx.emit("mcp.server.finish", name, settled.state));
      return;
    }
    const { config, startupTimeoutMs } = want.resolved;
    try {
      settled.session = await openMcpSession(this.ctx, name, config, {
        ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
      });
      settled.state = "connected";
    } catch (error) {
      const failure = asError(error);
      settled.session = undefined;
      settled.state = "failed";
      settled.error = failure;
      // ⚠️ 记 `warn` 而不是 `error`：一台外部服务器没接上是降级，不是本应用出错
      this.ctx.logger.warn("MCP 服务器「%s」没接上，其余照常：%s", name, failure.message);
    }
    this.safely(() => this.ctx.emit("mcp.server.finish", name, settled.state));
  }

  /** 关掉并摘掉一行；没有这一行就什么也不做（幂等） */
  private async stopOne(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (entry === undefined) return;
    const session = entry.session;
    // ⚠️ **先摘再关**：关会话要几十毫秒（退订工具 + 等子进程退出），那段时间里它必须已经不在清单里了，
    //   否则 `list()` 会报「这一台连着，可它的工具正在被摘」
    this.entries.delete(name);
    this.safely(() => this.ctx.emit("mcp.server.start", name));
    if (session !== undefined) await session.close();
    // ⚠️ 关完它在运行期**已经没有存在**了 ⇒ 落成什么状态由库里那一行说
    this.safely(() => this.ctx.emit("mcp.server.finish", name, this.settledStateAfterStop(name)));
  }

  /** 关掉之后它该是什么状态：还在库里且被标了 `disabled` ⇒ `disabled`；其余（含已删）⇒ `stopped` */
  private settledStateAfterStop(name: string): McpServerState {
    const row = this.ctx.services.mcps.get(name);
    return row !== undefined && row.disabled ? "disabled" : "stopped";
  }

  /**
   * 发一条事件，并**兜住监听器抛的错**。
   * @description ⚠️ `ctx.emit` 会把监听器的错原样冒出来（它不隔离），而发事件的地方都在**状态改到一半**的位置
   *   上：监听器一抛，`applyOne` 就在半截处退出，那一行会永远留在 `starting`。事件是通知，通知失败不该改
   *   运行期的事实。
   */
  private safely(emit: () => void): void {
    try {
      emit();
    } catch (error) {
      this.ctx.logger.warn("MCP 的事件监听器抛了错，不影响运行期：%s", asError(error).message);
    }
  }

  /** 一条汇总（⚠️ 逐台记日志等于启动刷屏：起没起是常态信息） */
  private report(): void {
    const rows = this.list();
    if (rows.length === 0) {
      this.ctx.logger.info("MCP：mcps 表里一台都没有");
      return;
    }
    const connected = rows.filter((row) => row.state === "connected");
    this.ctx.logger.info(
      "MCP：%d 台里接上 %d 台（%d 台标了不自动起），给出 %d 条工具（%s）；%d 台没接上",
      rows.length,
      connected.length,
      rows.filter((row) => row.state === "disabled").length,
      connected.reduce((sum, row) => sum + row.tools.length, 0),
      connected.map((row) => `${row.name} → ${row.serverInfo}`).join("，"),
      rows.filter((row) => row.state === "failed").length,
    );
  }

  /** 刚写进表的那一台的近况；读不回来说明**写进去的那次调用与这里之间有别人删了它** */
  private mustStatus(name: string): McpServerStatus {
    const status = this.get(name);
    if (status === undefined) throw new Error(`MCP 服务器「${name}」刚写进 mcps 表，却已经读不回来了`);
    return status;
  }

  /**
   * 排队跑一件事。⚠️ **队尾吞掉成败**：前一个动作失败不该堵死后面（否则一次写库撞名就把整个 MCP 圈子死锁
   *   在那儿），但**它自己的成败照原样交回调用方**。
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