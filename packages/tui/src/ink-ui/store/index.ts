/**
 * @fileoverview Ink UI 的全局状态（Zustand）：存放 Cordis 根上下文 `ctx`
 * @module ink-ui/store
 * @description
 * 供 `App` 与所有子组件订阅、读取控制面拨号与业务服务（`ctx.services.*`、`ctx.cfg` 等）。
 * `ui` 插件挂载时注入 `ctx`、卸载时清空；组件用 `useStore((s) => s.ctx)` 订阅，
 * 取不到则为 `null`（UI 处于初始化过渡态，此时只渲染占位）。
 */

import type { Context } from "cordis";
import { create } from "zustand";

interface StoreState {
  /** Cordis 根上下文：插件树卸载时置 `null` */
  ctx: Context | null;
  setCtx: (ctx: Context) => void;
  clearCtx: () => void;
}

export const useStore = create<StoreState>((set) => ({
  ctx: null,
  setCtx: (ctx) => set({ ctx }),
  clearCtx: () => set({ ctx: null }),
}));

export type { Context as CordisContext };
