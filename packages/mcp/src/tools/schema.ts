/**
 * @fileoverview 工具形参表的两段共用件 —— `managers` 那一格 + 「有 managers 那一格」的入参表
 * @module tools/schema
 * @description
 * ## 为什么单独一个文件
 * @description 「`managers` 不给就用当前激活的环境」是**十二个操作类工具的同一条**规矩。
 * 写成十二份就有第十三种形状，而模型看到两个同名形参有两种说明时，会照着更宽松的那个填。
 *
 * ## `managers` 的 `description` 是模型能看到的**唯一**那份说明
 * @description 故它必须逐字说清三件事：不给 = 当前激活的环境 / 没有激活 = 报错 / 显式给了
 * = **只**动这几台（不是与环境并集）。第三条最容易被猜反，而猜反的代价是一次计划外的**写**。
 *
 * ## ⚠️ 形参类型**直接用** `@/protocol/types.js` 那份，本包不另定义一个
 * @description JSON Schema 是**协议契约**：客户端按它渲染界面、按它校验参数，而协议层是那个
 * 把 schema 序列化出去的地方。本包另立一份「差不多」的形状，就多了一个**可能与线上那份不一致**
 * 的副本 —— 而症状是「界面把这格显示成自由文本」而没有任何东西会红。
 */

import type { JsonSchema, JsonSchemaProperty } from "../protocol/index.js";

/** 一个形参的声明（⚠️ 直接就是协议层那一份，本包不另抄） */
export type Field = JsonSchemaProperty;

/** 工具的入参表 */
export type InputSchema = JsonSchema;

/** `managers` 那一格的声明（**十二个工具共用同一个对象引用** —— 它是常量不是构造结果） */
export const MANAGERS_FIELD: Field = {
  type: "array",
  items: { type: "string" },
  description:
    "要动哪几个 manager，每项是它的 id 或 name。**不给就用当前激活的环境**（没有激活会报错）；" +
    "给了就**只**动这几个，不与环境合并。",
};

/** 一个形参都没有的入参表（清单类工具用） */
export function noArgs(): InputSchema {
  return { type: "object", properties: {}, required: [] };
}

/**
 * 只有一个形参、且它必填的入参表
 * @description ⚠️ 名字与声明分两处传是刻意的 —— 「从形参声明对象反查它的名字」那种写法会在
 * 运行期抛，而那正是**工具表组装期**，症状是整个 server 起不来。
 */
export function oneField(name: string, field: Field): InputSchema {
  return { type: "object", properties: { [name]: field }, required: [name] };
}

/**
 * 带 `managers` 那一格的入参表
 * @param props 这个工具**自己**的形参（⚠️ 不含 `managers` —— 那是本函数加的；传进来就有两份
 * 声明，而 JSON Schema 里重复的键只有一份能生效，另一份是**静默**丢掉）
 * @param required 其中哪些必填（⚠️ `managers` 永远不在里面 —— 它缺省即「当前环境」，
 * 而 `required` 的语义是缺了就报错）
 */
export function withManagers(
  props: Readonly<Record<string, Field>>,
  required: readonly string[],
): InputSchema {
  return {
    type: "object",
    properties: { managers: MANAGERS_FIELD, ...props },
    required,
  };
}

/**
 * 工具结果 → 给模型的文本
 * @description ⚠️ **结构化输出走 JSON**，不是给人看的表格：消费面是模型，而模型要的是能自己
 * 挑字段的结构 —— 表格会逼它从一列宽的文本里再解析一次，那正是「对面的事实」退化成
 * 「模型转述的近似」的地方。
 */
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
