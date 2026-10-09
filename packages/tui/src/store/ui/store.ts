import { create } from "zustand";
import type { SetStateAction } from "react";

function resolve<T>(next: SetStateAction<T>, prev: T): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

interface UiState {
  readonly message: string | null;
  readonly inputHistory: readonly string[];
  readonly hoveredId: string | null;
  readonly sessionCloseHot: boolean;
  readonly handleHot: boolean;
  readonly sidebarWidth: number;
  readonly viewport: { readonly width: number; readonly rows: number };
  setMessage: (next: SetStateAction<string | null>) => void;
  setInputHistory: (next: SetStateAction<readonly string[]>) => void;
  setHoveredId: (next: SetStateAction<string | null>) => void;
  setSessionCloseHot: (next: SetStateAction<boolean>) => void;
  setHandleHot: (next: SetStateAction<boolean>) => void;
  setSidebarWidth: (next: SetStateAction<number>) => void;
  setViewport: (viewport: { readonly width: number; readonly rows: number }) => void;
  reset: () => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  message: null,
  inputHistory: [],
  hoveredId: null,
  sessionCloseHot: false,
  handleHot: false,
  sidebarWidth: 32,
  viewport: { width: 0, rows: 0 },
  setMessage: (next) => set({ message: resolve(next, get().message) }),
  setInputHistory: (next) => set({ inputHistory: resolve(next, get().inputHistory) }),
  setHoveredId: (next) => set({ hoveredId: resolve(next, get().hoveredId) }),
  setSessionCloseHot: (next) => set({ sessionCloseHot: resolve(next, get().sessionCloseHot) }),
  setHandleHot: (next) => set({ handleHot: resolve(next, get().handleHot) }),
  setSidebarWidth: (next) => set({ sidebarWidth: resolve(next, get().sidebarWidth) }),
  setViewport: (viewport) => set({ viewport }),
  reset: () =>
    set({
      message: null,
      inputHistory: [],
      hoveredId: null,
      sessionCloseHot: false,
      handleHot: false,
      sidebarWidth: 32,
      viewport: { width: 0, rows: 0 },
    }),
}));
