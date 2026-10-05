/**
 * @fileoverview 当前激活的环境 —— **只在进程内存里**
 * @module store/session
 * @description
 * ## 为什么激活**不落盘**
 * 激活是「**这一次对话**我要动哪几台机器」的决定，而落盘会让它跨会话存活。于是明天开一个新
 * 会话、模型还没问任何东西就先打到了昨天选的那批机器上 —— 而这是一个**驱动别人机器**的
 * 工具，「上次打过哪儿」不该成为「这次打哪儿」的默认值。
 *
 * ⚠️ 代价是显式的：进程重启后激活归零，模型必须重新 `env_activate`。这比「悄悄继承上次」
 * 好，因为空激活的报错文案里就写着该调哪个工具。
 *
 * ## 全模块只有一份
 * @description 模块级变量就是那份状态，故「读」与「写」都在这里，别的模块不许自己缓存它。
 * 重复存一份的形状是：两个 `let` 各写各的，于是「激活了却读不出」而没有任何东西会红。
 */

/** ⚠️ `null` = 没激活 —— 这是本仓的通用形状，**不**给哨兵值（"none" 那种字符串能被真的叫出来） */
let active: string | null = null;

export function activeEnvName(): string | null {
  return active;
}

/** 激活一个环境名（⚠️ **不验它存在** —— 存在性由 `@/store/targets.js` 在使用时判，故激活本身零 IO） */
export function activateEnv(name: string): void {
  active = name;
}

/** 取消激活（**幂等** —— 没有激活时调它是一次成功的 no-op） */
export function deactivateEnv(): void {
  active = null;
}

/**
 * 删/改某个环境时，若它正被激活就把激活清掉
 * @description ⚠️ 放在这里是**因为顺序**：改环境的写面与激活状态必须是同一件事的两半 ——
 * 一个「环境叫 prod 但成员已经变了、激活还指着 prod」的窗口，症状是下一次工具调用打到了
 * 上一批成员，而模型看到的名字还是 prod。
 */
export function deactivateIfActive(name: string): void {
  if (active === name) {
    active = null;
  }
}
