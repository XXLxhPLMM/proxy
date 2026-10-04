/**
 * 本档各文件共用的入参与样本。
 *
 * ⚠️ 收件门槛是「**两个以上文件真用到**」，不是「看起来通用」：只被一个文件用到的东西留在那个文件里 ——
 * 搬进来就成了一份没人能单独删掉、也没人说得清谁在用的间接层。
 *
 * ⚠️ `spec()` 每次返回**全新**的对象（逐字展开缺省字段，而不是返回一份共用的缺省对象）：共用一份的话
 * 某个文件就地改了某个字段，另一个文件的缺省形状就被它一起带走，而症状是「改了 A 档却连 B 档也变了」。
 *
 * @module tests/geometry
 */

import type { GeometryInput } from "@/lib/geometry.js";

/** 一组常用事实的入参（各档只改自己关心的那几个字段） */
export function spec(over: Partial<GeometryInput> = {}): GeometryInput {
  return {
    columns: 100,
    rows: 30,
    sidebarWidth: 22,
    sessionCount: 4,
    sessionsTop: 0,
    input: "",
    paletteCount: 0,
    window: false,
    windowRows: 0,
    windowNote: false,
    menu: null,
    ...over,
  };
}

/** 折行高度各档（连同那一长串会把输入撑到折行的输入串） */
export const INPUT_SAMPLES: readonly string[] = [
  "",
  "/",
  "/status",
  "/user add charlie 1g",
  "/target add live http://10.0.0.9:18080 t0ken-with-a-long-tail 5000",
  "/user set charlie password 汉字密码也要折行所以我再打一些字让它真的折起来看看到底折成几行",
  // ⚠️ 下面两条**必须真的比一行的宽度长**：折行宽度是 `主区 − 框 2 − 提示符 2 − 插入符 1`，
  // 而 100 列的屏上那是 72 列 —— 短样本恒折不出第二行，于是「折行」那一整组都在测一行的情况。
  "/target add live http://10.0.0.9:18080 0123456789abcdef0123456789abcdef0123456789abcdef 5000",
  "/user pass charlie 汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字",
];
