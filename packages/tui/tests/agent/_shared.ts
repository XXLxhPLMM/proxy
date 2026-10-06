/**
 * 本目录各档共用的入参与常量。
 *
 * ⚠️ 收件门槛是「**两个以上文件真用到**」，不是「看起来通用」：只被一个档用到的东西留在那个档里 ——
 * 搬进来就成了一份没人能单独删掉、也没人说得清谁在用的间接层。
 *
 * @module tests/agent
 */

import type { ExecDeps } from "@/lib/exec/index.js";

export const SECRET_KEY = "sk-do-not-print-this-value";

/** 一份什么都不做的 `ExecDeps`（本目录只关心「模型看得见什么」，不关心执行） */
export function bareDeps(): ExecDeps {
  return {
    target: null,
    width: 80,
    line: "",
    // ⚠️ 两个注入的读面：执行层不读台账，故这里给空清单（模型挑不出能画的列表）
    accounts: () => ({ accounts: [] }),
    targetsView: () => [],
    peers: () => [],
  };
}