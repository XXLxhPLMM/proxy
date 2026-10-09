/**
 * @fileoverview 执行域：命令队列 + 副作用 + 模型那一圈（逻辑逐字搬自 `AppState.tsx` 执行层，不读其它 domain hook）
 */

import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";

import { ALL_TARGETS, COMMAND_PREFIX, parseLine, type ParseResult } from "@/commands/index.js";
import {
  clearMessages,
  redactTarget,
  splitModelRef,
  targetOf,
  type Ledger,
  type Target,
} from "@/services/config/index.js";
import { exec, fanOut, type BatchPeer, type BatchReport, type Effect, type ExecDeps } from "@/lib/exec/index.js";
import { ask } from "@/lib/agent.js";
import type { DialectInput } from "@/services/model/index.js";
import { describe, pushHistory, rowsOfFailure } from "@/lib/index.js";
import { type LogEntry, type LogRow, type Turn } from "@/lib/log/index.js";
import { BATCH_NO_TARGET, EXIT_BUSY } from "@/domains/cells.js";
import {
  MODEL_TIMEOUT_MS,
  emptyBucket,
  useExecStore,
  useLedgerStore,
  useSessionsStore,
  useUiStore,
  type Job,
} from "@/store/index.js";

export interface ExecDomainDeps {
  readonly ledgerFile: string;
  readonly exit: () => void;
  readonly viewportRef: MutableRefObject<{ width: number; rows: number }>;
  /** 输入历史游标（与输入行导航共用，故留在调用方，这里只在提交时清零） */
  readonly historyAtRef: MutableRefObject<number>;
  readonly push: (sessionId: string, turns: readonly Turn[], at: number) => void;
  readonly sayIn: (sessionId: string | null, text: string) => void;
  readonly spawnOne: () => string;
  readonly ensureSession: () => string;
  readonly resetSessionMessages: (id: string, entries: readonly LogEntry[]) => void;
  readonly openRename: (id: string) => void;
  readonly openHistory: () => void;
  readonly openTargets: () => void;
  readonly openUsers: () => void;
  readonly openProviders: () => void;
  readonly openModels: () => void;
  readonly current: Target | null;
  readonly reprobe: (id: string) => void;
}

export interface ExecDomainApi {
  readonly running: string | null;
  readonly chatting: boolean;
  readonly submit: (raw: string) => void;
}

export function useExecDomain(deps: ExecDomainDeps): ExecDomainApi {
  const {
    ledgerFile,
    exit,
    viewportRef,
    historyAtRef,
    push,
    sayIn,
    spawnOne,
    ensureSession,
    resetSessionMessages,
    openRename,
    openHistory,
    openTargets,
    openUsers,
    openProviders,
    openModels,
    current,
    reprobe,
  } = deps;

  const running = useExecStore((s) => s.running);
  const chatting = useExecStore((s) => s.chatting);
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const providers = useLedgerStore((s) => s.providers);
  const setSessions = useSessionsStore((s) => s.setSessions);
  const setHistory = useUiStore((s) => s.setInputHistory);

  /* 这些 ref 的唯一理由：异步回调要读到「下一次渲染的视角」 */
  const pumpRef = useRef<() => void>(() => {});
  const applyEffectRef = useRef<(sessionId: string, effect: Effect) => void>(() => {});
  // ⚠️ 队列与忙闲不另设 ref 镜像：`useExecStore.getState()` 本来就是同步最新的

  const active = useMemo(() => sessions.find((one) => one.id === activeId) ?? null, [sessions, activeId]);

  /* ── 执行层 ──────────────────────────────────────────────────────────────── */

  const depsFor = useCallback(
    (job: Job): ExecDeps => ({
      target: current === null ? null : targetOf(current),
      width: viewportRef.current.width,
      line: job.line,
      // ⚠️ **两份清单都是注入进来的**：执行层不读台账，而 `/accounts` 与 `/targets` 弹窗画的是同一份
      accounts: () => ({ accounts: useLedgerStore.getState().accounts }),
      targetsView: () => (useLedgerStore.getState().ledger?.targets ?? []).map((one) => redactTarget(one)),
      // ⚠️ `/batch` 的「名字 → 请求参数」在**这里**解：执行层不读台账（理由见 `ExecDeps.peers`）
      peers: (names) => peersOf(names, useLedgerStore.getState().ledger),
    }),
    [current],
  );

  /** `/batch` 的那些名字 → 目标（⚠️ `all` 在这里对着台账展开，而**顺序恒等于台账顺序**） */
  function peersOf(names: readonly string[], book: Ledger | null): readonly BatchPeer[] {
    const all = book?.targets ?? [];
    if (names.length === 1 && names[0] === ALL_TARGETS) {
      return all.map((one) => ({ name: one.name, target: targetOf(one) }));
    }
    // ⚠️ **按台账顺序**而不是按命令里写的顺序：结果区的排序恒等于台账那一列
    return all
      .filter((one) => names.includes(one.name))
      .map((one) => ({ name: one.name, target: targetOf(one) }));
  }

  /** 「三台里两台成功」那一句（⚠️ **逐台数**而不是只说「完成」—— 少一句就等于让操作者自己数） */
  function summaryOf(reports: readonly BatchReport[]): LogRow {
    const ok = reports.filter((one) => one.ok).length;
    const bad = reports.length - ok;
    const tally = bad === 0 ? `${String(ok)} 台全部成功` : `${String(ok)} 台成功 · ${String(bad)} 台失败`;
    return { kind: bad === 0 ? "note" : "err", text: `/batch ${tally}（共 ${String(reports.length)} 台）` };
  }

  const runBatch = useCallback(
    (sessionId: string, effect: Extract<Effect, { kind: "batch" }>): void => {
      if (effect.peers.length === 0) {
        push(sessionId, [{ kind: "error", rows: [{ kind: "err", text: BATCH_NO_TARGET }] }], Date.now());
        return;
      }
      void fanOut(effect.command, effect.peers, (peer) => ({
        ...depsFor({ sessionId, line: effect.line, command: effect.command }),
        target: peer.target,
      })).then(({ reports, effects }) => {
        const turns: Turn[] = [];
        for (const report of reports) {
          turns.push({ kind: "tool-call", echo: { kind: "echo", text: `${report.name} · ${effect.line}` } });
          turns.push(report.ok ? { kind: "tool-result", rows: report.rows } : { kind: "error", rows: report.rows });
        }
        turns.push({ kind: "notice", rows: [summaryOf(reports)] });
        push(sessionId, turns, Date.now());
        for (const one of effects) applyEffectRef.current(sessionId, one);
      });
    },
    [depsFor, push],
  );

  /** 一条命令的**副作用**。⚠️ **穷举**而不是「取第一条」：多一个 `Effect` 种类时这一支会编译期红 */
  const applyEffect = useCallback(
    (sessionId: string, effect: Effect): void => {
      switch (effect.kind) {
        case "clear-log":
          setSessions((prev) =>
            prev.map((one) => (one.id === sessionId ? { ...one, bucket: emptyBucket() } : one)),
          );
          // ⚠️ **盘上那一份也得空**（`messages` 表按 `(session_id, seq)` 主键存着这个会话的每一格）
          try {
            clearMessages(ledgerFile, sessionId);
            resetSessionMessages(sessionId, []);
          } catch (err) {
            sayIn(sessionId, `这个会话的对话没清掉（${describe(err)}）—— 重开一次它还在那儿`);
          }
          break;
        case "reprobe":
          if (current !== null) reprobe(current.id);
          break;
        case "session-new":
          // ⚠️ 转调 {@link spawnOne}：各条入口不许各造一次会话（发号只有一处）
          spawnOne();
          break;
        case "open-rename":
          if (activeId !== null) openRename(activeId);
          break;
        case "open-sessions":
          openHistory();
          break;
        case "targets-open":
          openTargets();
          break;
        case "users-open":
          openUsers();
          break;
        case "providers-open":
          openProviders();
          break;
        case "models-open":
          openModels();
          break;
        case "batch":
          runBatch(sessionId, effect);
          break;
        // ⚠️ **还有东西在飞就退不成**：它们落地时都要往台账上写，而 `finish()` 先 `closeLedgerDb()` ——
        // 症状是组件已经 `unmount` 之后才抛出来的「库已关」，屏上零解释
        case "request-exit":
          if (useExecStore.getState().queue.length > 0 || useExecStore.getState().busy || chatting) {
            sayIn(sessionId, EXIT_BUSY);
            break;
          }
          exit();
          break;
        // ⚠️ **这一句就是那道编译期锁，而它的位置只能在这里**：`default` 子句被 TypeScript 当成
        // 「匹配一切」，故只有这个赋值查缺档（`switch` 语句本身不查）。
        // ⚠️ 放在 `switch` 之前或之后都编不过：那一刻形参还是整个 `Effect`。
        default: {
          const _exhaustive: never = effect;
          throw new Error(`应用层不认识这个副作用：${JSON.stringify(_exhaustive)}`);
        }
      }
    },
    [
      current,
      reprobe,
      activeId,
      ledgerFile,
      spawnOne,
      openRename,
      openHistory,
      openTargets,
      openUsers,
      openProviders,
      openModels,
      runBatch,
      sayIn,
      chatting,
      exit,
      setSessions,
    ],
  );

  useEffect(() => {
    applyEffectRef.current = applyEffect;
  }, [applyEffect]);

  /** 启动队列里的下一条（**串行化的全部实现**） */
  const pump = useCallback((): void => {
    const snap = useExecStore.getState();
    if (snap.busy) return;
    const job = snap.queue[0];
    if (job === undefined) return;
    snap.dequeue();
    snap.setBusy(true);
    snap.setRunning(job.line);
    void exec(job.command, depsFor(job))
      .then((result) => {
        // ⚠️ **一个字节都不留的命令不许留下「一格空对话」**：`leavesTrace` 说它们不留痕
        if (result.rows.length > 0) {
          push(job.sessionId, [{ kind: "tool-result", rows: result.rows }], Date.now());
        }
        useExecStore.getState().setBusy(false);
        for (const effect of result.effects) applyEffect(job.sessionId, effect);
      })
      .catch(() => {
        push(
          job.sessionId,
          [{ kind: "error", rows: [{ kind: "err", text: "本包在执行这条命令时崩了（不是控制面的回答）" }] }],
          Date.now(),
        );
      })
      .finally(() => {
        useExecStore.getState().setBusy(false);
        useExecStore.getState().setRunning(null);
        const more = useExecStore.getState().queue.some((one) => one.sessionId === job.sessionId);
        if (!more) {
          setSessions((prev) =>
            prev.map((one) =>
              one.id === job.sessionId
                ? // ⚠️ **「看过了」只在结果落进你此刻正看着的那一个桶时置位**：提交那一刻就置位的话，
                  // 「在别的会话里跑、跑完了你还没看」这一格永远亮不起来
                  { ...one, run: "done", seen: one.id === activeId ? true : one.seen }
                : one,
            ),
          );
        }
        pumpRef.current();
      });
  }, [depsFor, push, applyEffect, activeId, setSessions]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  /* ── 模型那一圈 ──────────────────────────────────────────────────────────── */

  /** 当前会话那个模型键 → 出网要的那几格（⚠️ **`null` = 没配好**，而那一档一个请求都不发） */
  const modelEndpoint = useMemo((): Omit<DialectInput, "messages" | "signal" | "fetchImpl"> | null => {
    if (active === null || active.modelRef === null) return null;
    const split = splitModelRef(active.modelRef);
    if (split === null) return null;
    const provider = providers.find((one) => one.id === split.providerId);
    // ⚠️ **三格都齐才发请求**：地址或凭据为空时屏上那句是「还没配」，而对面会答 401
    if (provider === undefined || provider.baseUrl === "" || provider.apiKey === "") return null;
    return {
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: split.modelId,
      reasoning: active.reasoning,
    };
  }, [active?.modelRef, active?.reasoning, providers]);

  /** 一句不是命令的话 → 模型那一圈（⚠️ **它不走 `pump`**：那一圈自己要往返好几轮） */
  const sayToModel = useCallback(
    (sessionId: string, text: string): void => {
      const past =
        sessions.find((one) => one.id === sessionId)?.bucket.entries.flatMap(
          (entry) => entry.turns,
        ) ?? [];
      useExecStore.getState().setChatting(true);
      void ask(text, past, {
        endpoint: modelEndpoint,
        timeoutMs: MODEL_TIMEOUT_MS,
        execDeps: depsFor({ sessionId, line: text, command: { kind: "clear" } }),
      }).then((result) => {
        useExecStore.getState().setChatting(false);
        if (result.kind === "ok") {
          push(sessionId, result.turns, Date.now());
          for (const effect of result.effects) applyEffect(sessionId, effect);
          return;
        }
        push(
          sessionId,
          [...result.turns, { kind: result.kind === "no-provider" ? "notice" : "error", rows: result.rows }],
          Date.now(),
        );
      });
    },
    [modelEndpoint, depsFor, push, applyEffect],
  );

  /** 提交一行：**先分流**（命令 vs 一句话）→ 清输入行 → 排队 / 贴判据 */
  const submit = useCallback(
    (raw: string): void => {
      const line = raw.trim();
      // ⚠️ **零会话那一档先造一个**：输入一句话 / 敲命令都要求「有一个会话在」，而那一个此刻还不存在
      const sessionId = ensureSession();
      const isCommand = line.startsWith(COMMAND_PREFIX);
      const parsed: ParseResult = isCommand ? parseLine(line) : { kind: "empty" };
      setSessions((prev) =>
        prev.map((one) =>
          one.id === sessionId
            ? {
                ...one,
                input: "",
                cursor: 0,
                anchor: null,
                // ⚠️ **只有真的排上了队才亮那枚转圈**：光按一次回车或解析失败的时候亮它，它就永远等不到「跑完了」
                run: parsed.kind === "ok" ? "running" : one.run,
              }
            : one,
        ),
      );
      historyAtRef.current = -1;
      if (line === "") return;
      if (!isCommand) {
        setHistory((prev) => pushHistory(prev, line));
        sayToModel(sessionId, line);
        return;
      }
      if (parsed.kind === "ok") {
        setHistory((prev) => pushHistory(prev, line));
        useExecStore.getState().enqueue({ sessionId, line, command: parsed.command });
        pumpRef.current();
        return;
      }
      push(sessionId, [{ kind: "error", rows: rowsOfFailure(parsed) }], Date.now());
    },
    [ensureSession, setSessions, sayToModel, push],
  );

  return { running, chatting, submit };
}

/* ── 接线清单（给指挥官：调用方照此传参、取返回值） ──────────────────────────
 * 导出：useExecDomain(deps)、ExecDomainDeps、ExecDomainApi。
 * ExecDomainApi（返回值）：running（string | null，状态行“执行中”）、chatting（boolean，
 *   状态行“模型对话中”）、submit(raw)（输入行唯一入口：命令排队 / 一句话走模型）。
 * ExecDomainDeps（调用方传入，共 17 字段）：
 *   ledgerFile（台账路径：clear-log 落盘）、exit（cli.tsx 的幂等 finish）、
 *   viewportRef（结果区宽度，depsFor 用；归属仍在 AppState，与 sessions 域共用）、
 *   historyAtRef（输入历史游标，提交时清零；归属仍在 AppState，与输入导航共用）、
 *   push / sayIn / spawnOne / ensureSession / resetSessionMessages（sessions 域回调）、
 *   openRename / openHistory / openTargets / openUsers / openProviders / openModels（window 域回调）、
 *   current / reprobe（ledger 域值与回调）。
 * 本 hook 内部订阅：useExecStore（queue/busy/running/chatting 全家）、useSessionsStore
 *   （sessions/activeId/setSessions）、useLedgerStore（providers；accounts/ledger 读 getState）、
 *   useUiStore（setInputHistory）。不 import 任何 domain hook。
 * 有意没搬的：fetchModels 那圈 listProviderModels（AppState 约 691～730 行，弹窗域，不在本范围）；
 *   sessionRowsRef（本范围无一处读取，不列入 deps）。
 * 有意没留的：queueRef/busyRef——队列与忙闲以 useExecStore 为唯一真相源，异步续体一律
 *   getState() 读最新快照（与 ref 同步等价，少一份镜像就少一处漂移）；pumpRef/applyEffectRef
 *   保留（打破 runBatch→applyEffect→pump→submit 的回调成环）。
 */
