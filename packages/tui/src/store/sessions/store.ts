import { create } from "zustand";
import type { SetStateAction } from "react";
import { SEED_SESSION, newSession, type Session, type SessionRecord } from "../app-store.js";

function resolve<T>(next: SetStateAction<T>, prev: T): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

interface SessionsState {
  readonly sessions: readonly Session[];
  readonly activeId: string | null;
  readonly historyRecords: readonly SessionRecord[];
  readonly sidebarIds: ReadonlySet<string>;
  readonly sessionsTop: number;
  readonly sessionSeq: number;
  setSessions: (next: SetStateAction<readonly Session[]>) => void;
  patchSession: (id: string, patch: Partial<Session>) => void;
  setActiveId: (next: SetStateAction<string | null>) => void;
  setHistoryRecords: (next: SetStateAction<readonly SessionRecord[]>) => void;
  setSidebarIds: (next: SetStateAction<ReadonlySet<string>>) => void;
  setSessionsTop: (next: SetStateAction<number>) => void;
  setSessionSeq: (next: SetStateAction<number>) => void;
  reset: () => void;
}

const initialSessions = (): readonly Session[] => [newSession(SEED_SESSION.id, SEED_SESSION.name)];

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  sessions: initialSessions(),
  activeId: SEED_SESSION.id,
  historyRecords: [],
  sidebarIds: new Set<string>(),
  sessionsTop: 0,
  sessionSeq: 1,
  setSessions: (next) => set({ sessions: resolve(next, get().sessions) }),
  patchSession: (id, patch) =>
    set((s) => ({ sessions: s.sessions.map((one) => (one.id === id ? { ...one, ...patch } : one)) })),
  setActiveId: (next) => set({ activeId: resolve(next, get().activeId) }),
  setHistoryRecords: (next) => set({ historyRecords: resolve(next, get().historyRecords) }),
  setSidebarIds: (next) => set({ sidebarIds: resolve(next, get().sidebarIds) }),
  setSessionsTop: (next) => set({ sessionsTop: resolve(next, get().sessionsTop) }),
  setSessionSeq: (next) => set({ sessionSeq: resolve(next, get().sessionSeq) }),
  reset: () =>
    set({
      sessions: initialSessions(),
      activeId: SEED_SESSION.id,
      historyRecords: [],
      sidebarIds: new Set<string>(),
      sessionsTop: 0,
      sessionSeq: 1,
    }),
}));
