/**
 * @fileoverview 运行期单例的装配点（本包的「容器」）：初始化一次、处处取同一实例、退出时释放
 * @module services/container
 * @description
 * 这是容器在本包的**克制形态**：显式注册、显式生命周期，只做三件事 —— 启动 `init*`、使用 `get*`、
 * 退出 `dispose*`。⚠️ 不做反射 / 装饰器 / 自动装配 / 依赖图求解：本包的装配顺序就是组合根
 * （`cli.tsx`）里看得见的一小段代码，藏进元数据只会让「谁先初始化」变成运行时玄学。
 * 多一个进程级单例就在本文件加一组三个动词；真到了需要通用容器的那天（多个互依赖的单例），
 * 仍在这里手写注册表，不引 DI 库。
 */

import { SessionStore } from "@/services/resource/index.js";

/** 本地库单例；`null` = 还没初始化 / 已释放 */
let sessionStore: SessionStore | null = null;

/**
 * 打开本地库；组合根在启动时调一次
 * @param dbPath - 库文件路径（父目录 / 文件 / 表缺什么补什么）
 * @throws 已初始化还再调即抛：第二个实例会让同一路径的写入分叉，重复初始化是 bug 不是重试
 */
export function initSessionStore(dbPath: string): SessionStore {
  if (sessionStore !== null) {
    throw new Error("本地库已经初始化过了：先 disposeSessionStore() 再重开");
  }
  sessionStore = SessionStore.create(dbPath);
  return sessionStore;
}

/**
 * 取本地库单例
 * @throws 没初始化即抛：实例的创建是组合根的职责，调用点不许自己造库
 */
export function getSessionStore(): SessionStore {
  if (sessionStore === null) {
    throw new Error("本地库还没初始化：组合根要先 initSessionStore(dbPath)");
  }
  return sessionStore;
}

/** 释放本地库（幂等）：释放之后 `get` 即抛，再 `init` 得到全新实例 */
export function disposeSessionStore(): void {
  sessionStore?.close();
  sessionStore = null;
}
