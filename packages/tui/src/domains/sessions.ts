import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { describe } from "@/lib/index.js";
import { append, clampTop, flatten, trim, type LogEntry, type Turn } from "@/lib/log/index.js";
import {
  appendMessages,
  pinSession,
  readMessages,
  readSessionModels,
  readSessions,
  readSidebar,
  saveSession,
  selectedTarget,
  trimMessages,
  unpinSession,
} from "@/services/config/index.js";
import {
  LOG_KEEP,
  MESSAGE_TTL_MS,
  SEED_SESSION,
  newSession,
  restoredSessions,
  sessionSeqOf,
  useLedgerStore,
  useSessionsStore,
  useUiStore,
  type Bucket,
  type Session,
  type SessionRecord,
  type SidebarEntry,
} from "@/store/index.js";
import { NO_BUCKET, sidebarRecords } from "./cells.js";

export interface SessionsApi {
  readonly sessions: readonly Session[];
  readonly activeId: string | null;
  readonly active: Session | null;
  readonly activeInput: string;
  readonly activeCursor: number;
  readonly activeAnchor: number | null;
  readonly bucket: Bucket;
  readonly historyRecords: readonly SessionRecord[];
  readonly push: (sessionId: string, turns: readonly Turn[], at: number) => void;
  readonly sayIn: (sessionId: string | null, text: string) => void;
  readonly say: (text: string) => void;
  readonly scrollBy: (delta: number) => void;
  readonly scrollTo: (where: "top" | "bottom") => void;
  readonly switchSession: (id: string) => void;
  readonly revealSession: (index: number) => void;
  readonly spawnOne: () => string;
  readonly ensureSession: () => string;
  readonly unpinFromSidebar: (id: string) => void;
  readonly forgetSessionMessages: (id: string) => void;
  readonly resetSessionMessages: (id: string, entries: readonly LogEntry[]) => void;
}

export function useSessionsDomain(deps: {
  readonly ledgerFile: string;
  readonly viewportRef: MutableRefObject<{ width: number; rows: number }>;
  readonly sessionRowsRef: MutableRefObject<number>;
}): SessionsApi {
  const { ledgerFile, viewportRef, sessionRowsRef } = deps;
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const historyRecords = useSessionsStore((s) => s.historyRecords);
  const message = useUiStore((s) => s.message);
  const ledger = useLedgerStore((s) => s.ledger);
  const setSessions = useSessionsStore((s) => s.setSessions);
  const setActiveId = useSessionsStore((s) => s.setActiveId);
  const setHistoryRecords = useSessionsStore((s) => s.setHistoryRecords);
  const setSidebarIds = useSessionsStore((s) => s.setSidebarIds);
  const setSessionsTop = useSessionsStore((s) => s.setSessionsTop);
  const setSessionSeq = useSessionsStore((s) => s.setSessionSeq);
  const setMessage = useUiStore((s) => s.setMessage);

  const entriesRef = useRef(new Map<string, readonly LogEntry[]>());
  const loadedMessagesRef = useRef(new Set<string>());
  const restoredRef = useRef(false);
  const seededRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let records: readonly SessionRecord[];
    let sidebar: readonly SidebarEntry[];
    try {
      records = readSessions(ledgerFile);
      sidebar = readSidebar(ledgerFile);
    } catch (err) {
      setMessage(`会话清单读不出来（${describe(err)}）—— 这一趟只有起步那一个会话`);
      setSessions([newSession(SEED_SESSION.id, SEED_SESSION.name)]);
      setActiveId(SEED_SESSION.id);
      return;
    }
    setHistoryRecords(records);
    setSidebarIds(new Set(sidebar.map((one) => one.sessionId)));
    setSessionSeq(sessionSeqOf(records));
    if (records.length === 0) {
      const now = Date.now();
      try {
        saveSession(ledgerFile, { id: SEED_SESSION.id, name: SEED_SESSION.name, createdAt: now, updatedAt: now });
        pinSession(ledgerFile, SEED_SESSION.id, now);
      } catch (err) {
        setMessage(`起步会话没存进台账（${describe(err)}）—— 关掉就没了`);
      }
    }
    const restored = restoredSessions(sidebarRecords(records, sidebar)).map((one) => {
      try {
        const picked = readSessionModels(ledgerFile, one.id);
        return { ...one, modelRef: picked.modelRef, reasoning: picked.reasoning };
      } catch {
        return one;
      }
    });
    setSessions(restored);
    setActiveId(sidebar[0]?.sessionId ?? records[0]?.id ?? SEED_SESSION.id);
  }, [ledgerFile, setSessions, setActiveId, setHistoryRecords, setSidebarIds, setSessionSeq, setMessage]);

  const active: Session | null = useMemo(
    () => sessions.find((one) => one.id === activeId) ?? null,
    [sessions, activeId],
  );
  const activeInput = active?.input ?? "";
  const activeCursor = active?.cursor ?? 0;
  const activeAnchor = active?.anchor ?? null;
  const bucket: Bucket = active?.bucket ?? NO_BUCKET;

  useEffect(() => {
    if (seededRef.current || ledger === null) return;
    seededRef.current = true;
    const seed = selectedTarget(ledger);
    if (seed === null) return;
    setSessions((prev) =>
      prev.map((one, i) => (i === 0 && one.targetId === null ? { ...one, targetId: seed.id } : one)),
    );
  }, [ledger, setSessions]);

  useEffect(() => {
    if (activeId === null) return;
    setSessions((prev) => prev.map((one) => (one.id === activeId && !one.seen ? { ...one, seen: true } : one)));
  }, [activeId, setSessions]);

  const push = useCallback(
    (sessionId: string, turns: readonly Turn[], at: number): void => {
      if (turns.length === 0) return;
      const viewport = viewportRef.current;
      const before = entriesRef.current.get(sessionId) ?? [];
      const added = append(before, turns, at);
      const fresh = added.slice(before.length);
      let entries: readonly LogEntry[];
      try {
        appendMessages(ledgerFile, sessionId, fresh);
        entries = trim(added, LOG_KEEP);
        if (entries.length < added.length && entries[0] !== undefined) {
          trimMessages(ledgerFile, sessionId, entries[0].id);
        }
      } catch (err) {
        const failure = `这几格对话没存进台账（${describe(err)}）—— 关掉就没了`;
        entries = trim(append(added, [{ kind: "notice", rows: [{ kind: "note", text: failure }] }], at), LOG_KEEP);
        setMessage(failure);
      }
      entriesRef.current.set(sessionId, entries);
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== sessionId) return one;
          const height = flatten(entries, viewport.width).height;
          const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          const top = one.bucket.follow ? bottom : clampTop(height, viewport.rows, one.bucket.top);
          return { ...one, bucket: { entries, top, follow: one.bucket.follow } };
        }),
      );
    },
    [ledgerFile, viewportRef, setSessions, setMessage],
  );

  const sayIn = useCallback(
    (sessionId: string | null, text: string): void => {
      setMessage(text);
      if (sessionId === null) return;
      push(sessionId, [{ kind: "notice", rows: [{ kind: "note", text }] }], Date.now());
    },
    [push, setMessage],
  );

  const say = useCallback(
    (text: string): void => {
      setMessage(text);
      if (activeId === null) return;
      push(activeId, [{ kind: "notice", rows: [{ kind: "note", text }] }], Date.now());
    },
    [push, activeId, setMessage],
  );

  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_TTL_MS);
    return () => clearTimeout(timer);
  }, [message, setMessage]);

  const scrollBy = useCallback(
    (delta: number): void => {
      const viewport = viewportRef.current;
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const height = flatten(one.bucket.entries, viewport.width).height;
          const top = clampTop(height, viewport.rows, one.bucket.top + delta);
          const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          return { ...one, bucket: { ...one.bucket, top, follow: top >= bottom } };
        }),
      );
    },
    [activeId, viewportRef, setSessions],
  );

  const scrollTo = useCallback(
    (where: "top" | "bottom"): void => {
      const viewport = viewportRef.current;
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const height = flatten(one.bucket.entries, viewport.width).height;
          const top = where === "top" ? 0 : clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          return { ...one, bucket: { ...one.bucket, top, follow: where === "bottom" } };
        }),
      );
    },
    [activeId, viewportRef, setSessions],
  );

  const loadMessages = useCallback(
    (sessionId: string): void => {
      if (loadedMessagesRef.current.has(sessionId)) return;
      loadedMessagesRef.current.add(sessionId);
      let restored: readonly LogEntry[];
      try {
        restored = readMessages(ledgerFile, sessionId);
      } catch (err) {
        const failure = `这个会话的对话读不出来（${describe(err)}）—— 这一趟它显示为空`;
        setMessage(failure);
        setSessions((prev) =>
          prev.map((one) =>
            one.id === sessionId
              ? {
                  ...one,
                  bucket: {
                    ...one.bucket,
                    entries: append(one.bucket.entries, [{ kind: "notice", rows: [{ kind: "note", text: failure }] }], Date.now()),
                  },
                }
              : one,
          ),
        );
        return;
      }
      if (restored.length === 0) return;
      entriesRef.current.set(sessionId, restored);
      const viewport = viewportRef.current;
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== sessionId) return one;
          const height = flatten(restored, viewport.width).height;
          const top = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          return { ...one, bucket: { entries: restored, top, follow: true } };
        }),
      );
    },
    [ledgerFile, viewportRef, setSessions, setMessage],
  );

  useEffect(() => {
    if (activeId === null) return;
    loadMessages(activeId);
  }, [activeId, loadMessages]);

  const switchSession = useCallback(
    (id: string): void => {
      setActiveId((before) => (before === id ? before : id));
    },
    [setActiveId],
  );

  const revealSession = useCallback(
    (index: number): void => {
      const fit = Math.max(1, sessionRowsRef.current);
      setSessionsTop((before) => (index >= before && index < before + fit ? before : index));
    },
    [sessionRowsRef, setSessionsTop],
  );

  const spawnOne = useCallback((): string => {
    const store = useSessionsStore.getState();
    const at = store.sessions.length;
    const seq = store.sessionSeq + 1;
    setSessionSeq(seq);
    const id = `s${String(seq)}`;
    const name = `会话 ${String(seq)}`;
    setSessions((prev) => [...prev, newSession(id, name)]);
    setActiveId(id);
    revealSession(at);
    const now = Date.now();
    try {
      saveSession(ledgerFile, { id, name, createdAt: now, updatedAt: now });
      pinSession(ledgerFile, id, now);
      setSidebarIds((before) => new Set(before).add(id));
    } catch (err) {
      const failure = `这个新会话没存进台账（${describe(err)}）—— 关掉就没了`;
      setMessage(failure);
      push(id, [{ kind: "notice", rows: [{ kind: "note", text: failure }] }], now);
    }
    return id;
  }, [ledgerFile, revealSession, setSessions, setActiveId, setSessionSeq, setSidebarIds, setMessage, push]);

  const ensureSession = useCallback((): string => {
    const store = useSessionsStore.getState();
    const found = store.sessions.find((one) => one.id === store.activeId);
    return found === undefined ? spawnOne() : found.id;
  }, [spawnOne]);

  const unpinFromSidebar = useCallback(
    (id: string): void => {
      const store = useSessionsStore.getState();
      const list = store.sessions;
      const at = list.findIndex((one) => one.id === id);
      if (at < 0) return;
      const rest = list.filter((one) => one.id !== id);
      setSessions(rest);
      try {
        unpinSession(ledgerFile, id);
        setSidebarIds((before) => {
          const next = new Set(before);
          next.delete(id);
          return next;
        });
      } catch (err) {
        say(`这个会话没从侧边栏上移掉（${describe(err)}）—— 重开一次它还在那儿`);
      }
      if (store.activeId !== id) {
        setSessionsTop((before) => Math.max(0, before - (at < before ? 1 : 0)));
        return;
      }
      const picked = rest[Math.max(0, at - 1)] ?? rest[0];
      setActiveId(picked?.id ?? null);
      if (picked !== undefined) revealSession(Math.max(0, at - 1));
    },
    [ledgerFile, say, revealSession, setSessions, setSidebarIds, setSessionsTop, setActiveId],
  );

  const resetSessionMessages = useCallback((id: string, entries: readonly LogEntry[]): void => {
    loadedMessagesRef.current.add(id);
    entriesRef.current.set(id, entries);
  }, []);

  const forgetSessionMessages = useCallback(
    (id: string): void => {
      loadedMessagesRef.current.delete(id);
      entriesRef.current.delete(id);
    },
    [],
  );

  return {
    sessions,
    activeId,
    active,
    activeInput,
    activeCursor,
    activeAnchor,
    bucket,
    historyRecords,
    push,
    sayIn,
    say,
    scrollBy,
    scrollTo,
    switchSession,
    revealSession,
    spawnOne,
    ensureSession,
    unpinFromSidebar,
    forgetSessionMessages,
    resetSessionMessages,
  };
}
