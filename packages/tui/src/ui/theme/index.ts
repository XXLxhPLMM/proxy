/** `@/theme` 的唯一出口：语义 → 颜色的**唯一**映射面（barrel，只转发；零 IO、零 Ink、零 `process.*`） */
export {
  connectionMark,
  connectionStateOf,
  runMarkOf,
  selectionInk,
  severityColor,
  toastMark,
  toneColor,
  type ConnectionMark,
  type ConnectionState,
  type ProbeSlot,
  type RunMark,
  type SelectionInk,
  type ToastKind,
} from "./impl.js";
export { themeOf, type Theme, type ThemeOptions, type Tone } from "./palette.js";