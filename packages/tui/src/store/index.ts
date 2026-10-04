/** `@/store` 的唯一出口：跨帧状态的形状与常量（barrel，只转发；零 Ink、零 React、零 IO） */
export {
  EMPTY_PROVIDER,
  FALLBACK_ROWS,
  LOG_KEEP,
  MESSAGE_TTL_MS,
  MODEL_TIMEOUT_MS,
  SCROLL_STEP,
  emptyBucket,
  newSession,
  restoredSessions,
  sessionOf,
  sessionSeqOf,
  visibleSessions,
} from "./app-store.js";
export type {
  Bucket,
  CaretActive,
  EditActive,
  FillActive,
  InputPatch,
  Job,
  RunState,
  Session,
  SessionRecord,
  WindowKind,
} from "./app-store.js";