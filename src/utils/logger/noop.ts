/**
 * @fileoverview 零副作用日志实现（库默认）
 * @module utils/logger/noop
 * @description
 * 第三方库接入本项目时的默认 logger：四方法全空、`flush` 立即 resolve。
 * 零副作用——不读 config、不创建文件/目录/定时器/进程监听，也不写 stdout/stderr。
 *
 * 职责：
 * - 提供「满足 `Logger` 端口但什么都不做」的实现（`createNoopLogger`）
 *
 * 不负责：
 * - 不做任何门控与渲染；需要输出时由调用方显式注入 `createConsoleLogger` 或 `createLogger`
 */

import type { Logger } from "./port.js";

/** 零副作用日志：库默认用，什么都不做、什么都不落盘、不读 config。 */
export function createNoopLogger(): Logger {
  return {
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    flush(): Promise<void> {
      return Promise.resolve();
    },
  };
}
