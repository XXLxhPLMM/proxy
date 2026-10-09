import { create } from "zustand";
import type { SetStateAction } from "react";
import type { AccountBody } from "@/api/index.js";
import type { Ledger, LedgerError, ModelRecord, ProviderRecord } from "@/services/config/index.js";
import type { ProbeSlot } from "@/ui/theme/index.js";

function resolve<T>(next: SetStateAction<T>, prev: T): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

interface LedgerState {
  readonly ledger: Ledger | null;
  readonly ledgerError: LedgerError | null;
  readonly ledgerTick: number;
  readonly providers: readonly ProviderRecord[];
  readonly providerModels: readonly ModelRecord[];
  readonly modelTick: number;
  readonly probes: ReadonlyMap<string, ProbeSlot>;
  readonly accounts: readonly AccountBody[];
  readonly accountsNote: string | null;
  setLedger: (next: SetStateAction<Ledger | null>) => void;
  setLedgerError: (err: SetStateAction<LedgerError | null>) => void;
  bumpLedgerTick: () => void;
  setProviders: (next: SetStateAction<readonly ProviderRecord[]>) => void;
  setProviderModels: (next: SetStateAction<readonly ModelRecord[]>) => void;
  bumpModelTick: () => void;
  setProbes: (next: SetStateAction<ReadonlyMap<string, ProbeSlot>>) => void;
  setAccounts: (next: SetStateAction<readonly AccountBody[]>) => void;
  setAccountsNote: (note: SetStateAction<string | null>) => void;
  reset: () => void;
}

export const useLedgerStore = create<LedgerState>()((set, get) => ({
  ledger: null,
  ledgerError: null,
  ledgerTick: 0,
  providers: [],
  providerModels: [],
  modelTick: 0,
  probes: new Map<string, ProbeSlot>(),
  accounts: [],
  accountsNote: null,
  setLedger: (next) => set({ ledger: resolve(next, get().ledger) }),
  setLedgerError: (err) => set({ ledgerError: resolve(err, get().ledgerError) }),
  bumpLedgerTick: () => set((s) => ({ ledgerTick: s.ledgerTick + 1 })),
  setProviders: (next) => set({ providers: resolve(next, get().providers) }),
  setProviderModels: (next) => set({ providerModels: resolve(next, get().providerModels) }),
  bumpModelTick: () => set((s) => ({ modelTick: s.modelTick + 1 })),
  setProbes: (next) => set({ probes: resolve(next, get().probes) }),
  setAccounts: (next) => set({ accounts: resolve(next, get().accounts) }),
  setAccountsNote: (note) => set({ accountsNote: resolve(note, get().accountsNote) }),
  reset: () =>
    set({
      ledger: null,
      ledgerError: null,
      ledgerTick: 0,
      providers: [],
      providerModels: [],
      modelTick: 0,
      probes: new Map<string, ProbeSlot>(),
      accounts: [],
      accountsNote: null,
    }),
}));
