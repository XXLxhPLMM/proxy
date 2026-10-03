/**
 * @fileoverview 根组件：全屏 console 的应用状态层（唯一持有跨帧状态，唯一把一次动作翻成若干次 `setState`）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  complete,
  paletteFill,
  paletteOf,
  paletteStep,
  paletteWindow,
  parseLine,
} from "@/cmd/index.js";
import {
  DEFAULT_TIMEOUT_MS,
  LedgerError,
  clientFor,
  probeTarget,
  readLedger,
  removeTarget,
  selectedTarget,
  setSelected,
  upsertTarget,
  writeLedger,
  type Ledger,
  type Target,
} from "@/ledger/index.js";
import { append, clampTop, flatten, trim, type FlatLog, type LogRow } from "@/log/index.js";
import { exec, type Effect, type ExecDeps } from "@/exec/index.js";
import { connectionStateOf, type ProbeSlot } from "@/ui/index.js";
import { mouseUnsupportedHintOf, type MouseSource } from "@/terminal/index.js";
import {
  Layout,
  SIDEBAR_WIDTH,
  geometry,
  type PaletteView,
  type SessionRow,
  type WindowRow,
  type WindowView,
} from "@/view/index.js";

import { describe, droppedHint, idOfName, readLedgerSafe, rowsOfFailure } from "./failures.js";
import {
  LOG_KEEP,
  MESSAGE_TTL_MS,
  emptyBucket,
  newSession,
  type Bucket,
  type CaretActive,
  type EditActive,
  type FillActive,
  type Job,
  type Session,
  type WindowKind,
} from "./state.js";
import { useKeyboard } from "./use-keyboard.js";
import { useMouse, type ResizeStart } from "./use-mouse.js";
import { useTerminalSize } from "./use-terminal-size.js";

export interface AppProps {
  /** 台账文件路径（`@/ledger/path.ts:targetsPath` 的产物，由组合根算好） */
  readonly ledgerFile: string;
  /** 终端总列数（组合根那次快照，⚠️ 只是**初值**：屏上用的是 `useTerminalSize` 的当前值） */
  readonly columns: number;
  /** 终端总行数（同上；⚠️ 缺了它就画不出上下分栏） */
  readonly rows: number;
  /** 要不要上色（`NO_COLOR` / `TERM=dumb` / `CI` 由组合根判好） */
  readonly color: boolean;
  /** 版本号（组合根从构建期注入的 `APP_VERSION` 取；空串 = 不知道，状态行右半**整个**不显示它） */
  readonly version: string;
  /** 鼠标事件源（生命周期归组合根；本组件只订阅） */
  readonly mouse: MouseSource;
}

export function App({ ledgerFile, columns, rows, color, version, mouse }: AppProps) {
  /** 终端当前的宽高（props 那两个只是初值；本层零 `process.*`） */
  const size = useTerminalSize({ columns, rows });

  /** 会话清单（⚠️ **至少一个**：没有输入行就没有任何命令） */
  const [sessions, setSessions] = useState<readonly Session[]>(() => [newSession("s1", "会话 1")]);
  /** 当前是哪个会话（⚠️ 它是 `id` 不是下标：`/new` 之后下标全变，而按下标存的 hover 会指着另一个） */
  const [activeId, setActiveId] = useState("s1");
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [ledgerError, setLedgerError] = useState<LedgerError | null>(null);
  /** 改台账后触发重读盘（`target add` / `target del` 之后） */
  const [ledgerTick, setLedgerTick] = useState(0);
  /** 每个控制面最近一次探活持有的那个值（`undefined` = 还没探过） */
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeSlot>>(
    () => new Map<string, ProbeSlot>(),
  );
  /** 输入区中间那一行（执行中 / 一条瞬时消息） */
  const [message, setMessage] = useState<string | null>(null);
  /** 正在跑的那条命令的原文（`null` = 队列空着） */
  const [running, setRunning] = useState<string | null>(null);
  const [windowKind, setWindowKind] = useState<WindowKind>(null);
  /** 窗口里高亮第几行（**下标**，不是 `id` —— 窗口是公共组件，它不认识控制面） */
  const [windowAt, setWindowAt] = useState(0);
  /** 侧边栏宽度（**用户拖出来的那个值**，允许越界；合法区间由几何层算） */
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH);
  /** 侧边栏会话清单滚到第几项（下标）；⚠️ 唯一一份「窗口停在哪」，而「当前会话必须留在窗口里」由 `revealSession` 维持（几何层故意只夹不推） */
  const [sessionsTop, setSessionsTop] = useState(0);

  /* 这些 ref 的唯一理由：异步回调要读到「下一次渲染的视角」 */

  /** 内存里那份台账（与 `ledger` **同一个写入口**） */
  const ledgerRef = useRef<Ledger | null>(null);
  /** 每个 id 的探活序号（⚠️ 回来的那次探活靠它判新旧，见 {@link reprobe}） */
  const probeSeq = useRef(new Map<string, number>());
  /** 排队中还没跑的命令（**只进不出**，故不需要 state） */
  const queueRef = useRef<Job[]>([]);
  /** 此刻是不是正在跑一条（`true` 时 {@link pump} 拒绝启动下一条） */
  const busyRef = useRef(false);
  /** {@link pump} 自己（串行化要它回调自己，而 `useCallback` 的空依赖版本看不到自己） */
  const pumpRef = useRef<() => void>(() => {});
  /** 视口（结果区内容宽度与视口行数）；异步回调里要用**当下**的那一份 */
  const viewportRef = useRef({ width: 0, rows: 0 });
  /** 侧边栏放得下几项会话（⚠️ 同上：{@link revealSession} 是回调，读不到下一次渲染的那一份） */
  const sessionRowsRef = useRef(1);
  /** 会话序号（造新会话 id 的唯一发号处） */
  const sessionSeq = useRef(1);
  /** 台账读出来之后**只**给第一个会话播种一次（⚠️ 种子不是「当前目标」，见那处 effect） */
  const seededRef = useRef(false);
  /** 正在拖宽侧边栏吗（`null` = 没拖）。⚠️ **存起点而不存当前宽度**：见 `./use-mouse.js` */
  const resizingRef = useRef<ResizeStart | null>(null);

  /** 内存里那份台账的**唯一**写入口（`state` 与 {@link ledgerRef} 在这里一起落） */
  const holdLedger = useCallback((next: Ledger | null): void => {
    ledgerRef.current = next;
    setLedger(next);
  }, []);

  useEffect(() => {
    try {
      holdLedger(readLedger(ledgerFile));
      setLedgerError(null);
    } catch (err) {
      // ⚠️ 读失败**不碰**内存里那份：当成空台账，下一次写就会覆盖掉存着凭据的那份
      setLedgerError(err instanceof LedgerError ? err : new LedgerError("unreadable", "台账读不出来"));
    }
  }, [ledgerFile, ledgerTick, holdLedger]);

  const targets: readonly Target[] = useMemo(() => ledger?.targets ?? [], [ledger]);

  /** 当前会话（永远有一个：清单空了是 bug，不是「没有当前会话」） */
  const active: Session = useMemo(() => {
    const found = sessions.find((one) => one.id === activeId);
    return found ?? sessions[0] ?? newSession("s1", "会话 1");
  }, [sessions, activeId]);

  /** 当前会话连的是哪个控制面（`null` = 还没选）；⚠️ 认 `id` 不认名字（名字可重复）；它与台账的 `selected` 是两件事（后者是「上次用的」） */
  const current: Target | null = useMemo(
    () => targets.find((one) => one.id === active.targetId) ?? null,
    [targets, active.targetId],
  );

  /** 台账读出来之后给第一个会话播种一次；⚠️ 只播种一次（`seededRef`），否则每次重读都把「`target switch` 切过去的那台」盖回台账的旧值 */
  useEffect(() => {
    if (seededRef.current || ledger === null) return;
    seededRef.current = true;
    const seed = selectedTarget(ledger);
    if (seed === null) return;
    setSessions((prev) =>
      prev.map((one, i) => (i === 0 && one.targetId === null ? { ...one, targetId: seed.id } : one)),
    );
  }, [ledger]);

  /** 往某一个会话的桶追加若干行（原子地重算 `top`）；⚠️ 按**会话 id** 而不是「当前会话」：结果必须落在排队那一刻的那个会话里 */
  const push = useCallback((sessionId: string, rows: readonly LogRow[], at: number): void => {
    if (rows.length === 0) return;
    const viewport = viewportRef.current;
    setSessions((prev) =>
      prev.map((one) => {
        if (one.id !== sessionId) return one;
        const before = one.bucket;
        const entries = trim(append(before.entries, rows, at), LOG_KEEP);
        const height = flatten(entries, viewport.width).height;
        const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
        const top = before.follow ? bottom : clampTop(height, viewport.rows, before.top);
        return { ...one, bucket: { entries, top, follow: before.follow } };
      }),
    );
  }, []);

  /** 一条命令的结果之外的那句话；⚠️ 落在**当前会话**的桶里，且**同时**进中间那一行（那行会自己消失，这条不会） */
  const say = useCallback(
    (text: string): void => {
      setMessage(text);
      push(activeId, [{ kind: "note", text }], Date.now());
    },
    [push, activeId],
  );

  // ⚠️ 计时器**跟着消息走**（依赖是 `message` 本身）：写成 `[message !== null]` 会让「换一条消息」
  // 不重启计时器，于是第二条只显示第一段剩余时间。
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_TTL_MS);
    return () => clearTimeout(timer);
  }, [message]);

  /** 滚一段（`delta` 为正是往下）—— **只作用于当前会话** */
  const scrollBy = useCallback(
    (delta: number): void => {
      const viewport = viewportRef.current;
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const height = flatten(one.bucket.entries, viewport.width).height;
          const top = clampTop(height, viewport.rows, one.bucket.top + delta);
          const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          // ⚠️ 滚回最底下时重新贴底：否则新输出在「我明明已经看到最新了」的屏幕上静默地不出现
          return { ...one, bucket: { ...one.bucket, top, follow: top >= bottom } };
        }),
      );
    },
    [activeId],
  );

  /** 直接定位到顶 / 底 */
  const scrollTo = useCallback(
    (where: "top" | "bottom"): void => {
      const viewport = viewportRef.current;
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const height = flatten(one.bucket.entries, viewport.width).height;
          const top =
            where === "top" ? 0 : clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          return { ...one, bucket: { ...one.bucket, top, follow: where === "bottom" } };
        }),
      );
    },
    [activeId],
  );

  /** 探**任意一个**控制面一次（探活的唯一发起方）；⚠️ 回来的那次靠 `probeSeq` 判新旧（**不是** effect 清理标志：那拦不住已在飞的请求）；⚠️ 在飞要写进去，否则「连接中」与「还没探过」分不开 */
  const reprobe = useCallback((id: string): void => {
    const target = ledgerRef.current?.targets.find((one) => one.id === id);
    if (target === undefined) return;
    const seq = (probeSeq.current.get(id) ?? 0) + 1;
    probeSeq.current.set(id, seq);
    const fresh = (): boolean => probeSeq.current.get(id) === seq;
    setProbes((prev) => new Map(prev).set(id, { pending: true }));
    void probeTarget(clientFor(target))
      .then((result) => {
        if (!fresh()) return;
        setProbes((prev) => new Map(prev).set(id, result));
      })
      .catch(() => {
        // ⚠️ 什么也不写：`ProbeResult` 表达不了「本包有 bug」，而永远兑现不了的「连接中」最坏
        if (!fresh()) return;
        setProbes((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      });
  }, []);

  useEffect(() => {
    if (current === null) return;
    reprobe(current.id);
    // ⚠️ 依赖只有这两项：挂载与切换会话连的那台（按 `r` 重探活的走的不是这里）
  }, [current?.id, reprobe]);

  /** 切到某一个会话（⚠️ 什么都不落盘：会话只在内存里） */
  const switchSession = useCallback((id: string): void => {
    setActiveId((before) => (before === id ? before : id));
  }, []);

  /** 把第 `index` 项带进可见窗口（切 / 建 / 关会话后都要走它）；⚠️ 已经在窗口里就一个字节都不改（否则滚轮翻看别的会话会被下一帧拽回来）；落在窗口之下时**顶到 `index`**，不自己算「往回推几格」 */
  const revealSession = useCallback((index: number): void => {
    const fit = Math.max(1, sessionRowsRef.current);
    setSessionsTop((before) => {
      if (index >= before && index < before + fit) return before;
      return index;
    });
  }, []);

  /** 新开一个会话并切过去（`/new` 与侧边栏空白处右键是同一个入口，发号只有一处） */
  const spawnSession = useCallback((): void => {
    sessionSeq.current += 1;
    const at = sessions.length;
    const id = `s${String(sessionSeq.current)}`;
    // ⚠️ 从 `null` 开始连（继承当前那个的话「/new 之后还在操作同一台机器」屏上看不出来）
    setSessions((prev) => [...prev, newSession(id, `会话 ${String(sessionSeq.current)}`)]);
    setActiveId(id);
    // ⚠️ 那一项在清单末尾，而清单可能装不下：不带进窗口就是零反馈
    revealSession(at);
  }, [sessions.length, revealSession]);

  /** 关掉某一个会话（侧边栏那枚「✕」与右键是同一个入口）；⚠️ 最后一个不关（清单空了就没有地方敲命令）；⚠️ 关当前会话时切到它上一个，关非当前时窗口不乱跳 */
  const closeSession = useCallback(
    (id: string): void => {
      if (sessions.length <= 1) {
        say("至少留一个会话 —— 没有会话就没有地方敲命令");
        return;
      }
      const at = sessions.findIndex((one) => one.id === id);
      if (at < 0) return;
      const rest = sessions.filter((one) => one.id !== id);
      setSessions(rest);
      if (activeId !== id) {
        setSessionsTop((before) => Math.max(0, before - (at < before ? 1 : 0)));
        return;
      }
      const to = Math.max(0, at - 1);
      const picked = rest[to] ?? rest[0];
      if (picked === undefined) return;
      setActiveId(picked.id);
      revealSession(to);
    },
    [sessions, activeId, say, revealSession],
  );

  /** 侧边栏那一列翻几项（指针落在侧边栏上时；`delta` 为正是往下）；⚠️ 只挪窗口，不改当前会话（翻看别的会话不该把「我现在打给谁」也换掉）；一项 = 一会话 */
  const scrollSessions = useCallback(
    (step: number): void => {
      setSessionsTop((before) => Math.max(0, before + step));
    },
    [],
  );

  /** 下一个 / 上一个会话（`Ctrl+N` / `Ctrl+P` / `↑` `↓`；**没有就什么都不做**） */
  const stepSession = useCallback(
    (step: 1 | -1): void => {
      if (sessions.length < 2) {
        if (sessions.length === 1) say("只有 1 个会话，按 /new 可以再开一个");
        return;
      }
      const at = sessions.findIndex((one) => one.id === active.id);
      const to = (Math.max(0, at) + step + sessions.length) % sessions.length;
      const picked = sessions[to];
      if (picked === undefined) return;
      switchSession(picked.id);
      // ⚠️ 循环切换时 `to` 可能绕回窗口之外，故每一次都过一遍「带进窗口」
      revealSession(to);
    },
    [sessions, active.id, switchSession, say, revealSession],
  );

  /** 让某一个会话连上某一个控制面（现读现写）；⚠️ 现读是因为 {@link push} 之后内存里那份可能比磁盘旧；⚠️ 写失败不回滚（它确实发生了、只是没存下来） */
  const useTarget = useCallback(
    (sessionId: string, targetId: string): void => {
      setSessions((prev) =>
        prev.map((one) => (one.id === sessionId ? { ...one, targetId } : one)),
      );
      let failure: string | null = null;
      try {
        writeLedger(ledgerFile, setSelected(readLedger(ledgerFile), targetId));
      } catch (err) {
        failure = describe(err);
      }
      holdLedger(readLedgerSafe(ledgerFile) ?? ledgerRef.current);
      setLedgerTick((tick) => tick + 1);
      if (failure !== null) {
        say(`这次切换没存进台账（${failure}）—— 界面上已经切过去了，关掉就没了`);
      }
    },
    [ledgerFile, holdLedger, say],
  );

  /** 执行层要用的依赖（**现造**，故它读到的是调用那一刻的最新状态） */
  const depsFor = useCallback(
    (job: Job): ExecDeps => ({
      client: current === null ? null : clientFor(current),
      width: viewportRef.current.width,
      line: job.line,
      // ⚠️ **台账的写一律经这几个回调**：直接 `writeLedger` 会造出「内存与磁盘漂移」
      onTargetAdd: (request): void => {
        const next = upsertTarget(readLedger(ledgerFile), {
          name: request.name,
          baseUrl: request.baseUrl,
          token: request.token,
          // ⚠️ 缺省超时在这里补，且**只**在这里补（真值只有 `@/ledger:DEFAULT_TIMEOUT_MS` 一处）
          timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        holdLedger(next);
        writeLedger(ledgerFile, next);
        setLedgerTick((tick) => tick + 1);
      },
      onTargetDel: (name): void => {
        const next = removeTarget(readLedger(ledgerFile), idOfName(ledgerRef.current, name));
        holdLedger(next);
        writeLedger(ledgerFile, next);
        setLedgerTick((tick) => tick + 1);
      },
      onTargetSwitch: (name): void => {
        const id = idOfName(ledgerRef.current, name);
        useTarget(job.sessionId, id);
      },
    }),
    [current, ledgerFile, holdLedger, useTarget],
  );

  /** 一条命令的**副作用**。⚠️ **穷举**而不是「取第一条」：多一个 `Effect` 种类时这一支会编译期红 */
  const applyEffect = useCallback(
    (sessionId: string, effect: Effect): void => {
      switch (effect.kind) {
        case "clear-log":
          setSessions((prev) =>
            prev.map((one) => (one.id === sessionId ? { ...one, bucket: emptyBucket() } : one)),
          );
          break;
        case "reprobe":
          if (current !== null) reprobe(current.id);
          break;
        case "ledger-changed":
          setLedgerTick((tick) => tick + 1);
          break;
        case "target-switched":
          // ⚠️ 刻意什么都不做：`onTargetSwitch` 那一刻已经换掉 `targetId` 并落盘
          break;
        case "session-new":
          // ⚠️ 转调 {@link spawnSession}：两条入口不许各造一次会话（发号只有一处）
          spawnSession();
          break;
        case "show-managers":
          // ⚠️ 高亮**默认落在当前会话连的那一台**上：落在第 0 行的话「打开窗口就回车」会静默切到另一台
          setWindowAt(Math.max(0, targets.findIndex((one) => one.id === active.targetId)));
          setWindowKind("managers");
          break;
        default:
          throw new Error(`应用层不认识这个副作用：${JSON.stringify(effect)}`);
      }
    },
    [current, reprobe, targets, active.targetId, spawnSession],
  );

  /** 启动队列里的下一条（**串行化的全部实现**）；⚠️ 排队而不并发（并发的 `clear-log` 会抹掉另一条刚落地半秒的结果）；⚠️ `finally` 里回调自己才是串行化的关键 */
  const pump = useCallback((): void => {
    if (busyRef.current) return;
    const job = queueRef.current.shift();
    if (job === undefined) return;
    busyRef.current = true;
    setRunning(job.line);
    void exec(job.command, depsFor(job))
      .then((result) => {
        push(job.sessionId, result.rows, Date.now());
        for (const effect of result.effects) applyEffect(job.sessionId, effect);
      })
      .catch(() => {
        push(
          job.sessionId,
          [{ kind: "err", text: "本包在执行这条命令时崩了（不是控制面的回答）" }],
          Date.now(),
        );
      })
      .finally(() => {
        busyRef.current = false;
        setRunning(null);
        pumpRef.current();
      });
  }, [depsFor, push, applyEffect]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  /** 提交一行：解析 → 清空输入行 → 排队 / 贴判据；⚠️ 三档都先清输入行，且在任何 `push` 之前：不回显原文（回显只有 {@link exec} 那一个来源，第二个会把明文 token 打进结果区） */
  const submit = useCallback(
    (raw: string): void => {
      const line = raw.trim();
      setSessions((prev) =>
        prev.map((one) => (one.id === activeId ? { ...one, input: "", cursor: 0 } : one)),
      );
      if (line === "") return;
      const parsed = parseLine(line);
      if (parsed.kind === "empty") return;
      if (parsed.kind === "ok") {
        queueRef.current.push({ sessionId: activeId, line, command: parsed.command });
        pumpRef.current();
        return;
      }
      push(activeId, rowsOfFailure(parsed), Date.now());
    },
    [activeId, push],
  );

  /** 面板此刻的样子（高亮是输入行的纯函数，界面上没有「高亮在第几行」这个状态）；⚠️ 所以 `↑`/`↓` 走完必须把那一行写进输入行：下一帧的高亮由那行字自己算出来 */
  const palette = useMemo(() => paletteOf(active.input), [active.input]);

  const movePalette = useCallback(
    (step: 1 | -1): void => {
      const to = paletteStep(palette.at, step, palette.rows.length);
      const row = palette.rows[to];
      if (row === undefined || to === palette.at) return;
      const filled = paletteFill(active.input, active.cursor, row);
      setSessions((prev) =>
        prev.map((one) =>
          one.id === activeId ? { ...one, input: filled.line, cursor: filled.cursor } : one,
        ),
      );
    },
    [palette, active.input, active.cursor, activeId],
  );

  /** `Tab` / 鼠标点行要接受的那一行补进输入行（`null` = 「这一刻没有可接受的那一行」） */
  const acceptPalette = useCallback((): { line: string; cursor: number } | null => {
    const row = palette.rows[palette.at];
    return row === undefined ? null : paletteFill(active.input, active.cursor, row);
  }, [palette, active.input, active.cursor]);

  const closeWindow = useCallback((): void => setWindowKind(null), []);

  /** 窗口里 `↑`/`↓`/`Tab` 走一行（⚠️ 走到底就停住，不循环 —— 循环的话按着 `↓` 会一路滑回第一行） */
  const moveWindow = useCallback(
    (step: 1 | -1): void => {
      setWindowAt((before) => {
        const last = Math.max(0, targets.length - 1);
        return Math.max(0, Math.min(last, before + step));
      });
    },
    [targets.length],
  );

  const pickWindow = useCallback((): void => {
    const picked = targets[windowAt];
    if (picked !== undefined) useTarget(activeId, picked.id);
    closeWindow();
  }, [targets, windowAt, useTarget, activeId, closeWindow]);

  const editActive = useCallback<EditActive>(
    (change) => {
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const after = change(one.input, one.cursor);
          return { ...one, input: after.text, cursor: after.cursor };
        }),
      );
    },
    [activeId],
  );

  const caretActive = useCallback<CaretActive>(
    (pick) => {
      setSessions((prev) =>
        prev.map((one) =>
          one.id === activeId ? { ...one, cursor: pick(one.input, one.cursor) } : one,
        ),
      );
    },
    [activeId],
  );

  const fillActive = useCallback<FillActive>(
    (patch) => {
      setSessions((prev) =>
        prev.map((one) => (one.id === activeId ? { ...one, ...patch } : one)),
      );
    },
    [activeId],
  );

  /** 关掉**当前**会话（`Ctrl+X`；与侧边栏那一枚「✕」同一个入口，见 {@link closeSession}） */
  const closeActiveSession = useCallback((): void => {
    closeSession(activeId);
  }, [closeSession, activeId]);

  useKeyboard({
    windowKind,
    closeWindow,
    moveWindow,
    pickWindow,
    stepSession,
    closeActiveSession,
    scrollBy,
    scrollTo,
    movePalette,
    acceptPalette,
    palette,
    targets,
    input: active.input,
    cursor: active.cursor,
    editActive,
    caretActive,
    fillActive,
    submit,
  });

  /** 侧边栏那几行（每项两行：名字 + 它连的控制面）；⚠️ 认 `id` 不认下标；⚠️ 控制面不在侧边栏（它是**配置**、会话是**上下文**），故「连的是哪台」只落在第二行 */
  const sessionRows: readonly SessionRow[] = useMemo(
    () =>
      sessions.map((one) => ({
        id: one.id,
        name: one.name,
        manager: targets.find((t) => t.id === one.targetId)?.name ?? null,
      })),
    [sessions, targets],
  );

  /** 台账里每个控制面的连接状态（状态行按它数台数；窗口里每一行的字形也走同一个换算） */
  const managerStates = useMemo(
    () => targets.map((one) => connectionStateOf(probes.get(one.id))),
    [targets, probes],
  );

  /** 指针当前悬停在哪个会话上（`null` = 不在侧边栏上） */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /** 指针是不是正落在悬停那一项的「✕」上；⚠️ 命中测试不看悬停（`sidebarCloseRows` 那一格点得中就是点得中），而「亮成别按那一档」只能由 `move` 回答 */
  const [sessionCloseHot, setSessionCloseHot] = useState(false);
  /** 指针在不在拖宽手柄上（那一列给一层底色，于是「能拖」看得见） */
  const [handleHot, setHandleHot] = useState(false);
  /** 指针在不在右上角那枚 `esc` 上 */
  const [closeHot, setCloseHot] = useState(false);

  /** 几何（本层与 `Layout` 调的是同一个纯函数、喂的是同一组字段）；⚠️ `input` 喂**原文**（不是行数：两处各折一次就是两份判据）；⚠️ 宽高喂 `size` 的当前值（拿 props 算会得到两份几何） */
  const g = useMemo(
    () =>
      geometry({
        columns: size.columns,
        rows: size.rows,
        sidebarWidth,
        sessionCount: sessions.length,
        sessionsTop,
        input: active.input,
        paletteCount: palette.rows.length,
        window: windowKind !== null,
        windowRows: targets.length,
        windowFooter: windowKind !== null,
      }),
    [
      size.columns,
      size.rows,
      sidebarWidth,
      sessions.length,
      sessionsTop,
      active.input,
      palette.rows.length,
      windowKind,
      targets.length,
    ],
  );

  /** 面板滚动窗口的第一行号（**绘制与命中测试共用它**） */
  const windowStart = paletteWindow(palette.at, g.paletteViewportRows, palette.rows.length);

  useEffect(() => {
    viewportRef.current = { width: g.outputWidth, rows: g.outputRows };
    sessionRowsRef.current = g.sessionViewportRows;
  }, [g.outputWidth, g.outputRows, g.sessionViewportRows]);

  useMouse({
    mouse,
    geometry: g,
    sessionRows,
    activeId,
    input: active.input,
    cursor: active.cursor,
    palette,
    windowStart,
    windowKind,
    sidebarWidth,
    switchSession,
    scrollBy,
    scrollSessions,
    spawnSession,
    closeSession,
    movePalette,
    closeWindow,
    fillActive,
    resizingRef,
    setSidebarWidth,
    setHoveredId,
    setSessionCloseHot,
    setHandleHot,
    setCloseHot,
    setWindowAt,
  });

  const bucket: Bucket = active.bucket;
  const flat: FlatLog = useMemo(
    () => flatten(bucket.entries, g.outputWidth),
    [bucket.entries, g.outputWidth],
  );
  // ⚠️ 读的时候再夹一次：越界的 `top` 让 `visibleLines` 返回空数组（界面上是「结果区空了」）
  const top = clampTop(flat.height, g.outputRows, bucket.top);

  const suggestion = complete({
    line: active.input,
    cursor: active.cursor,
    targetNames: targets.map((one) => one.name),
  });
  // ⚠️ 幽灵文本 = **「按 Tab 会插进来什么」**，两条来源合成**一个**出口。
  const fillable = palette.open ? acceptPalette() : null;
  const ghost =
    fillable !== null && fillable.cursor > active.cursor
      ? fillable.line.slice(active.cursor, fillable.cursor)
      : suggestion.cursor > active.cursor && suggestion.candidates.length > 0
        ? suggestion.line.slice(active.cursor)
        : null;

  /** 输入区中间那一行：两档，⚠️ 「台账读不出来」排最后是因为它**不消失** */
  const notice =
    running !== null
      ? `执行中：${running}`
      : message ?? (ledgerError === null ? null : `台账读不出来：${ledgerError.message}`);

  /** 命令面板（`null` = 没开）；⚠️ `rows` 给行号序、`at` 也换算成行号（呈现层不需要知道首行号） */
  const paletteView: PaletteView | null = palette.open
    ? {
        total: palette.rows.length,
        rows: palette.rows
          .slice(windowStart, windowStart + g.paletteViewportRows)
          .map((row) => ({ text: row.path, summary: row.summary })),
        at: palette.at - windowStart,
        footer:
          g.paletteFooterRow === null
            ? null
            : `第 ${String(windowStart + 1)}–${String(
                windowStart + Math.min(g.paletteViewportRows, palette.rows.length - windowStart),
              )} 条 · 共 ${String(palette.rows.length)} 条 · ↑↓ 选 · Tab 接受`,
      }
    : null;

  /** 模态窗口的内容（`null` = 没开）；⚠️ 链接在这一行而不在状态行（那行恒定，而链接随会话连的那台变）；⚠️ 删除仍然走命令——一个「点一下就删掉」的按钮删的是管理员凭据 */
  const windowRows: readonly WindowRow[] = useMemo(
    () =>
      targets.map((one) => ({
        id: one.id,
        name: one.name,
        detail: `${one.baseUrl} · 超时 ${String(one.timeoutMs)}ms`,
        state: connectionStateOf(probes.get(one.id)),
        current: one.id === current?.id,
      })),
    [targets, probes, current?.id],
  );

  const windowView: WindowView | null =
    windowKind === null
      ? null
      : {
          title: `控制面（${targets.length}）`,
          rows: windowRows,
          at: windowAt,
          footer:
            targets.length === 0
              ? "台账里还没有控制面 · 用 /target add <名字> <地址> <token> 加一个"
              : "↑↓ 选 · Enter 接到当前会话 · Esc 或点右上角关窗 · 删除用 /target del <名字>",
        };

  return (
    <Layout
      columns={size.columns}
      rows={size.rows}
      color={color}
      version={version}
      sidebarWidth={sidebarWidth}
      sessions={sessionRows}
      sessionsTop={sessionsTop}
      selectedSessionId={activeId}
      hoveredSessionId={hoveredId}
      sessionCloseHot={sessionCloseHot}
      handleHot={handleHot}
      managerStates={managerStates}
      flat={flat}
      top={top}
      input={active.input}
      cursor={active.cursor}
      ghost={ghost}
      notice={notice}
      palette={paletteView}
      mouseHint={mouseUnsupportedHintOf(mouse.liveness(), Date.now())}
      // ⚠️ logo 只在「当前会话还没有任何输出」时占位（台账为空时唯一能敲的那两条命令的输出正落在那桶）
      showLogo={!flat.any}
      droppedHint={droppedHint(bucket)}
      window={windowView}
      closeHot={closeHot}
    />
  );
}
