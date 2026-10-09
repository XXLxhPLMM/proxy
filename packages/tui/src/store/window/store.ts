import { create } from "zustand";
import type { SetStateAction } from "react";
import type { WindowState } from "../app-store.js";

export interface FieldSpec {
  readonly label: string;
  readonly options?: readonly string[];
}

export interface FormState {
  readonly kind: "provider" | "target" | "user" | "password" | "label";
  readonly id: string | null;
  readonly title: string;
  readonly fields: readonly FieldSpec[];
  readonly values: readonly string[];
  readonly cursors: readonly number[];
  readonly at: number;
  readonly note: string | null;
  readonly username: string;
  readonly ref: string;
}

export interface RenameState {
  readonly id: string;
  readonly text: string;
  readonly cursor: number;
}

export interface MenuState {
  readonly sessionId: string | null;
  readonly x: number;
  readonly y: number;
}

function resolve<T>(next: SetStateAction<T>, prev: T): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

interface WindowStoreState {
  readonly modal: WindowState | null;
  readonly form: FormState | null;
  readonly behind: WindowState | null;
  readonly historyAt: number;
  readonly filterCursor: number;
  readonly modelsNote: string | null;
  readonly rename: RenameState | null;
  readonly menu: MenuState | null;
  readonly menuAt: number;
  setModal: (next: SetStateAction<WindowState | null>) => void;
  setForm: (next: SetStateAction<FormState | null>) => void;
  setBehind: (next: SetStateAction<WindowState | null>) => void;
  setHistoryAt: (at: SetStateAction<number>) => void;
  setFilterCursor: (cursor: SetStateAction<number>) => void;
  setModelsNote: (note: SetStateAction<string | null>) => void;
  setRename: (next: SetStateAction<RenameState | null>) => void;
  setMenu: (next: SetStateAction<MenuState | null>) => void;
  setMenuAt: (at: SetStateAction<number>) => void;
  closeModal: () => void;
  reset: () => void;
}

export const useWindowStore = create<WindowStoreState>()((set, get) => ({
  modal: null,
  form: null,
  behind: null,
  historyAt: 0,
  filterCursor: 0,
  modelsNote: null,
  rename: null,
  menu: null,
  menuAt: 0,
  setModal: (next) => set({ modal: resolve(next, get().modal) }),
  setForm: (next) => set({ form: resolve(next, get().form) }),
  setBehind: (next) => set({ behind: resolve(next, get().behind) }),
  setHistoryAt: (at) => set({ historyAt: resolve(at, get().historyAt) }),
  setFilterCursor: (cursor) => set({ filterCursor: resolve(cursor, get().filterCursor) }),
  setModelsNote: (note) => set({ modelsNote: resolve(note, get().modelsNote) }),
  setRename: (next) => set({ rename: resolve(next, get().rename) }),
  setMenu: (next) => set({ menu: resolve(next, get().menu) }),
  setMenuAt: (at) => set({ menuAt: resolve(at, get().menuAt) }),
  closeModal: () => set({ modal: null, form: null, behind: null, rename: null, modelsNote: null }),
  reset: () =>
    set({
      modal: null,
      form: null,
      behind: null,
      historyAt: 0,
      filterCursor: 0,
      modelsNote: null,
      rename: null,
      menu: null,
      menuAt: 0,
    }),
}));
