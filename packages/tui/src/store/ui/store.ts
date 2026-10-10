import { create } from "zustand";
import type { SetStateAction } from "react";

function resolve<T>(next: SetStateAction<T>, prev: T): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

interface UiState {
  readonly message: string | null;
  readonly inputHistory: readonly string[];
  readonly sidebarWidth: number;
  readonly viewport: { readonly width: number; readonly rows: number };
  setMessage: (next: SetStateAction<string | null>) => void;
  setInputHistory: (next: SetStateAction<readonly string[]>) => void;
  setSidebarWidth: (next: SetStateAction<number>) => void;
  setViewport: (viewport: { readonly width: number; readonly rows: number }) => void;
  reset: () => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  message: null,
  inputHistory: [],
  sidebarWidth: 32,
  viewport: { width: 0, rows: 0 },
  setMessage: (next) => set({ message: resolve(next, get().message) }),
  setInputHistory: (next) => set({ inputHistory: resolve(next, get().inputHistory) }),
  setSidebarWidth: (next) => set({ sidebarWidth: resolve(next, get().sidebarWidth) }),
  setViewport: (viewport) => set({ viewport }),
  reset: () =>
    set({
      message: null,
      inputHistory: [],
      sidebarWidth: 32,
      viewport: { width: 0, rows: 0 },
    }),
}));
