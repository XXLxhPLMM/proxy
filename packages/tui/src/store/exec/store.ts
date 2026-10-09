import { create } from "zustand";
import type { SetStateAction } from "react";
import type { Job } from "../app-store.js";

function resolve<T>(next: SetStateAction<T>, prev: T): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

interface ExecState {
  readonly queue: readonly Job[];
  readonly busy: boolean;
  readonly running: string | null;
  readonly chatting: boolean;
  enqueue: (job: Job) => void;
  dequeue: () => void;
  clearQueue: () => void;
  setBusy: (busy: SetStateAction<boolean>) => void;
  setRunning: (running: SetStateAction<string | null>) => void;
  setChatting: (chatting: SetStateAction<boolean>) => void;
  reset: () => void;
}

export const useExecStore = create<ExecState>()((set, get) => ({
  queue: [],
  busy: false,
  running: null,
  chatting: false,
  enqueue: (job) => set((s) => ({ queue: [...s.queue, job] })),
  dequeue: () => set((s) => ({ queue: s.queue.slice(1) })),
  clearQueue: () => set({ queue: [] }),
  setBusy: (busy) => set({ busy: resolve(busy, get().busy) }),
  setRunning: (running) => set({ running: resolve(running, get().running) }),
  setChatting: (chatting) => set({ chatting: resolve(chatting, get().chatting) }),
  reset: () => set({ queue: [], busy: false, running: null, chatting: false }),
}));
