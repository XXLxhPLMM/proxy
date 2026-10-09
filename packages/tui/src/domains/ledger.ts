import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AccountBody } from "@/api/index.js";
import {
  LedgerError,
  probeTarget,
  readLedger,
  readProviders,
  targetOf,
  type Ledger,
  type ModelRecord,
  type ProviderRecord,
  type Target,
} from "@/services/config/index.js";
import { useLedgerStore, useSessionsStore } from "@/store/index.js";
import type { ProbeSlot } from "@/ui/theme/index.js";

export interface LedgerApi {
  readonly ledger: Ledger | null;
  readonly ledgerError: LedgerError | null;
  readonly targets: readonly Target[];
  readonly current: Target | null;
  readonly probes: ReadonlyMap<string, ProbeSlot>;
  readonly providers: readonly ProviderRecord[];
  readonly providerModels: readonly ModelRecord[];
  readonly modelTick: number;
  readonly accounts: readonly AccountBody[];
  readonly accountsNote: string | null;
  readonly reprobe: (id: string) => void;
  readonly refreshProviders: () => void;
  readonly bumpModels: () => void;
  readonly bumpLedgerTick: () => void;
}

export function useLedgerDomain(deps: { readonly ledgerFile: string }): LedgerApi {
  const { ledgerFile } = deps;
  const ledger = useLedgerStore((s) => s.ledger);
  const ledgerError = useLedgerStore((s) => s.ledgerError);
  const ledgerTick = useLedgerStore((s) => s.ledgerTick);
  const probes = useLedgerStore((s) => s.probes);
  const providers = useLedgerStore((s) => s.providers);
  const providerModels = useLedgerStore((s) => s.providerModels);
  const modelTick = useLedgerStore((s) => s.modelTick);
  const accounts = useLedgerStore((s) => s.accounts);
  const accountsNote = useLedgerStore((s) => s.accountsNote);
  const setLedger = useLedgerStore((s) => s.setLedger);
  const setLedgerError = useLedgerStore((s) => s.setLedgerError);
  const setProviders = useLedgerStore((s) => s.setProviders);
  const setProbes = useLedgerStore((s) => s.setProbes);
  const bumpModelTick = useLedgerStore((s) => s.bumpModelTick);
  const bumpLedgerTick = useLedgerStore((s) => s.bumpLedgerTick);
  const probeSeq = useRef(new Map<string, number>());

  const bumpModels = useCallback((): void => {
    bumpModelTick();
  }, [bumpModelTick]);

  const refreshProviders = useCallback((): void => {
    try {
      setProviders(readProviders(ledgerFile));
    } catch {
      setProviders([]);
    }
  }, [ledgerFile, setProviders]);

  useEffect(() => {
    try {
      setLedger(readLedger(ledgerFile));
      setLedgerError(null);
    } catch (err) {
      setLedgerError(err instanceof LedgerError ? err : new LedgerError("unreadable", "台账读不出来"));
    }
    refreshProviders();
  }, [ledgerFile, ledgerTick, setLedger, setLedgerError, refreshProviders]);

  const targets: readonly Target[] = useMemo(() => ledger?.targets ?? [], [ledger]);

  const reprobe = useCallback(
    (id: string): void => {
      const target = useLedgerStore.getState().ledger?.targets.find((one) => one.id === id);
      if (target === undefined) return;
      const seq = (probeSeq.current.get(id) ?? 0) + 1;
      probeSeq.current.set(id, seq);
      const fresh = (): boolean => probeSeq.current.get(id) === seq;
      setProbes((prev) => new Map(prev).set(id, { pending: true }));
      void probeTarget(targetOf(target))
        .then((result) => {
          if (!fresh()) return;
          setProbes((prev) => new Map(prev).set(id, result));
        })
        .catch(() => {
          if (!fresh()) return;
          setProbes((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
        });
    },
    [setProbes],
  );

  const activeTargetId = useSessionsTargetId();
  const current: Target | null = useMemo(
    () => targets.find((one) => one.id === activeTargetId) ?? null,
    [targets, activeTargetId],
  );

  useEffect(() => {
    if (current === null) return;
    reprobe(current.id);
  }, [current?.id, reprobe]);

  return {
    ledger,
    ledgerError,
    targets,
    current,
    probes,
    providers,
    providerModels,
    modelTick,
    accounts,
    accountsNote,
    reprobe,
    refreshProviders,
    bumpModels,
    bumpLedgerTick,
  };
}

function useSessionsTargetId(): string | null {
  return useSessionsStore((s) => s.sessions.find((one) => one.id === s.activeId)?.targetId ?? null);
}
